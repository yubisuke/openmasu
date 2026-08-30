import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { sha256, type CandidateAttempt } from "@openmasu/attribution-core";
import { decryptMetaInstallReferrer, type MetaKey } from "@openmasu/meta-install-referrer";
import {
  acquirePrivacyProjectionSessionFence,
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
import {
  DEFAULT_WORKER_INBOX_BATCH_LIMIT,
  parseWorkerInboxBatchLimit,
} from "./tenant-work-coordinator.js";

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
  server_key_id: string | null;
  subject_digest: string | null;
  inbox_seq: string;
};

type LedgerHistoryRow = {
  ledger_position: string;
  record_id: string;
  tenant_id: string;
  app_id: string;
  producer: string;
  producer_version: string;
  event_id: string;
  delivery_id: string;
  event_name: string;
  schema_version: string;
  payload_sha256: string;
  occurred_at: string;
  occurred_at_source: string;
  received_at: string;
  processing_purpose_id: string | null;
  payload_lifecycle_status: "available" | "redacted" | "purged";
  logical_event_id: string | null;
  record_lifecycle: string | null;
  timeliness: string | null;
  fact_payload: Any | null;
  fraud_exclusion_id: string | null;
};

type AuxiliaryQueueFunctions = {
  readonly adServices: typeof queueAdServicesLookup;
  readonly integrity: typeof queueIntegrityVerification;
  readonly googlePlayProduct: typeof queueGooglePlayProductVerification;
};

type ProcessSdkInboxOptions = {
  readonly metaKeys?: readonly MetaKey[];
  readonly auxiliaryQueues?: Partial<AuxiliaryQueueFunctions>;
  readonly batchLimit?: number;
};

type Withdrawal = {
  processing_purpose_id: string;
  withdrawal_recognized_at: string;
  withdrawal_recognized_sequence: number;
};

type StoredWithdrawal = {
  installation_key_id: string;
  processing_purpose_id: string;
  withdrawal_recognized_at: string;
  withdrawal_recognized_sequence: string;
};

type StoredSubjectWithdrawal = {
  subject_digest: string;
  processing_purpose_id: string;
  withdrawal_recognized_at: string;
  withdrawal_recognized_sequence: string;
};

type DecodedInboxEntry = {
  row: InboxRow;
  records: Any[];
  adServicesLookups: PendingAdServicesLookup[];
  integrityVerifications: PendingIntegrityVerification[];
  googlePlayProductVerifications: PendingGooglePlayProductVerification[];
};

const WITHDRAWAL_PURPOSES = ["attribution", "analytics", "revenue_measurement"] as const;

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

type HistorySelectors = {
  recordIds: string[];
  logicalScopes: Array<{ producer: string; event_id: string }>;
  clickIds: string[];
  remoteClickRefs: string[];
  installationIds: string[];
  transactionIds: string[];
};

function historySelectors(records: readonly Any[]): HistorySelectors {
  const recordIds = new Set<string>();
  const logicalScopes = new Map<string, { producer: string; event_id: string }>();
  const clickIds = new Set<string>();
  const remoteClickRefs = new Set<string>();
  const installationIds = new Set<string>();
  const transactionIds = new Set<string>();
  const add = (set: Set<string>, value: unknown): void => {
    if (typeof value === "string" && value.length > 0) set.add(value);
  };
  for (const record of records) {
    add(recordIds, record.record_id);
    if (typeof record.producer === "string" && typeof record.event_id === "string") {
      logicalScopes.set(`${record.producer}\u0000${record.event_id}`, {
        producer: record.producer,
        event_id: record.event_id,
      });
    }
    const payload = record.payload ?? {};
    add(recordIds, payload.correction_target_record_id);
    add(clickIds, payload.click_id);
    add(remoteClickRefs, payload.remote_click_ref);
    add(remoteClickRefs, payload.import_context?.provider_click_ref);
    add(installationIds, payload.installation_id);
    add(installationIds, payload.prior_installation_id);
    add(transactionIds, payload.transaction_id);
    add(transactionIds, payload.original_transaction_id);
  }
  return {
    recordIds: [...recordIds].sort(),
    logicalScopes: [...logicalScopes.values()].sort((left, right) =>
      left.producer.localeCompare(right.producer) || left.event_id.localeCompare(right.event_id)),
    clickIds: [...clickIds].sort(),
    remoteClickRefs: [...remoteClickRefs].sort(),
    installationIds: [...installationIds].sort(),
    transactionIds: [...transactionIds].sort(),
  };
}

function ledgerHistoryPayload(row: LedgerHistoryRow): Any {
  if (row.payload_lifecycle_status !== "available" || row.record_lifecycle !== "active" || !row.fact_payload) {
    return {};
  }
  return Object.fromEntries(Object.entries(structuredClone(row.fact_payload))
    .filter(([, value]) => value !== null && value !== undefined));
}

async function relevantLedgerHistory(
  pool: Pool,
  tenantId: string,
  work: readonly DecodedInboxEntry[],
): Promise<CandidateAttempt[]> {
  const byApp = new Map<string, Any[]>();
  const retryRecordKeys = new Set<string>();
  for (const entry of work) {
    byApp.set(entry.row.app_id, [...(byApp.get(entry.row.app_id) ?? []), ...entry.records]);
    if (entry.row.status === "processed" && entry.row.reason_code === SDK_POST_PROCESSING_PENDING_REASON) {
      for (const record of entry.records) {
        retryRecordKeys.add(`${entry.row.tenant_id}\u0000${entry.row.app_id}\u0000${record.record_id}`);
      }
    }
  }
  const selected = new Map<string, CandidateAttempt>();
  for (const [appId, records] of [...byApp.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const selectors = historySelectors(records);
    const rows = await withTenant(pool, tenantId, (client) => client.query<LedgerHistoryRow>(
      `WITH history_watermark AS (
         SELECT COALESCE(max(ledger_seq), 0)::text AS ledger_position,
                COALESCE(max(ledger_seq), 0) AS ledger_seq
           FROM ledger.raw_records
          WHERE tenant_id=$1 AND app_id=$2
       ), logical_scopes AS (
         SELECT producer, event_id
           FROM jsonb_to_recordset($4::jsonb) AS scope(producer text, event_id text)
       ), candidate_records AS (
         SELECT raw.record_id
           FROM ledger.raw_records AS raw
          WHERE raw.tenant_id=$1 AND raw.app_id=$2
            AND raw.record_id=ANY($3::text[])
         UNION
         SELECT logical.record_id
           FROM ledger.logical_events AS logical
           JOIN logical_scopes AS scope
             ON scope.producer=logical.producer AND scope.event_id=logical.event_id
          WHERE logical.tenant_id=$1 AND logical.app_id=$2
         UNION
         SELECT logical.record_id
           FROM ledger.click_facts AS click
           JOIN ledger.logical_events AS logical USING (logical_event_id, tenant_id, app_id)
          WHERE click.tenant_id=$1 AND click.app_id=$2
            AND (click.click_id=ANY($5::text[]) OR click.remote_click_ref=ANY($6::text[]))
         UNION
         SELECT logical.record_id
           FROM ledger.install_facts AS install
           JOIN ledger.logical_events AS logical USING (logical_event_id, tenant_id, app_id)
          WHERE install.tenant_id=$1 AND install.app_id=$2
            AND (install.installation_id=ANY($7::text[])
              OR install.prior_installation_id=ANY($7::text[])
              OR install.click_id=ANY($5::text[]))
         UNION
         SELECT purchase.record_id
           FROM ledger.purchase_facts AS purchase
          WHERE purchase.tenant_id=$1 AND purchase.app_id=$2
            AND (purchase.installation_id=ANY($7::text[])
              OR purchase.transaction_id=ANY($8::text[])
              OR purchase.original_transaction_id=ANY($8::text[]))
         UNION
         SELECT logical.record_id
           FROM ledger.refund_facts AS refund
           JOIN ledger.logical_events AS logical USING (logical_event_id, tenant_id, app_id)
          WHERE refund.tenant_id=$1 AND refund.app_id=$2
            AND (refund.installation_id=ANY($7::text[])
              OR refund.transaction_id=ANY($8::text[])
              OR refund.original_transaction_id=ANY($8::text[])
              OR refund.correction_target_record_id=ANY($3::text[]))
       )
       SELECT watermark.ledger_position, raw.record_id, raw.tenant_id, raw.app_id,
              raw.producer, raw.producer_version, raw.event_id, raw.delivery_id,
              raw.event_name, raw.schema_version, raw.payload_sha256, raw.occurred_at,
              raw.occurred_at_source, raw.received_at, raw.processing_purpose_id,
              raw.payload_lifecycle_status, logical.logical_event_id,
              logical.record_lifecycle, logical.timeliness,
              CASE logical.event_name
                WHEN 'click' THEN jsonb_strip_nulls(jsonb_build_object(
                  'click_id', click.click_id,
                  'redirector_click_at', click.redirector_click_at,
                  'redirector_time_status', CASE WHEN click.redirector_click_at IS NULL THEN 'missing' ELSE 'available' END
                )) || click.artifact
                WHEN 'install' THEN install.artifact || jsonb_strip_nulls(jsonb_build_object(
                  'click_id', install.click_id,
                  'referrer_status', CASE WHEN install.click_id IS NULL THEN 'none' ELSE 'available' END,
                  'install_begin_at_server', install.install_begin_at_server,
                  'install_begin_at_server_status', CASE WHEN install.install_begin_at_server IS NULL THEN 'missing' ELSE 'available' END
                ))
                WHEN 'purchase' THEN purchase.artifact
                WHEN 'refund' THEN refund.artifact
                ELSE NULL
              END AS fact_payload,
              excluded.fraud_decision_id AS fraud_exclusion_id
         FROM candidate_records AS candidate
         CROSS JOIN history_watermark AS watermark
         JOIN ledger.raw_records_current AS raw
           ON raw.tenant_id=$1 AND raw.app_id=$2 AND raw.record_id=candidate.record_id
          AND raw.ledger_seq <= watermark.ledger_seq
         LEFT JOIN ledger.logical_events AS logical
           ON logical.tenant_id=raw.tenant_id AND logical.app_id=raw.app_id
          AND logical.record_id=raw.record_id
         LEFT JOIN ledger.click_facts AS click
           ON click.tenant_id=logical.tenant_id AND click.app_id=logical.app_id
          AND click.logical_event_id=logical.logical_event_id
         LEFT JOIN ledger.install_facts AS install
           ON install.tenant_id=logical.tenant_id AND install.app_id=logical.app_id
          AND install.logical_event_id=logical.logical_event_id
         LEFT JOIN ledger.purchase_facts AS purchase
           ON purchase.tenant_id=logical.tenant_id AND purchase.app_id=logical.app_id
          AND purchase.logical_event_id=logical.logical_event_id
         LEFT JOIN ledger.refund_facts AS refund
           ON refund.tenant_id=logical.tenant_id AND refund.app_id=logical.app_id
          AND refund.logical_event_id=logical.logical_event_id
         LEFT JOIN LATERAL (
           SELECT fraud.fraud_decision_id
             FROM ledger.fraud_decisions AS fraud
            WHERE fraud.tenant_id=raw.tenant_id AND fraud.app_id=raw.app_id
              AND fraud.subject_scope='record' AND fraud.subject_ref=raw.record_id
              AND fraud.action='exclude'
              AND NOT EXISTS (
                SELECT 1 FROM ledger.fraud_decisions AS newer
                 WHERE newer.tenant_id=fraud.tenant_id AND newer.app_id=fraud.app_id
                   AND newer.supersedes_fraud_decision_id=fraud.fraud_decision_id
              )
            ORDER BY fraud.evaluated_at DESC, fraud.fraud_decision_id DESC
            LIMIT 1
         ) AS excluded ON true
        ORDER BY raw.received_at, raw.record_id`,
      [tenantId, appId, selectors.recordIds, JSON.stringify(selectors.logicalScopes),
        selectors.clickIds, selectors.remoteClickRefs, selectors.installationIds,
        selectors.transactionIds],
    ));
    for (const row of rows.rows) {
      const key = `${row.tenant_id}\u0000${row.app_id}\u0000${row.record_id}`;
      // A post-processing retry deliberately re-evaluates its own already
      // persisted record so protected auxiliary material can be queued. Other
      // related ledger rows still provide bounded candidate history.
      if (retryRecordKeys.has(key)) continue;
      const payload = ledgerHistoryPayload(row);
      const semanticAvailable = row.payload_lifecycle_status === "available"
        && row.record_lifecycle === "active" && Object.keys(payload).length > 0;
      selected.set(key, {
        batch_id: `ledger:${row.record_id}`,
        server: {
          tenant_id: row.tenant_id,
          app_id: row.app_id,
          received_at: row.received_at,
          fraud_actions_enabled: process.env.OPENMASU_FRAUD_ENABLED !== "0",
          processing_purposes: [],
          withdrawals: [],
          alternative_legal_bases: [],
        },
        record: {
          record_id: row.record_id,
          tenant_id: row.tenant_id,
          app_id: row.app_id,
          producer: row.producer,
          producer_version: row.producer_version,
          event_id: row.event_id,
          delivery_id: row.delivery_id,
          event_name: row.event_name,
          schema_version: row.schema_version,
          subject_scope: ["skan_postback", "adattributionkit_postback"].includes(row.event_name)
            ? "aggregate" : "installation_level",
          occurred_at: row.occurred_at,
          occurred_at_source: row.occurred_at_source,
          received_at: row.received_at,
          processing_purpose_id: row.processing_purpose_id ?? "analytics",
          processing_sequence: 0,
          late: row.timeliness === "late",
          payload,
        },
        history_state: {
          payload_sha256: row.payload_sha256,
          semantic_available: semanticAvailable,
          ledger_position: row.ledger_position,
          ...(row.fraud_exclusion_id ? { fraud_exclusion_id: row.fraud_exclusion_id } : {}),
        },
      });
    }
  }
  return [...selected.values()];
}

async function decodeRows(
  rows: readonly InboxRow[],
  payloadStore: PayloadStore,
  metaKeys: readonly MetaKey[],
  onInvalidPending: (row: InboxRow, error: unknown) => Promise<void>,
): Promise<DecodedInboxEntry[]> {
  const decoded: DecodedInboxEntry[] = [];
  for (const row of rows) {
    try {
      decoded.push({ row, ...await recordsFor(row, payloadStore, metaKeys) });
    } catch (error) {
      await onInvalidPending(row, error);
    }
  }
  return decoded;
}

function decodedWithdrawalsFor(
  rows: readonly DecodedInboxEntry[],
  result: Map<string, Withdrawal[]> = new Map(),
): Map<string, Withdrawal[]> {
  for (const entry of rows) {
    if (!entry.row.installation_key_id) continue;
    for (const record of entry.records) {
      if (record.event_name !== "consent_changed" || !["withdrawn", "denied"].includes(record.payload?.consent_state)) continue;
      const withdrawals = WITHDRAWAL_PURPOSES.map((processing_purpose_id) => ({
        processing_purpose_id,
        withdrawal_recognized_at: entry.row.received_at,
        withdrawal_recognized_sequence: record.processing_sequence,
      }));
      result.set(entry.row.installation_key_id, withdrawals);
    }
  }
  return result;
}

async function durableWithdrawalsFor(
  pool: Pool,
  tenantId: string,
  rows: readonly DecodedInboxEntry[],
): Promise<Map<string, Withdrawal[]>> {
  const installationKeyIds = [...new Set(rows
    .map((entry) => entry.row.installation_key_id)
    .filter((value): value is string => value !== null))];
  if (installationKeyIds.length === 0) return new Map();
  const stored = await withTenant(pool, tenantId, (client) => client.query<StoredWithdrawal>(
    `SELECT installation_key_id, processing_purpose_id, withdrawal_recognized_at,
            withdrawal_recognized_sequence::text
       FROM control.installation_withdrawals
      WHERE tenant_id=$1 AND installation_key_id=ANY($2::text[])
      UNION ALL
     SELECT credential.installation_key_id,
            purpose.processing_purpose_id,
            credential.status_changed_at,
            '0'::text
       FROM control.installation_credentials_current AS credential
       CROSS JOIN (VALUES ('attribution'),('analytics'),('revenue_measurement'))
         AS purpose(processing_purpose_id)
      WHERE credential.tenant_id=$1
        AND credential.installation_key_id=ANY($2::text[])
        AND credential.status='deleted'
      ORDER BY installation_key_id, processing_purpose_id`,
    [tenantId, installationKeyIds],
  ));
  const result = new Map<string, Withdrawal[]>();
  for (const row of stored.rows) {
    const values = result.get(row.installation_key_id) ?? [];
    values.push({
      processing_purpose_id: row.processing_purpose_id,
      withdrawal_recognized_at: row.withdrawal_recognized_at,
      withdrawal_recognized_sequence: Number(row.withdrawal_recognized_sequence),
    });
    result.set(row.installation_key_id, values);
  }
  return result;
}

async function durableSubjectWithdrawalsFor(
  pool: Pool,
  tenantId: string,
  rows: readonly DecodedInboxEntry[],
): Promise<Map<string, Withdrawal[]>> {
  const serverRows = rows.filter((entry) => entry.row.server_key_id !== null);
  const digests = [...new Set(serverRows.map((entry) => entry.row.subject_digest).filter(
    (value): value is string => typeof value === "string",
  ))].sort();
  for (const entry of serverRows) {
    const installationIds = entry.records.map((record) => record.payload?.installation_id);
    const hasInstallation = installationIds.some((value) => typeof value === "string");
    if (hasInstallation && (!entry.row.subject_digest
      || installationIds.some((value) => typeof value !== "string")
      || new Set(installationIds).size !== 1)) {
      throw new Error("server_subject_digest_missing");
    }
  }
  const byDigest = new Map<string, Withdrawal[]>();
  if (digests.length === 0) return new Map();
  const result = await withTenant(pool, tenantId, (client) => client.query<StoredSubjectWithdrawal>(
    `SELECT credential.installation_id_digest AS subject_digest,
            withdrawal.processing_purpose_id,
            withdrawal.withdrawal_recognized_at,
            withdrawal.withdrawal_recognized_sequence::text
       FROM control.installation_credentials AS credential
       JOIN control.installation_withdrawals AS withdrawal
         ON withdrawal.tenant_id=credential.tenant_id AND withdrawal.app_id=credential.app_id
        AND withdrawal.installation_key_id=credential.installation_key_id
      WHERE credential.tenant_id=$1 AND credential.installation_id_digest=ANY($2::text[])
      UNION ALL
     SELECT credential.installation_id_digest,
            purpose.processing_purpose_id,
            credential.status_changed_at,
            '0'::text
       FROM control.installation_credentials_current AS credential
       CROSS JOIN (VALUES ('attribution'),('analytics'),('revenue_measurement'))
         AS purpose(processing_purpose_id)
      WHERE credential.tenant_id=$1 AND credential.installation_id_digest=ANY($2::text[])
        AND credential.status='deleted'
      UNION ALL
     SELECT request.artifact->>'deletion_subject_digest',
            purpose.processing_purpose_id,
            request.completed_at,
            '0'::text
       FROM ledger.privacy_requests AS request
       CROSS JOIN (VALUES ('attribution'),('analytics'),('revenue_measurement'))
         AS purpose(processing_purpose_id)
      WHERE request.tenant_id=$1 AND request.status='completed'
        AND request.artifact->>'deletion_scope'='installation'
        AND request.artifact->>'deletion_subject_digest'=ANY($2::text[])
      ORDER BY subject_digest, processing_purpose_id, withdrawal_recognized_at`,
    [tenantId, digests],
  ));
  for (const row of result.rows) {
    const values = byDigest.get(row.subject_digest) ?? [];
    if (!values.some((value) => value.processing_purpose_id === row.processing_purpose_id)) {
      values.push({
        processing_purpose_id: row.processing_purpose_id,
        withdrawal_recognized_at: row.withdrawal_recognized_at,
        withdrawal_recognized_sequence: Number(row.withdrawal_recognized_sequence),
      });
    }
    byDigest.set(row.subject_digest, values);
  }
  return new Map(serverRows.map((entry) => [
    entry.row.ingest_batch_id,
    entry.row.subject_digest ? byDigest.get(entry.row.subject_digest) ?? [] : [],
  ]));
}

async function assertWithdrawalProjectionReady(
  pool: Pool,
  tenantId: string,
  rows: readonly DecodedInboxEntry[],
): Promise<void> {
  const installationKeyIds = [...new Set(rows
    .map((entry) => entry.row.installation_key_id)
    .filter((value): value is string => value !== null))];
  if (installationKeyIds.length === 0) return;
  const missing = await withTenant(pool, tenantId, (client) => client.query<{ installation_key_id: string }>(
    `SELECT DISTINCT source_batch.installation_key_id
       FROM ledger.logical_events AS logical
       JOIN ledger.ingest_batch_records AS member
         ON member.tenant_id=logical.tenant_id AND member.app_id=logical.app_id
        AND member.record_id=logical.record_id
       JOIN ledger.ingest_batches_current AS source_batch
         ON source_batch.ingest_batch_id=member.ingest_batch_id
        AND source_batch.tenant_id=member.tenant_id AND source_batch.app_id=member.app_id
      WHERE logical.tenant_id=$1 AND logical.event_name='consent_changed'
        AND source_batch.status='processed'
        AND source_batch.installation_key_id=ANY($2::text[])
        AND NOT EXISTS (
          SELECT 1 FROM control.installation_withdrawal_backfill_states AS projection
           WHERE projection.tenant_id=logical.tenant_id
             AND projection.app_id=logical.app_id
             AND projection.installation_key_id=source_batch.installation_key_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM control.installation_withdrawals AS withdrawal
           WHERE withdrawal.tenant_id=logical.tenant_id
             AND withdrawal.app_id=logical.app_id
             AND withdrawal.installation_key_id=source_batch.installation_key_id
        )
      ORDER BY source_batch.installation_key_id`,
    [tenantId, installationKeyIds],
  ));
  if (missing.rowCount && missing.rowCount > 0) {
    throw new Error("withdrawal_projection_upgrade_required");
  }
}

async function markConsentProjectionComplete(
  pool: Pool,
  rows: readonly DecodedInboxEntry[],
  acceptedRecordIds: ReadonlySet<string>,
): Promise<void> {
  const completedAt = new Date().toISOString();
  for (const entry of rows) {
    if (!entry.row.installation_key_id || !entry.records.some((record) =>
      record.event_name === "consent_changed" && acceptedRecordIds.has(record.record_id))) continue;
    await withTenant(pool, entry.row.tenant_id, (client) => client.query(
      `INSERT INTO control.installation_withdrawal_backfill_states (
         installation_key_id, tenant_id, app_id, completed_at
       ) VALUES ($1,$2,$3,$4)
       ON CONFLICT (installation_key_id) DO NOTHING`,
      [entry.row.installation_key_id, entry.row.tenant_id, entry.row.app_id, completedAt],
    ).then(() => undefined));
  }
}

async function persistRecognizedWithdrawals(
  pool: Pool,
  rows: readonly DecodedInboxEntry[],
): Promise<number> {
  let inserted = 0;
  for (const entry of rows) {
    if (!entry.row.installation_key_id) continue;
    for (const record of entry.records) {
      if (record.event_name !== "consent_changed"
        || !["withdrawn", "denied"].includes(record.payload?.consent_state)) continue;
      for (const processingPurposeId of WITHDRAWAL_PURPOSES) {
        const artifact = {
          processing_purpose_id: processingPurposeId,
          withdrawal_recognized_at: entry.row.received_at,
          withdrawal_recognized_sequence: record.processing_sequence,
          source_record_id: record.record_id,
        };
        inserted += await withTenant(pool, entry.row.tenant_id, async (client) => (await client.query(
          `INSERT INTO control.installation_withdrawals (
             installation_key_id, tenant_id, app_id, processing_purpose_id,
             withdrawal_recognized_at, withdrawal_recognized_sequence, source_record_id, artifact
           )
           SELECT $1, raw.tenant_id, raw.app_id, $2, $3, $4, raw.record_id, $5::jsonb
             FROM ledger.raw_records AS raw
             JOIN ledger.logical_events AS logical
               ON logical.tenant_id=raw.tenant_id AND logical.app_id=raw.app_id
              AND logical.record_id=raw.record_id
            WHERE raw.tenant_id=$6 AND raw.app_id=$7 AND raw.record_id=$8
              AND raw.producer=$9 AND raw.event_id=$10
              AND raw.payload_sha256=$11 AND logical.event_name='consent_changed'
           ON CONFLICT (installation_key_id, processing_purpose_id) DO NOTHING`,
          [entry.row.installation_key_id, processingPurposeId, entry.row.received_at,
            record.processing_sequence, JSON.stringify(artifact), entry.row.tenant_id,
            entry.row.app_id, record.record_id, record.producer, record.event_id,
            sha256(record.payload)],
        )).rowCount ?? 0);
      }
    }
  }
  return inserted;
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
  const batchLimit = parseWorkerInboxBatchLimit(
    "OPENMASU_SDK_INBOX_BATCH_LIMIT",
    String(options.batchLimit ?? DEFAULT_WORKER_INBOX_BATCH_LIMIT),
  );
  const work = await withTenant(pool, tenantId, (client) => client.query<InboxRow>(
    `SELECT ingest_batch_id::text, tenant_id, app_id, producer, received_at,
            body_ref, body_digest, status, reason_code, installation_key_id,
            server_key_id, subject_digest, inbox_seq::text
     FROM ledger.ingest_batches_current
     WHERE tenant_id=$1
       AND (status='pending' OR (status='processed' AND reason_code=$2))
     ORDER BY received_at, inbox_seq
     LIMIT $3`,
    [tenantId, SDK_POST_PROCESSING_PENDING_REASON, batchLimit],
  ));
  if (work.rows.length === 0) return 0;
  const projectionFence = await acquirePrivacyProjectionSessionFence(
    pool,
    tenantId,
    work.rows.map((row) => ({
      entryId: row.ingest_batch_id,
      tenantId: row.tenant_id,
      appId: row.app_id,
      subjectDigest: row.subject_digest,
      receivedAt: row.received_at,
    })),
  );
  let processingError: unknown;
  try {
    const blocked = work.rows.filter((row) =>
      projectionFence.blockedEntryIds.has(row.ingest_batch_id));
    let suppressedPending = 0;
    for (const row of blocked) {
      await appendState(pool, row, "processed", "privacy_suppressed");
      if (row.status === "pending") suppressedPending += 1;
    }
    const activeRows = work.rows.filter((row) =>
      !projectionFence.blockedEntryIds.has(row.ingest_batch_id));
    if (activeRows.length === 0) return suppressedPending;
    const activeDecoded = await decodeRows(
      activeRows,
      payloadStore,
      options.metaKeys ?? [],
      async (row, error) => {
        if (row.status !== "pending") throw error;
        await appendState(
          pool,
          row,
          "failed",
          error instanceof Error ? error.message : "batch_invalid",
        );
      },
    );
    if (activeDecoded.length === 0) return suppressedPending;

    await assertWithdrawalProjectionReady(pool, tenantId, activeDecoded);
    const historical = await relevantLedgerHistory(pool, tenantId, activeDecoded);
    const pending: CandidateAttempt[] = [];
    const workRows: InboxRow[] = [];
    const newlyPendingRows: InboxRow[] = [];
    const withdrawals = decodedWithdrawalsFor(
      activeDecoded,
      await durableWithdrawalsFor(pool, tenantId, activeDecoded),
    );
    const subjectWithdrawals = await durableSubjectWithdrawalsFor(pool, tenantId, activeDecoded);
    for (const entry of activeDecoded) {
      const attempts = entry.records.map((record) => ({
        server: serverContext(entry.row, record, entry.row.installation_key_id
          ? withdrawals.get(entry.row.installation_key_id) ?? []
          : entry.row.server_key_id
            ? subjectWithdrawals.get(entry.row.ingest_batch_id) ?? []
            : []),
        record,
        batch_id: entry.row.ingest_batch_id,
      }));
      pending.push(...attempts);
      workRows.push(entry.row);
      if (entry.row.status === "pending") newlyPendingRows.push(entry.row);
    }
    if (pending.length === 0) return suppressedPending;
    const durablePostProcessing = new Set(workRows
      .filter((row) => row.status === "processed"
        && row.reason_code === SDK_POST_PROCESSING_PENDING_REASON)
      .map((row) => row.ingest_batch_id));
    try {
      const output = await ingestRuntimeBatch(pending, pool, historical);
      // Persist after the evaluator/ledger transaction. If this insert fails, the inbox row
      // remains retryable; a retry validates the already-written canonical logical event and
      // completes this projection before the batch is marked processed.
      await persistRecognizedWithdrawals(pool, activeDecoded);
      const acceptedInstallIds = new Set(output.logical_events
        .filter((logical) => logical.event_name === "install")
        .map((logical) => logical.record_id));
      const acceptedRecordIds = new Set(output.logical_events.map((logical) => logical.record_id));
      await markConsentProjectionComplete(pool, activeDecoded, acceptedRecordIds);
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
      for (const entry of activeDecoded) {
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
      return newlyPendingRows.length + suppressedPending;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "evaluation_failed";
      for (const row of newlyPendingRows) {
        if (!durablePostProcessing.has(row.ingest_batch_id)) {
          await appendState(pool, row, "failed", reason);
        }
      }
      throw error;
    }
  } catch (error) {
    processingError = error;
    throw error;
  } finally {
    try {
      await projectionFence.release();
    } catch (releaseError) {
      if (processingError) {
        throw new AggregateError(
          [processingError, releaseError],
          "SDK projection and privacy fence cleanup both failed",
        );
      }
      throw releaseError;
    }
  }
}
