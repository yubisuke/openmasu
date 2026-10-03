import type { Pool } from "pg";
import { DEFAULT_FRAUD_BUNDLE, fraudBundleHash, sha256Jcs } from "@openmasu/fraud-rules";
import { withTenant } from "@openmasu/runtime";
import { resolveActiveFraudBundleWithClient, type ActiveFraudBundleRevision } from "../fraud-bundle-runtime.js";

/** Synthetic seed/parity support; it is not reachable from a production worker entrypoint. */
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
