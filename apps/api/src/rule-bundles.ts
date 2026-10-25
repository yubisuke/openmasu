import type { Pool } from "pg";
import { fraudBundleHash, sha256Jcs, type FraudBundle } from "@openmasu/fraud-rules";
import { NON_FRAUD_RULE_BUNDLES, validateNonFraudBundleDefinition } from "@openmasu/contracts/definitions";
import { uuidV7 } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import { recordDashboardAuditWithClient } from "./session.js";
import { FraudPreviewError,parseFraudPreviewRequest,fraudPreviewWithClient,withFraudSnapshot } from "./fraud-preview.js";

type Any = Record<string, unknown>;

export type RuleBundleRevision = {
  readonly rule_bundle_revision_id: string;
  readonly rule_bundle_id: string;
  readonly rule_bundle_version: string;
  readonly rule_bundle_hash: string;
  readonly definition_digest?: string;
  readonly supersedes_rule_bundle_revision_id?: string;
  readonly activated_at: string;
  readonly preview_receipt?: string;
  readonly preview_evidence_digest?: string;
  readonly preview_watermark_at_most?: string;
};

function validateBody(body: Any): {
  ruleBundleId: string;
  ruleBundleVersion: string;
  ruleBundleHash: string;
  definition?: Any;
  definitionDigest?: string;
  supersedes?: string;
} {
  const allowed = new Set([
    "rule_bundle_id", "rule_bundle_version", "rule_bundle_hash", "definition", "definition_digest",
    "supersedes_rule_bundle_revision_id",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new Error("rule_bundle_field_forbidden");
  const ruleBundleId = String(body.rule_bundle_id ?? "");
  const ruleBundleVersion = String(body.rule_bundle_version ?? "");
  const definition = body.definition as Any | undefined;
  const suppliedHash = body.rule_bundle_hash === undefined ? undefined : String(body.rule_bundle_hash);
  const suppliedDefinitionDigest = body.definition_digest === undefined ? undefined : String(body.definition_digest);
  const supersedes = body.supersedes_rule_bundle_revision_id === undefined
    ? undefined
    : String(body.supersedes_rule_bundle_revision_id);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ruleBundleId)) throw new Error("rule_bundle_id_invalid");
  if (ruleBundleVersion.length < 1 || ruleBundleVersion.length > 128) throw new Error("rule_bundle_version_invalid");
  const knownNonFraud = Object.prototype.hasOwnProperty.call(NON_FRAUD_RULE_BUNDLES, ruleBundleId);
  if (definition === undefined && (ruleBundleId.startsWith("fraud-") || knownNonFraud)) {
    throw new Error("rule_bundle_definition_required");
  }
  if (definition !== undefined && ruleBundleId.startsWith("fraud-")) fraudBundleHash(definition as FraudBundle);
  else if (definition !== undefined && knownNonFraud) validateNonFraudBundleDefinition(definition);
  const computedHash = definition === undefined ? undefined : ruleBundleId.startsWith("fraud-")
    ? fraudBundleHash(definition as FraudBundle) : sha256Jcs(definition);
  const computedDefinitionDigest = definition === undefined ? undefined : sha256Jcs(definition);
  if (definition && (definition.id !== ruleBundleId || definition.version !== ruleBundleVersion)) {
    throw new Error("rule_bundle_definition_identity_mismatch");
  }
  if (suppliedHash !== undefined && !/^[a-f0-9]{64}$/.test(suppliedHash)) throw new Error("rule_bundle_hash_invalid");
  if (suppliedDefinitionDigest !== undefined && !/^[a-f0-9]{64}$/.test(suppliedDefinitionDigest)) {
    throw new Error("rule_bundle_definition_digest_invalid");
  }
  if (computedHash && suppliedHash && suppliedHash !== computedHash) throw new Error("rule_bundle_hash_mismatch");
  if (computedDefinitionDigest && suppliedDefinitionDigest && suppliedDefinitionDigest !== computedDefinitionDigest) {
    throw new Error("rule_bundle_definition_digest_mismatch");
  }
  const ruleBundleHash = computedHash ?? suppliedHash ?? "";
  if (!/^[a-f0-9]{64}$/.test(ruleBundleHash)) throw new Error("rule_bundle_hash_invalid");
  if (supersedes !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(supersedes)) {
    throw new Error("supersedes_rule_bundle_revision_id_invalid");
  }
  return {
    ruleBundleId,
    ruleBundleVersion,
    ruleBundleHash,
    ...(definition ? { definition, definitionDigest: computedDefinitionDigest } : {}),
    ...(supersedes ? { supersedes } : {}),
  };
}

export async function activateRuleBundle(input: {
  readonly pool: Pool;
  readonly identity: AppAdminIdentity;
  readonly body: Any;
  readonly now?: Date;
  /** Public operator replacement routes require the reviewed evidence receipt. */
  readonly requirePreview?: boolean;
}): Promise<RuleBundleRevision> {
  const {preview:proof,...body}=input.body;
  const value = validateBody(body);
  if (proof !== undefined && !value.ruleBundleId.startsWith("fraud-")) throw new FraudPreviewError("fraud_preview_only");
  const now = input.now ?? new Date();
  const activatedAt = now.toISOString();
  const revisionId = `rule-bundle:${uuidV7(now.getTime())}`;
  let artifact: RuleBundleRevision = {
    rule_bundle_revision_id: revisionId,
    rule_bundle_id: value.ruleBundleId,
    rule_bundle_version: value.ruleBundleVersion,
    rule_bundle_hash: value.ruleBundleHash,
    ...(value.definitionDigest ? { definition_digest: value.definitionDigest } : {}),
    ...(value.supersedes ? { supersedes_rule_bundle_revision_id: value.supersedes } : {}),
    activated_at: activatedAt,
  };
  await withFraudSnapshot(input.pool,input.identity,false,async (client) => {
    const current = await client.query<{ rule_bundle_revision_id: string }>(
      `SELECT rule_bundle_revision_id
         FROM control.rule_bundles_current
        WHERE tenant_id=$1 AND app_id=$2 AND rule_bundle_id=$3
        ORDER BY activated_at DESC, rule_bundle_revision_id DESC
        LIMIT 1`,
      [input.identity.tenantId, input.identity.appId, value.ruleBundleId],
    );
    const currentId = current.rows[0]?.rule_bundle_revision_id;
    if ((currentId ?? undefined) !== value.supersedes) throw new Error("rule_bundle_predecessor_mismatch");
    if (input.requirePreview && value.ruleBundleId.startsWith("fraud-") && !currentId) {
      const other=await client.query(`SELECT 1 FROM control.rule_bundles_current WHERE tenant_id=$1 AND app_id=$2 AND rule_bundle_id LIKE 'fraud-%'`,[input.identity.tenantId,input.identity.appId]);
      if (other.rowCount) throw new FraudPreviewError("fraud_preview_baseline_mismatch");
    }
    if (currentId && value.ruleBundleId.startsWith("fraud-") && (input.requirePreview || proof !== undefined)) {
      if (!proof || typeof proof !== "object" || Array.isArray(proof)) throw new FraudPreviewError("fraud_preview_required");
      const evidence=proof as Any;
      if (Object.keys(evidence).some(key=>!["receipt","watermark_at_most","baseline_revision_id"].includes(key))
        || typeof evidence.receipt !== "string" || !/^[a-f0-9]{64}$/.test(evidence.receipt)) throw new FraudPreviewError("fraud_preview_receipt_invalid");
      const request=parseFraudPreviewRequest({definition:value.definition,watermark_at_most:evidence.watermark_at_most,
        ...(evidence.baseline_revision_id ? {baseline_revision_id:evidence.baseline_revision_id}:{})},now);
      const result=await fraudPreviewWithClient(client,input.identity,request);
      if (!result.can_activate || result.baseline_revision_id!==currentId) throw new FraudPreviewError("fraud_preview_blocked");
      if (result.receipt!==evidence.receipt) throw new FraudPreviewError("fraud_preview_receipt_mismatch");
      artifact={...artifact,preview_receipt:result.receipt,preview_evidence_digest:result.evidence.evidence_digest,
        preview_watermark_at_most:result.watermark_at_most};
    }
    await client.query(
      `INSERT INTO control.rule_bundle_revisions (
        rule_bundle_revision_id, tenant_id, app_id, rule_bundle_id,
        rule_bundle_version, rule_bundle_hash, definition, definition_digest,
        supersedes_rule_bundle_revision_id, activated_at, actor_ref, artifact
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb)`,
      [revisionId, input.identity.tenantId, input.identity.appId, value.ruleBundleId,
        value.ruleBundleVersion, value.ruleBundleHash,
        value.definition ? JSON.stringify(value.definition) : null, value.definitionDigest ?? null,
        value.supersedes ?? null, activatedAt, `admin_key:${input.identity.keyId}`, JSON.stringify(artifact)],
    );
    await recordDashboardAuditWithClient(client, {
      tenantId: input.identity.tenantId,
      appId: input.identity.appId,
      actorRef: `admin_key:${input.identity.keyId}`,
      action: value.supersedes ? "rule_bundle_superseded" : "rule_bundle_activated",
      targetScope: "rule_bundle",
      targetRef: revisionId,
      outcome: "succeeded",
      now,
    });
  },JSON.stringify([input.identity.tenantId,input.identity.appId,value.ruleBundleId.startsWith("fraud-") ? "fraud-policy" : value.ruleBundleId]));
  return artifact;
}
