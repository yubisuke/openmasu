import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { sha256, type CandidateAttempt } from "@openmasu/attribution-core";
import { decryptMetaInstallReferrer, type MetaKey } from "@openmasu/meta-install-referrer";
import {
  SDK_POST_PROCESSING_PENDING_REASON,
  withTenant,
  type PayloadStore,
} from "@openmasu/runtime";
import { queueAdServicesLookup, type PendingAdServicesLookup } from "./adservices-worker.js";
import { queueIntegrityVerification, type PendingIntegrityVerification } from "./integrity-verifier.js";
import {
  queueGooglePlayProductVerification,
  type PendingGooglePlayProductVerification,
} from "./google-play-product-verifier.js";
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
  reason_code: string | null;
  installation_key_id: string | null;
  inbox_seq: string;
};

type AuxiliaryQueueFunctions = {
  readonly adServices: typeof queueAdServicesLookup;
  readonly integrity: typeof queueIntegrityVerification;
  readonly googlePlayProduct: typeof queueGooglePlayProductVerification;
};

type ProcessSdkInboxOptions = {
  readonly metaKeys?: readonly MetaKey[];
  readonly auxiliaryQueues?: Partial<AuxiliaryQueueFunctions>;
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
    fraud_enabled: process.env.OPENMASU_FRAUD_ENABLED !== "0",
    fraud_actions_enabled: process.env.OPENMASU_FRAUD_ENABLED !== "0"
      && process.env.OPENMASU_FRAUD_ACTIONS_ENABLED === "1",
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

function prepareIntegrityRecord(
  row: InboxRow,
  sourceRecord: Any,
): { readonly record: Any; readonly verification?: PendingIntegrityVerification } {
  const record = structuredClone(sourceRecord);
  const extensions = record.payload?.extensions;
  const token = extensions?.integrity_token_protected;
  if (token === undefined) return { record };
  const expectedProvider = row.producer === "sdk-ios" ? "app_attest" : "play_integrity";
  const provider = extensions.integrity_provider;
  const binding = extensions.integrity_binding;
  const expectedMode = record.event_name === "install" ? "challenge" : "request_hash";
  if (provider !== expectedProvider || extensions.integrity_binding_mode !== expectedMode
    || typeof token !== "string" || token.length < 1 || typeof binding !== "string") {
    throw new Error("integrity_token_scope_invalid");
  }
  const sanitizedExtensions = { ...extensions };
  delete sanitizedExtensions.integrity_token_protected;
  delete sanitizedExtensions.integrity_binding;
  delete sanitizedExtensions.integrity_binding_mode;
  delete sanitizedExtensions.integrity_provider;
  sanitizedExtensions.integrity_token_evidence_ref = row.body_ref;
  record.payload.extensions = sanitizedExtensions;
  return {
    record,
    verification: {
      tenantId: row.tenant_id,
      appId: row.app_id,
      subjectRecordId: record.record_id,
      provider,
      tokenRef: row.body_ref,
      bindingDigest: expectedMode === "request_hash"
        ? binding
        : createHash("sha256").update(binding, "utf8").digest("hex"),
      requestedAt: row.received_at,
    },
  };
}

function prepareGooglePlayProductRecord(
  row: InboxRow,
  sourceRecord: Any,
): { readonly record: Any; readonly verification?: PendingGooglePlayProductVerification } {
  const record = structuredClone(sourceRecord);
  const extensions = record.payload?.extensions;
  const token = extensions?.google_play_purchase_token_protected;
  const productId = extensions?.google_play_product_id_protected;
  const purchaseKindValue = extensions?.google_play_purchase_kind;
  const purchaseKind = purchaseKindValue ?? "one_time_product";
  if (token === undefined && productId === undefined && purchaseKindValue === undefined) return { record };
  if (row.producer !== "sdk-android" || record.event_name !== "purchase"
    || record.payload?.financial_status !== "pending" || typeof record.payload?.installation_id !== "string"
    || typeof token !== "string" || token.length < 1 || Buffer.byteLength(token, "utf8") > 64 * 1024
    || typeof productId !== "string" || productId.length < 1 || productId.length > 255
    || !["one_time_product", "subscription_initial"].includes(purchaseKind)) {
    throw new Error("google_play_product_verification_scope_invalid");
  }
  const sanitizedExtensions = { ...extensions };
  delete sanitizedExtensions.google_play_purchase_token_protected;
  delete sanitizedExtensions.google_play_product_id_protected;
  delete sanitizedExtensions.google_play_purchase_kind;
  sanitizedExtensions.store_verification_provider = "google_play";
  sanitizedExtensions.store_verification_state = "pending";
  sanitizedExtensions.store_verification_evidence_ref = row.body_ref;
  record.payload.extensions = sanitizedExtensions;
  return {
    record,
    verification: {
      tenantId: row.tenant_id,
      appId: row.app_id,
      subjectRecordId: record.record_id,
      tokenRef: row.body_ref,
      purchaseToken: token,
      productId,
      purchaseKind,
      requestedAt: row.received_at,
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
): Promise<{
  readonly records: Any[];
  readonly adServicesLookups: PendingAdServicesLookup[];
  readonly integrityVerifications: PendingIntegrityVerification[];
  readonly googlePlayProductVerifications: PendingGooglePlayProductVerification[];
}> {
  const body = await payloadStore.read(row.body_ref);
  if (createHash("sha256").update(body).digest("hex") !== row.body_digest) throw new Error("ingest_batch_digest_mismatch");
  const parsed = JSON.parse(body.toString("utf8")) as Any;
  if (!Array.isArray(parsed.records) || parsed.records.length < 1) throw new Error("ingest_batch_records_invalid");
  const adServicesLookups: PendingAdServicesLookup[] = [];
  const integrityVerifications: PendingIntegrityVerification[] = [];
  const googlePlayProductVerifications: PendingGooglePlayProductVerification[] = [];
  const records = parsed.records.map((sourceRecord: Any, index: number) => {
    const integrity = prepareIntegrityRecord(row, prepareMetaRecord(row, sourceRecord, metaKeys));
    const prepared = prepareAdServicesRecord(row, integrity.record);
    const googlePlay = prepareGooglePlayProductRecord(row, prepared.record);
    const record = googlePlay.record;
    if (prepared.lookup) adServicesLookups.push(prepared.lookup);
    if (integrity.verification) integrityVerifications.push(integrity.verification);
    if (googlePlay.verification) googlePlayProductVerifications.push(googlePlay.verification);
    if (record.tenant_id !== row.tenant_id || record.app_id !== row.app_id || record.producer !== row.producer) {
      throw new Error("ingest_batch_scope_mismatch");
    }
    record.processing_sequence = authoritativeSequence(row, index);
    return record;
  });
  return { records, adServicesLookups, integrityVerifications, googlePlayProductVerifications };
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
  options: ProcessSdkInboxOptions = {},
): Promise<number> {
  const rows = await withTenant(pool, tenantId, (client) => client.query<InboxRow>(
    `SELECT ingest_batch_id::text, tenant_id, app_id, producer, received_at,
            body_ref, body_digest, status, reason_code, installation_key_id, inbox_seq::text
     FROM ledger.ingest_batches_current
     WHERE tenant_id=$1 AND status IN ('pending','processed')
     ORDER BY received_at, inbox_seq`,
    [tenantId],
  ));
  const historical: CandidateAttempt[] = [];
  const pending: CandidateAttempt[] = [];
  const workRows: InboxRow[] = [];
  const newlyPendingRows: InboxRow[] = [];
  const decoded: Array<{
    row: InboxRow;
    records: Any[];
    adServicesLookups: PendingAdServicesLookup[];
    integrityVerifications: PendingIntegrityVerification[];
    googlePlayProductVerifications: PendingGooglePlayProductVerification[];
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
    if (entry.row.status === "processed"
      && entry.row.reason_code !== SDK_POST_PROCESSING_PENDING_REASON) {
      historical.push(...attempts);
    } else {
      pending.push(...attempts);
      workRows.push(entry.row);
      if (entry.row.status === "pending") newlyPendingRows.push(entry.row);
    }
  }
  if (pending.length === 0) return 0;
  const durablePostProcessing = new Set(workRows
    .filter((row) => row.status === "processed"
      && row.reason_code === SDK_POST_PROCESSING_PENDING_REASON)
    .map((row) => row.ingest_batch_id));
  try {
    const output = await ingestRuntimeBatch(pending, pool, historical);
    const acceptedInstallIds = new Set(output.logical_events
      .filter((logical) => logical.event_name === "install")
      .map((logical) => logical.record_id));
    const acceptedRecordIds = new Set(output.logical_events.map((logical) => logical.record_id));
    const recordsByBatch = new Map<string, string[]>();
    for (const attempt of pending) {
      const list = recordsByBatch.get(attempt.batch_id) ?? [];
      list.push(attempt.record.record_id);
      recordsByBatch.set(attempt.batch_id, list);
    }
    for (const row of workRows) {
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
      if (!durablePostProcessing.has(row.ingest_batch_id)) {
        await appendState(pool, row, "processed", SDK_POST_PROCESSING_PENDING_REASON);
        durablePostProcessing.add(row.ingest_batch_id);
      }
    }
    for (const attribution of output.attributions) await persistLateAttribution(pool, attribution);
    const queues: AuxiliaryQueueFunctions = {
      adServices: options.auxiliaryQueues?.adServices ?? queueAdServicesLookup,
      integrity: options.auxiliaryQueues?.integrity ?? queueIntegrityVerification,
      googlePlayProduct: options.auxiliaryQueues?.googlePlayProduct ?? queueGooglePlayProductVerification,
    };
    const workIds = new Set(workRows.map((row) => row.ingest_batch_id));
    for (const entry of decoded) {
      if (!workIds.has(entry.row.ingest_batch_id)) continue;
      for (const lookup of entry.adServicesLookups) {
        if (acceptedInstallIds.has(lookup.installRecordId)) await queues.adServices(pool, lookup);
      }
      for (const verification of entry.integrityVerifications) {
        if (acceptedRecordIds.has(verification.subjectRecordId)) {
          await queues.integrity(pool, verification);
        }
      }
      for (const verification of entry.googlePlayProductVerifications) {
        if (acceptedRecordIds.has(verification.subjectRecordId)) {
          await queues.googlePlayProduct(pool, verification);
        }
      }
      await appendState(pool, entry.row, "processed");
    }
    return newlyPendingRows.length;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "evaluation_failed";
    for (const row of newlyPendingRows) {
      if (!durablePostProcessing.has(row.ingest_batch_id)) {
        await appendState(pool, row, "failed", reason);
      }
    }
    throw error;
  }
}
