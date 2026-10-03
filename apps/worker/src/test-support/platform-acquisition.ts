import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { withTenant } from "@openmasu/runtime";
import { persistAttribution } from "../ingestion/application.js";

type Any = Record<string, any>;
/** Synthetic fixture projections stand in for stored, server-verified responses.
 * This test helper is not imported by ingestion, the worker or any HTTP route. */
export async function persistSyntheticPlatformResults(pool: Pool, input: Any): Promise<void> {
  const attempts = input.batches ? input.batches.flatMap((batch: Any) => batch.records.map((record: Any) => ({server:batch.server_context,record})))
    : input.records.map((record: Any) => ({server:input.server_context,record}));
  for (const proof of input.platform_acquisition_inputs ?? []) {
    const attribution = proof.attribution;
    if (!attempts.some(({server,record}: Any) => server.tenant_id === attribution.tenant_id && server.app_id === attribution.app_id
        && record.record_id === proof.install_record_id && record.payload.installation_id === attribution.subject_ref)) continue;
    await persistAttribution(pool, attribution);
    if (proof.source !== "apple_adservices") continue;
    const status = attribution.status === "non_organic" ? "attributed" : "not_attributed";
    const artifact = { adservices_context: { status, attribution: status === "attributed", ...proof.context } };
    await withTenant(pool, attribution.tenant_id, client => client.query(
      `INSERT INTO ledger.adservices_lookup_results
        (lookup_result_id,tenant_id,app_id,install_record_id,attribution_id,status,response_ref,response_digest,decided_at,artifact)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [randomUUID(),attribution.tenant_id,attribution.app_id,proof.install_record_id,attribution.attribution_id,
        status,proof.evidence_ref,proof.evidence_digest,attribution.decided_at,JSON.stringify(artifact)],
    ));
  }
}
