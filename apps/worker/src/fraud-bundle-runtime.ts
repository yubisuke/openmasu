import type { Pool, PoolClient } from "pg";
import {
  DEFAULT_FRAUD_BUNDLE,
  fraudBundleHash,
  sha256Jcs,
  type FraudBundle,
} from "@openmasu/fraud-rules";
import { withTenant } from "@openmasu/runtime";

export type ActiveFraudBundleRevision = {
  readonly ruleBundleRevisionId: string;
  readonly ruleBundleId: string;
  readonly ruleBundleVersion: string;
  readonly ruleBundleHash: string;
  readonly definitionDigest: string;
  readonly definition: FraudBundle;
  readonly activatedAt: string;
};

type RevisionRow = {
  rule_bundle_revision_id: string;
  rule_bundle_id: string;
  rule_bundle_version: string;
  rule_bundle_hash: string;
  definition_digest: string | null;
  definition: FraudBundle | null;
  activated_at: string;
};

function validatedRevision(row: RevisionRow): ActiveFraudBundleRevision {
  if (!row.definition || !row.definition_digest) throw new Error("fraud_rule_bundle_definition_missing");
  if (row.definition.id !== row.rule_bundle_id || row.definition.version !== row.rule_bundle_version) {
    throw new Error("fraud_rule_bundle_identity_mismatch");
  }
  const definitionDigest = sha256Jcs(row.definition);
  const bundleHash = fraudBundleHash(row.definition);
  if (definitionDigest !== row.definition_digest) throw new Error("fraud_rule_bundle_definition_digest_mismatch");
  if (bundleHash !== row.rule_bundle_hash) throw new Error("fraud_rule_bundle_hash_mismatch");
  return {
    ruleBundleRevisionId: row.rule_bundle_revision_id,
    ruleBundleId: row.rule_bundle_id,
    ruleBundleVersion: row.rule_bundle_version,
    ruleBundleHash: row.rule_bundle_hash,
    definitionDigest,
    definition: row.definition,
    activatedAt: row.activated_at,
  };
}

export async function resolveActiveFraudBundleWithClient(
  client: PoolClient,
  tenantId: string,
  appId: string,
): Promise<ActiveFraudBundleRevision | undefined> {
  const result = await client.query<RevisionRow>(
    `SELECT rule_bundle_revision_id,rule_bundle_id,rule_bundle_version,rule_bundle_hash,
            definition_digest,definition,activated_at
       FROM control.rule_bundles_current
      WHERE tenant_id=$1 AND app_id=$2 AND rule_bundle_id LIKE 'fraud-%'
      ORDER BY activated_at DESC,rule_bundle_revision_id DESC`,
    [tenantId, appId],
  );
  if (result.rows.length > 1) throw new Error("active_fraud_rule_bundle_ambiguous");
  return result.rows[0] ? validatedRevision(result.rows[0]) : undefined;
}

export async function resolveActiveFraudBundle(
  pool: Pool,
  tenantId: string,
  appId: string,
): Promise<ActiveFraudBundleRevision | undefined> {
  return withTenant(pool, tenantId, (client) => resolveActiveFraudBundleWithClient(client, tenantId, appId));
}

/** Seed/parity helper only. Production apps receive the same registered default in registerApp(). */
export async function ensureSyntheticDefaultFraudBundle(
  pool: Pool,
  tenantId: string,
  appId: string,
  activatedAt: string,
): Promise<ActiveFraudBundleRevision> {
  return withTenant(pool, tenantId, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [JSON.stringify([tenantId, appId, "fraud-bundle-default"])],
    );
    const current = await resolveActiveFraudBundleWithClient(client, tenantId, appId);
    if (current) return current;
    const definitionDigest = sha256Jcs(DEFAULT_FRAUD_BUNDLE);
    const bundleHash = fraudBundleHash(DEFAULT_FRAUD_BUNDLE);
    const revisionId = `rule-bundle:synthetic:${sha256Jcs([tenantId, appId, bundleHash]).slice(0, 32)}`;
    const artifact = {
      rule_bundle_revision_id: revisionId,
      rule_bundle_id: DEFAULT_FRAUD_BUNDLE.id,
      rule_bundle_version: DEFAULT_FRAUD_BUNDLE.version,
      rule_bundle_hash: bundleHash,
      definition_digest: definitionDigest,
      activated_at: activatedAt,
    };
    await client.query(
      `INSERT INTO control.rule_bundle_revisions (
        rule_bundle_revision_id,tenant_id,app_id,rule_bundle_id,rule_bundle_version,
        rule_bundle_hash,definition,definition_digest,activated_at,actor_ref,artifact
      ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'system:synthetic-seed',$10::jsonb)`,
      [revisionId, tenantId, appId, DEFAULT_FRAUD_BUNDLE.id, DEFAULT_FRAUD_BUNDLE.version,
        bundleHash, JSON.stringify(DEFAULT_FRAUD_BUNDLE), definitionDigest, activatedAt, JSON.stringify(artifact)],
    );
    const inserted = await resolveActiveFraudBundleWithClient(client, tenantId, appId);
    if (!inserted) throw new Error("synthetic_fraud_rule_bundle_registration_failed");
    return inserted;
  });
}

export function serverBundleContext(revision: ActiveFraudBundleRevision): Record<string, unknown> {
  return {
    rule_bundle_revision_id: revision.ruleBundleRevisionId,
    rule_bundle_id: revision.ruleBundleId,
    rule_bundle_version: revision.ruleBundleVersion,
    rule_bundle_hash: revision.ruleBundleHash,
    definition_digest: revision.definitionDigest,
    definition: revision.definition,
  };
}
