import type { Pool } from "pg";
import {
  NON_FRAUD_RULE_BUNDLES,
  nonFraudBundleHash,
  validateNonFraudBundleDefinition,
  type NonFraudRuleBundleId,
} from "@openmasu/contracts";
import { withTenant } from "@openmasu/runtime";

export type BoundNonFraudBundle = {
  readonly ruleBundleRevisionId?: string;
  readonly ruleBundleId: NonFraudRuleBundleId;
  readonly ruleBundleVersion: string;
  readonly ruleBundleHash: string;
  readonly definitionDigest: string;
};

export async function resolveNonFraudBundle(
  pool: Pool,
  tenantId: string,
  appId: string,
  ruleBundleId: NonFraudRuleBundleId,
): Promise<BoundNonFraudBundle> {
  const expected = NON_FRAUD_RULE_BUNDLES[ruleBundleId];
  const expectedHash = nonFraudBundleHash(ruleBundleId);
  const result = await withTenant(pool, tenantId, (client) => client.query<{
    rule_bundle_revision_id: string;
    rule_bundle_version: string;
    rule_bundle_hash: string;
    definition: unknown;
    definition_digest: string | null;
  }>(
    `SELECT rule_bundle_revision_id,rule_bundle_version,rule_bundle_hash,definition,definition_digest
       FROM control.rule_bundles_current
      WHERE tenant_id=$1 AND app_id=$2 AND rule_bundle_id=$3
      ORDER BY activated_at DESC,rule_bundle_revision_id DESC`,
    [tenantId, appId, ruleBundleId],
  ));
  if (result.rows.length > 1) throw new Error("active_non_fraud_rule_bundle_ambiguous");
  if (result.rows.length === 0) return {
    ruleBundleId, ruleBundleVersion: expected.version, ruleBundleHash: expectedHash,
    definitionDigest: expectedHash,
  };
  const row = result.rows[0];
  const definition = validateNonFraudBundleDefinition(row.definition);
  if (definition.id !== ruleBundleId || row.rule_bundle_version !== definition.version) {
    throw new Error("non_fraud_rule_bundle_identity_mismatch");
  }
  if (row.definition_digest !== expectedHash || row.rule_bundle_hash !== expectedHash) {
    throw new Error("non_fraud_rule_bundle_digest_mismatch");
  }
  return {
    ruleBundleRevisionId: row.rule_bundle_revision_id,
    ruleBundleId, ruleBundleVersion: row.rule_bundle_version,
    ruleBundleHash: row.rule_bundle_hash, definitionDigest: row.definition_digest,
  };
}

export function nonFraudServerContext(binding: BoundNonFraudBundle): Record<string, string> {
  return {
    rule_bundle_id: binding.ruleBundleId,
    rule_bundle_version: binding.ruleBundleVersion,
    rule_bundle_hash: binding.ruleBundleHash,
    definition_digest: binding.definitionDigest,
    ...(binding.ruleBundleRevisionId ? { rule_bundle_revision_id: binding.ruleBundleRevisionId } : {}),
  };
}

export function assertNonFraudArtifactBinding(
  artifact: Record<string, unknown>,
  binding: BoundNonFraudBundle,
): void {
  if (artifact.rule_bundle_id !== binding.ruleBundleId
    || artifact.rule_bundle_version !== binding.ruleBundleVersion
    || artifact.rule_bundle_hash !== binding.ruleBundleHash) {
    throw new Error("non_fraud_rule_bundle_artifact_mismatch");
  }
}
