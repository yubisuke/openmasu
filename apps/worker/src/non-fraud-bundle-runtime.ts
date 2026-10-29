import type { Pool } from "pg";
import { NON_FRAUD_RULE_BUNDLES, nonFraudBundleHash, validateNonFraudBundleDefinition,
  FIRST_PARTY_WINDOW_BUNDLE, validateFirstPartyWindowDefinition, firstPartyWindowHash,
  type FirstPartyWindowDefinition } from "@openmasu/contracts/definitions";
import type { NonFraudRuleBundleId } from "@openmasu/contracts/types";
import { withTenant } from "@openmasu/runtime";

export type BoundNonFraudBundle = {
  readonly ruleBundleRevisionId?: string;
  readonly ruleBundleId: NonFraudRuleBundleId | typeof FIRST_PARTY_WINDOW_BUNDLE;
  readonly ruleBundleVersion: string;
  readonly ruleBundleHash: string;
  readonly definitionDigest: string;
};

export type FirstPartyWindowRevision = BoundNonFraudBundle & {
  readonly definition: FirstPartyWindowDefinition;
  readonly activatedAt: string;
};

/** Immutable revisions, not the current view: late evidence keeps the install's
 * original receipt policy. The absent opt-in family means the historical default. */
export async function firstPartyWindowRevisions(pool: Pool, tenantId: string, appId: string): Promise<FirstPartyWindowRevision[]> {
  const result = await withTenant(pool, tenantId, client => client.query<{
    rule_bundle_revision_id: string; rule_bundle_version: string; rule_bundle_hash: string;
    definition: unknown; definition_digest: string; activated_at: string;
  }>(`SELECT rule_bundle_revision_id,rule_bundle_version,rule_bundle_hash,definition,definition_digest,activated_at
      FROM control.rule_bundle_revisions WHERE tenant_id=$1 AND app_id=$2 AND rule_bundle_id=$3
      ORDER BY activated_at DESC,rule_bundle_revision_id COLLATE "C" DESC`, [tenantId, appId, FIRST_PARTY_WINDOW_BUNDLE]));
  return result.rows.map(row => {
    const definition = validateFirstPartyWindowDefinition(row.definition), hash = firstPartyWindowHash(definition);
    if (row.rule_bundle_version !== definition.version || row.rule_bundle_hash !== hash || row.definition_digest !== hash) {
      throw new Error("attribution_window_binding_mismatch");
    }
    return { ruleBundleRevisionId: row.rule_bundle_revision_id, ruleBundleId: FIRST_PARTY_WINDOW_BUNDLE,
      ruleBundleVersion: definition.version, ruleBundleHash: hash, definitionDigest: hash,
      definition, activatedAt: row.activated_at };
  });
}

export function firstPartyWindowAtReceipt(revisions: readonly FirstPartyWindowRevision[], receivedAt: string) {
  const receipt = Date.parse(receivedAt);
  if (!Number.isFinite(receipt)) throw new Error("attribution_window_receipt_invalid");
  return [...revisions].filter(revision => Date.parse(revision.activatedAt) <= receipt)
    .sort((left, right) => Date.parse(right.activatedAt) - Date.parse(left.activatedAt)
      || (left.ruleBundleRevisionId! < right.ruleBundleRevisionId! ? 1 : -1))[0];
}

export function firstPartyWindowServerContext(binding: FirstPartyWindowRevision) {
  return { ...nonFraudServerContext(binding), definition: binding.definition };
}

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
