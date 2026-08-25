import type { Pool } from "pg";
import { fraudBundleHash, sha256Jcs, type FraudBundle } from "@openmasu/fraud-rules";
import { uuidV7, withTenant } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import { recordDashboardAuditWithClient } from "./session.js";

type Any = Record<string, unknown>;

export type RuleBundleRevision = {
  readonly rule_bundle_revision_id: string;
  readonly rule_bundle_id: string;
  readonly rule_bundle_version: string;
  readonly rule_bundle_hash: string;
  readonly definition_digest?: string;
  readonly supersedes_rule_bundle_revision_id?: string;
  readonly activated_at: string;
};

function validateBody(body: Any): {
  ruleBundleId: string;
  ruleBundleVersion: string;
  ruleBundleHash: string;
  definition?: FraudBundle;
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
  const definition = body.definition === undefined ? undefined : body.definition as FraudBundle;
  const suppliedHash = body.rule_bundle_hash === undefined ? undefined : String(body.rule_bundle_hash);
  const suppliedDefinitionDigest = body.definition_digest === undefined ? undefined : String(body.definition_digest);
  const supersedes = body.supersedes_rule_bundle_revision_id === undefined
    ? undefined
    : String(body.supersedes_rule_bundle_revision_id);
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(ruleBundleId)) throw new Error("rule_bundle_id_invalid");
  if (ruleBundleVersion.length < 1 || ruleBundleVersion.length > 128) throw new Error("rule_bundle_version_invalid");
  if (definition === undefined && ruleBundleId.startsWith("fraud-")) throw new Error("fraud_bundle_definition_required");
  const computedHash = definition === undefined ? undefined : fraudBundleHash(definition);
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
}): Promise<RuleBundleRevision> {
  const value = validateBody(input.body);
  const now = input.now ?? new Date();
  const activatedAt = now.toISOString();
  const revisionId = `rule-bundle:${uuidV7(now.getTime())}`;
  const artifact: RuleBundleRevision = {
    rule_bundle_revision_id: revisionId,
    rule_bundle_id: value.ruleBundleId,
    rule_bundle_version: value.ruleBundleVersion,
    rule_bundle_hash: value.ruleBundleHash,
    ...(value.definitionDigest ? { definition_digest: value.definitionDigest } : {}),
    ...(value.supersedes ? { supersedes_rule_bundle_revision_id: value.supersedes } : {}),
    activated_at: activatedAt,
  };
  await withTenant(input.pool, input.identity.tenantId, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [JSON.stringify([input.identity.tenantId, input.identity.appId, value.ruleBundleId])],
    );
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
  });
  return artifact;
}
