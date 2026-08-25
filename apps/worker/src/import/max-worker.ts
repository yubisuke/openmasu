import type { Pool } from "pg";
import { sha256, type CandidateAttempt } from "@openmasu/attribution-core";
import { decimalToUnscaled } from "./cost.js";
import { ingestRuntimeBatch } from "../ingestion.js";
import { uuidV7, withTenant, type PayloadStore } from "@openmasu/runtime";

type Any = Record<string, any>;

function attemptFromInbox(inbox: Any, query: URLSearchParams): CandidateAttempt {
  const userId = query.get("user_id") || undefined;
  const unixSeconds = Number(query.get("ts"));
  const occurredAt = Number.isFinite(unixSeconds) && unixSeconds > 0
    ? new Date(unixSeconds * 1000).toISOString()
    : inbox.received_at;
  const amount = decimalToUnscaled(query.get("all_revenue") ?? query.get("revenue") ?? "0", 6);
  const payload: Any = {
    subject_scope: userId ? "installation_level" : "aggregate",
    ...(userId ? { installation_id: userId, anchor_source: "server_user_ref" } : {}),
    impression_id: inbox.event_id,
    ad_unit_id: query.get("ad_unit_id") || "unknown",
    ad_network: query.get("network") || "unknown",
    country: (query.get("cc") || "ZZ").toUpperCase(),
    amount_unscaled: amount,
    amount_scale: 6,
    currency: "USD",
    currency_source: "reported",
    revenue_source: "imported_reported",
    import_context: {
      provider: "applovin-max",
      provider_attributed: false,
      provider_attribution_strategy: "unattributed",
      provider_network: query.get("network") || "unknown",
      provider_country: (query.get("cc") || "ZZ").toUpperCase(),
      provider_confirmed_at: inbox.received_at,
    },
  };
  return {
    server: {
      tenant_id: inbox.tenant_id,
      app_id: inbox.app_id,
      received_at: inbox.received_at,
      policy_digest: "max-receiver-policy-v1",
      processing_purposes: [{ processing_purpose_id: "analytics", consent_required: false, policy_version: "runtime-consent-v0.2" }],
      withdrawals: [],
      alternative_legal_bases: [],
    },
    record: {
      contract_version: "0.4.0",
      record_id: `record:max:${inbox.inbox_id}`,
      delivery_id: `delivery:max:${inbox.inbox_id}`,
      tenant_id: inbox.tenant_id,
      app_id: inbox.app_id,
      producer: "import:applovin-max",
      producer_version: "max-s2s-v1",
      event_id: inbox.event_id,
      event_name: "ad_revenue",
      schema_version: "0.4.0",
      occurred_at: occurredAt,
      occurred_at_source: "import",
      received_at: inbox.received_at,
      processing_purpose_id: "analytics",
      processing_sequence: 1,
      payload,
      raw_payload_ref: inbox.raw_query_ref,
    },
    batch_id: `batch:max:${inbox.inbox_id}`,
  };
}

export async function processMaxInbox(pool: Pool, payloadStore: PayloadStore, tenantId: string): Promise<number> {
  return withTenant(pool, tenantId, async (client) => {
    const pending = await client.query<Any>(
      `SELECT * FROM ledger.ingest_inbox_current
       WHERE tenant_id=$1 AND status='pending'
       ORDER BY received_at, inbox_id`,
      [tenantId],
    );
    let processed = 0;
    for (const inbox of pending.rows) {
      const plaintext = await payloadStore.read(inbox.raw_query_ref);
      const attempt = attemptFromInbox(inbox, new URLSearchParams(plaintext.toString("utf8")));
      const historyRows = await client.query<Any>(
        `SELECT server_context, record, import_run_id::text
         FROM control.import_attempts
         WHERE tenant_id=$1 AND app_id=$2 AND source_id='max-s2s'
         ORDER BY created_at, row_ordinal`,
        [inbox.tenant_id, inbox.app_id],
      );
      const history = historyRows.rows.map((row) => ({ server: row.server_context, record: row.record, batch_id: row.import_run_id }));
      // withTenant is re-entrant through a separate pool connection; do not pass this transaction's client.
      const output = await ingestRuntimeBatch([attempt], pool, history);
      const validationFailure = output.validation_failures[0];
      const runId = uuidV7(Date.parse(inbox.received_at));
      await client.query(
        `INSERT INTO control.import_runs (
          import_run_id, tenant_id, app_id, source_id, source_snapshot_digest,
          status, started_at, completed_at
        ) VALUES ($1,$2,$3,'max-s2s',$4,'completed',$5,$5)`,
        [runId, inbox.tenant_id, inbox.app_id, inbox.raw_query_digest, inbox.received_at],
      );
      if (validationFailure) {
        await client.query(
          `INSERT INTO control.import_row_rejections (
            import_rejection_id, import_run_id, tenant_id, app_id, source_id,
            row_ordinal, reason_code, field_names, occurred_at
          ) VALUES ($1,$2,$3,$4,'max-s2s',0,'row_schema_invalid',$5::jsonb,$6)`,
          [uuidV7(), runId, inbox.tenant_id, inbox.app_id, JSON.stringify(validationFailure.fields), inbox.received_at],
        );
        await payloadStore.purge(inbox.raw_query_ref);
      } else {
        await client.query(
          `INSERT INTO control.import_attempts (
            import_attempt_id, import_run_id, tenant_id, app_id, source_id,
            row_ordinal, server_context, record, created_at
          ) VALUES ($1,$2,$3,$4,'max-s2s',0,$5::jsonb,$6::jsonb,$7)`,
          [uuidV7(), runId, inbox.tenant_id, inbox.app_id, JSON.stringify(attempt.server), JSON.stringify(attempt.record), inbox.received_at],
        );
      }
      await client.query(
        `INSERT INTO ledger.ingest_inbox_states (
          inbox_id, tenant_id, app_id, status, changed_at, artifact
        ) VALUES ($1,$2,$3,'processed',$4,$5::jsonb)`,
        [inbox.inbox_id, inbox.tenant_id, inbox.app_id, new Date().toISOString(), JSON.stringify({ inbox_id: inbox.inbox_id, status: "processed" })],
      );
      processed += 1;
    }
    return processed;
  });
}
