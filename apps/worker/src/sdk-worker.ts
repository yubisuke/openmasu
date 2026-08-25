import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { sha256, type CandidateAttempt } from "@openmasu/attribution-core";
import { decryptMetaInstallReferrer, type MetaKey } from "@openmasu/meta-install-referrer";
import { withTenant, type PayloadStore } from "@openmasu/runtime";
import { queueAdServicesLookup, type PendingAdServicesLookup } from "./adservices-worker.js";
import { ingestRuntimeBatch } from "./ingestion.js";

type Any = Record<string, any>;
type InboxRow = {
  ingest_batch_id: string;
  tenant_id: string;
  app_id: string;
  producer: string;
  received_at: string;
  body_ref: string;
  body_digest: string;
  status: "pending" | "processed" | "failed";
  installation_key_id: string | null;
  inbox_seq: string;
};

type Withdrawal = {
  processing_purpose_id: string;
  withdrawal_recognized_at: string;
  withdrawal_recognized_sequence: number;
};

function serverContext(row: InboxRow, record: Any, withdrawals: Withdrawal[]): Any {
  const aggregatePostback = row.producer === "postback:skadnetwork"
    || row.producer === "postback:adattributionkit";
  return {
    tenant_id: row.tenant_id,
    app_id: row.app_id,
    received_at: row.received_at,
    policy_digest: "sdk-runtime-policy-v0.3",
    processing_purposes: [{
      processing_purpose_id: record.processing_purpose_id ?? "analytics",
      consent_required: !aggregatePostback && record.processing_purpose_id !== "fraud_prevention",
      policy_version: "sdk-runtime-consent-v0.3",
    }],
    withdrawals,
    alternative_legal_bases: [],
    click_injection_threshold_ms: 2_000,
  };
}

export async function listRuntimeWorkTenants(pool: Pool): Promise<readonly string[]> {
  const result = await pool.query<{ tenant_id: string }>(
    "SELECT tenant_id::text FROM control.list_m4_work_tenants() AS tenants(tenant_id)",
  );
  return result.rows.map((row) => row.tenant_id);
}

function metaSource(value: unknown): { data_hex?: string; nonce_hex?: string } | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 64 * 1024) return undefined;
  try {
    const outer = JSON.parse(value) as Any;
    const source = outer?.utm_content?.source;
    if (!source || typeof source !== "object") return undefined;
    return {
      ...(typeof source.data === "string" ? { data_hex: source.data } : {}),
      ...(typeof source.nonce === "string" ? { nonce_hex: source.nonce } : {}),
    };
  } catch {
    return undefined;
  }
}

const META_IS_CT_CLICK_THROUGH = 1; // Unverified until operator checklist V-2.

function prepareMetaRecord(row: InboxRow, sourceRecord: Any, keys: readonly MetaKey[]): Any {
  const record = structuredClone(sourceRecord);
  if (record.event_name !== "install") return record;
  const raw = record.payload?.extensions?.meta_install_referrer_protected;
  if (typeof raw !== "string") return record;
  const isCt = Number(record.payload.extensions.meta_is_ct_unverified);
  const actualTimestamp = Number(record.payload.extensions.meta_actual_timestamp_unverified);
  const result = decryptMetaInstallReferrer(metaSource(raw), keys);
  const extensions = { ...(record.payload.extensions ?? {}) };
  delete extensions.meta_install_referrer_protected;
  delete extensions.meta_is_ct_unverified;
  delete extensions.meta_actual_timestamp_unverified;
  record.payload.extensions = extensions;
  record.payload.protected_referrer_evidence_ref = `payload:${row.body_ref}`;
  if (result.status === "decrypted") {
    record.payload.meta_referrer_status = "decrypted";
    record.payload.meta_referrer_context = {
      attribution_model: isCt === META_IS_CT_CLICK_THROUGH ? "last_click" : "view_through",
      ...result.context,
    };
    if (isCt === 0 || isCt === 1) record.payload.is_ct = isCt;
    if (Number.isSafeInteger(actualTimestamp) && actualTimestamp >= 0) record.payload.actual_timestamp = actualTimestamp;
    record.payload.extensions.meta_decryption_key_id = result.key_id;
  } else if (result.status === "auth_failed") {
    record.payload.meta_referrer_status = "auth_failed";
  } else if (result.status === "absent") {
    record.payload.meta_referrer_status = "no_campaign_data";
  } else {
    record.payload.meta_referrer_status = "decrypt_failed";
  }
  return record;
}

function prepareAdServicesRecord(
  row: InboxRow,
  sourceRecord: Any,
): { readonly record: Any; readonly lookup?: PendingAdServicesLookup } {
  const record = structuredClone(sourceRecord);
  if (record.event_name !== "install") return { record };
  const extensions = record.payload?.extensions;
  const token = extensions?.adservices_attribution_token_protected;
  if (token === undefined) return { record };
  if (row.producer !== "sdk-ios" || typeof token !== "string" || token.length < 1) {
    throw new Error("adservices_token_scope_invalid");
  }
  const sanitizedExtensions = { ...extensions };
  delete sanitizedExtensions.adservices_attribution_token_protected;
  sanitizedExtensions.adservices_token_evidence_ref = row.body_ref;
  record.payload.extensions = sanitizedExtensions;
  return {
    record,
    lookup: {
      tenantId: row.tenant_id,
      appId: row.app_id,
      installRecordId: record.record_id,
      tokenRef: row.body_ref,
      tokenCreatedAt: row.received_at,
    },
  };
}

function authoritativeSequence(row: InboxRow, index: number): number {
  const sequence = Number(row.inbox_seq) * 1_000 + index;
  if (!Number.isSafeInteger(sequence)) throw new Error("sdk_processing_sequence_out_of_range");
  return sequence;
}

async function recordsFor(
  row: InboxRow,
  payloadStore: PayloadStore,
  metaKeys: readonly MetaKey[],
): Promise<{ readonly records: Any[]; readonly adServicesLookups: PendingAdServicesLookup[] }> {
  const body = await payloadStore.read(row.body_ref);
  if (createHash("sha256").update(body).digest("hex") !== row.body_digest) throw new Error("ingest_batch_digest_mismatch");
  const parsed = JSON.parse(body.toString("utf8")) as Any;
  if (!Array.isArray(parsed.records) || parsed.records.length < 1) throw new Error("ingest_batch_records_invalid");
  const adServicesLookups: PendingAdServicesLookup[] = [];
  const records = parsed.records.map((sourceRecord: Any, index: number) => {
    const prepared = prepareAdServicesRecord(row, prepareMetaRecord(row, sourceRecord, metaKeys));
    const record = prepared.record;
    if (prepared.lookup) adServicesLookups.push(prepared.lookup);
    if (record.tenant_id !== row.tenant_id || record.app_id !== row.app_id || record.producer !== row.producer) {
      throw new Error("ingest_batch_scope_mismatch");
    }
    record.processing_sequence = authoritativeSequence(row, index);
    return record;
  });
  return { records, adServicesLookups };
}

function withdrawalsFor(rows: Array<{ row: InboxRow; records: Any[] }>): Map<string, Withdrawal[]> {
  const result = new Map<string, Withdrawal[]>();
  for (const entry of rows) {
    if (!entry.row.installation_key_id) continue;
    for (const record of entry.records) {
      if (record.event_name !== "consent_changed" || !["withdrawn", "denied"].includes(record.payload?.consent_state)) continue;
      const withdrawals = ["attribution", "analytics", "revenue_measurement"].map((processing_purpose_id) => ({
        processing_purpose_id,
        withdrawal_recognized_at: entry.row.received_at,
        withdrawal_recognized_sequence: record.processing_sequence,
      }));
      result.set(entry.row.installation_key_id, withdrawals);
    }
  }
  return result;
}

async function appendState(pool: Pool, row: InboxRow, status: "processed" | "failed", reasonCode?: string): Promise<void> {
  const changedAt = new Date().toISOString();
  await withTenant(pool, row.tenant_id, (client) => client.query(
    `INSERT INTO ledger.ingest_batch_states (
      ingest_batch_id, tenant_id, app_id, status, changed_at, reason_code, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [row.ingest_batch_id, row.tenant_id, row.app_id, status, changedAt, reasonCode ?? null,
      JSON.stringify({ ingest_batch_id: row.ingest_batch_id, status, changed_at: changedAt, ...(reasonCode ? { reason_code: reasonCode } : {}) })],
  ).then(() => undefined));
}

async function persistLateAttribution(pool: Pool, attribution: Any): Promise<void> {
  await withTenant(pool, attribution.tenant_id, async (client) => {
    const previous = await client.query<{ artifact: Any }>(
      `SELECT artifact FROM ledger.attribution_results
       WHERE tenant_id=$1 AND app_id=$2 AND attribution_id=$3`,
      [attribution.tenant_id, attribution.app_id, attribution.attribution_id],
    );
    const prior = previous.rows[0]?.artifact;
    if (!prior || prior.reason_code === attribution.reason_code || attribution.reason_code !== "valid_install_referrer") return;
    const replacement: Any = {
      ...attribution,
      attribution_id: `${attribution.attribution_id}:late-${sha256(attribution.evidence_refs).slice(0, 12)}`,
      finality: "superseded",
      supersedes_attribution_id: attribution.attribution_id,
    };
    await client.query(
      `INSERT INTO ledger.attribution_results (
        attribution_id, tenant_id, app_id, subject_scope, subject_ref, effective_at,
        decided_at, status, method, model, reason_code, artifact
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
      ON CONFLICT (attribution_id) DO NOTHING`,
      [replacement.attribution_id, replacement.tenant_id, replacement.app_id,
        replacement.subject_scope, replacement.subject_ref, replacement.effective_at,
        replacement.decided_at, replacement.status, replacement.method, replacement.model,
        replacement.reason_code, JSON.stringify(replacement)],
    );
  });
}

export async function processSdkInbox(
  pool: Pool,
  payloadStore: PayloadStore,
  tenantId: string,
  options: { metaKeys?: readonly MetaKey[] } = {},
): Promise<number> {
  const rows = await withTenant(pool, tenantId, (client) => client.query<InboxRow>(
    `SELECT ingest_batch_id::text, tenant_id, app_id, producer, received_at,
            body_ref, body_digest, status, installation_key_id, inbox_seq::text
     FROM ledger.ingest_batches_current
     WHERE tenant_id=$1 AND status IN ('pending','processed')
     ORDER BY received_at, inbox_seq`,
    [tenantId],
  ));
  const historical: CandidateAttempt[] = [];
  const pending: CandidateAttempt[] = [];
  const validPendingRows: InboxRow[] = [];
  const decoded: Array<{
    row: InboxRow;
    records: Any[];
    adServicesLookups: PendingAdServicesLookup[];
  }> = [];
  for (const row of rows.rows) {
    try {
      decoded.push({ row, ...await recordsFor(row, payloadStore, options.metaKeys ?? []) });
    } catch (error) {
      if (row.status === "pending") await appendState(pool, row, "failed", error instanceof Error ? error.message : "batch_invalid");
    }
  }
  const withdrawals = withdrawalsFor(decoded);
  for (const entry of decoded) {
    const attempts = entry.records.map((record) => ({
      server: serverContext(entry.row, record, entry.row.installation_key_id ? withdrawals.get(entry.row.installation_key_id) ?? [] : []),
      record,
      batch_id: entry.row.ingest_batch_id,
    }));
    if (entry.row.status === "processed") historical.push(...attempts);
    else { pending.push(...attempts); validPendingRows.push(entry.row); }
  }
  if (pending.length === 0) return 0;
  try {
    const output = await ingestRuntimeBatch(pending, pool, historical);
    for (const attribution of output.attributions) await persistLateAttribution(pool, attribution);
    const acceptedInstallIds = new Set(output.logical_events
      .filter((logical) => logical.event_name === "install")
      .map((logical) => logical.record_id));
    for (const entry of decoded) {
      if (entry.row.status !== "pending") continue;
      for (const lookup of entry.adServicesLookups) {
        if (acceptedInstallIds.has(lookup.installRecordId)) await queueAdServicesLookup(pool, lookup);
      }
    }
    const recordsByBatch = new Map<string, string[]>();
    for (const attempt of pending) {
      const list = recordsByBatch.get(attempt.batch_id) ?? [];
      list.push(attempt.record.record_id);
      recordsByBatch.set(attempt.batch_id, list);
    }
    for (const row of validPendingRows) {
      await withTenant(pool, row.tenant_id, async (client) => {
        for (const recordId of recordsByBatch.get(row.ingest_batch_id) ?? []) {
          await client.query(
            `INSERT INTO ledger.ingest_batch_records (
              ingest_batch_id, tenant_id, app_id, record_id, created_at
            ) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [row.ingest_batch_id, row.tenant_id, row.app_id, recordId, new Date().toISOString()],
          );
        }
      });
      await appendState(pool, row, "processed");
    }
    return validPendingRows.length;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "evaluation_failed";
    for (const row of validPendingRows) await appendState(pool, row, "failed", reason);
    throw error;
  }
}
