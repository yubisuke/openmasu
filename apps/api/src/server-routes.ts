import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { appendDurableBatch, uuidV7, withTenant, type PayloadStore } from "@openmasu/runtime";
import { type KeyedTokenBucket } from "./rate-limit.js";
import { parseJsonBody, readRawBody, RequestBodyError } from "./raw-body.js";
import {
  verifyServerRequest,
  type ServerAuthConfig,
  type VerifiedServerRequest,
} from "./server-auth.js";

type Any = Record<string, any>;

const allowedEventNames = new Set([
  "session_start",
  "custom_event",
  "ad_impression",
  "ad_view",
  "ad_revenue",
  "purchase",
  "refund",
]);
const identifierPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const protectedExtensionPattern = /^(?:adservices|apple|google_play|import|integrity|meta|provider|store_verification)(?:$|_)/;

export type ServerRouteDependencies = {
  readonly pool: Pool;
  readonly payloadStore: PayloadStore;
  readonly config: ServerAuthConfig;
  readonly installationDigestKey: string;
  readonly maximumBytes: number;
  readonly maximumEvents: number;
  readonly keyBucket: KeyedTokenBucket;
  readonly appBucket: KeyedTokenBucket;
};

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

function processingPurpose(eventName: string): "analytics" | "revenue_measurement" {
  return ["purchase", "refund", "ad_revenue"].includes(eventName)
    ? "revenue_measurement"
    : "analytics";
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function authorityClaimsForbidden(payload: Any): boolean {
  if ([
    "adservices_context", "anchor_source", "import_context", "integrity_verdict",
    "meta_referrer_context", "signature", "signature_verified",
  ].some((key) => payload[key] !== undefined)) return true;
  const extensions = payload.extensions;
  return extensions !== undefined && (
    !extensions || typeof extensions !== "object" || Array.isArray(extensions)
    || Object.keys(extensions).some((key) => protectedExtensionPattern.test(key))
  );
}

function subjectDigest(
  records: readonly Any[],
  identity: VerifiedServerRequest,
  installationDigestKey: string,
): string | undefined {
  const installationIds = records.map((record) => record.payload?.installation_id);
  if (installationIds.some((value) => value !== undefined)
    && installationIds.some((value) => typeof value !== "string")) {
    throw new Error("server_batch_subject_mixed");
  }
  const present = installationIds.filter((value): value is string => typeof value === "string");
  if (present.length === 0) return undefined;
  if (present.length !== records.length || new Set(present).size !== 1) {
    throw new Error("server_batch_subject_mixed");
  }
  return createHmac("sha256", installationDigestKey)
    .update(`${identity.tenantId}\u0000${identity.appId}\u0000${present[0]}`, "utf8")
    .digest("hex");
}

async function subjectIsWithdrawn(
  dependencies: ServerRouteDependencies,
  identity: VerifiedServerRequest,
  digest: string,
  purposes: readonly string[],
): Promise<boolean> {
  const result = await withTenant(dependencies.pool, identity.tenantId, (client) => client.query(
    `SELECT 1
       FROM ledger.privacy_requests AS request
      WHERE request.tenant_id=$1 AND request.app_id=$2 AND request.status='completed'
        AND request.artifact->>'deletion_scope'='installation'
        AND request.artifact->>'deletion_subject_digest'=$3
      UNION ALL
     SELECT 1
       FROM control.installation_credentials_current AS credential
      WHERE credential.tenant_id=$1 AND credential.app_id=$2
        AND credential.installation_id_digest=$3 AND credential.status='deleted'
      UNION ALL
     SELECT 1
       FROM control.installation_credentials AS credential
       JOIN control.installation_withdrawals AS withdrawal
         ON withdrawal.tenant_id=credential.tenant_id AND withdrawal.app_id=credential.app_id
        AND withdrawal.installation_key_id=credential.installation_key_id
      WHERE credential.tenant_id=$1 AND credential.app_id=$2
        AND credential.installation_id_digest=$3
        AND withdrawal.processing_purpose_id=ANY($4::text[])
      LIMIT 1`,
    [identity.tenantId, identity.appId, digest, purposes],
  ));
  return (result.rowCount ?? 0) > 0;
}

export function normalizeServerRecord(
  source: Any,
  identity: VerifiedServerRequest,
  receivedAt: string,
): Any {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("event_record_invalid");
  if (!allowedEventNames.has(source.event_name)) throw new Error("server_event_name_forbidden");
  if (!identifierPattern.test(source.event_id)) throw new Error("event_id_invalid");
  if (typeof source.producer_version !== "string" || source.producer_version.length < 1
    || source.producer_version.length > 128) throw new Error("producer_version_invalid");
  if (!canonicalTimestamp(source.occurred_at)) throw new Error("occurred_at_invalid");
  if (!Number.isSafeInteger(source.processing_sequence) || source.processing_sequence < 0) {
    throw new Error("processing_sequence_invalid");
  }
  if (source.producer_variant !== undefined
    && (typeof source.producer_variant !== "string" || source.producer_variant.length < 1
      || source.producer_variant.length > 64)) throw new Error("producer_variant_invalid");
  if (source.wrapper_version !== undefined
    && (typeof source.wrapper_version !== "string" || source.wrapper_version.length < 1
      || source.wrapper_version.length > 128)) throw new Error("wrapper_version_invalid");
  const payload = source.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("event_payload_invalid");
  if (payload.event_name !== source.event_name) throw new Error("event_name_mismatch");
  if (authorityClaimsForbidden(payload)) throw new Error("server_authority_claim_forbidden");
  return {
    contract_version: "0.4.0",
    record_id: `record:${uuidV7()}`,
    delivery_id: `delivery:${uuidV7()}`,
    tenant_id: identity.tenantId,
    app_id: identity.appId,
    producer: identity.producer,
    producer_version: source.producer_version,
    ...(source.producer_variant ? { producer_variant: source.producer_variant } : {}),
    ...(source.wrapper_version ? { wrapper_version: source.wrapper_version } : {}),
    event_id: source.event_id,
    event_name: source.event_name,
    schema_version: "0.4.0",
    occurred_at: source.occurred_at,
    occurred_at_source: "server",
    received_at: receivedAt,
    processing_purpose_id: processingPurpose(source.event_name),
    processing_sequence: source.processing_sequence,
    payload,
  };
}

async function recordServerAudit(
  dependencies: ServerRouteDependencies,
  identity: VerifiedServerRequest,
  input: {
    readonly action: string;
    readonly targetScope: "ingest_batch" | "record";
    readonly targetRef: string;
    readonly outcome: "succeeded" | "failed";
    readonly reasonCode?: string;
  },
): Promise<void> {
  const occurredAt = new Date().toISOString();
  await withTenant(dependencies.pool, identity.tenantId, (client) => client.query(
    `INSERT INTO ledger.audit_logs (
      audit_log_id, tenant_id, app_id, occurred_at, actor_type, actor_ref,
      action, target_scope, target_ref, policy_version, request_digest,
      outcome, reason_code
    ) VALUES ($1,$2,$3,$4,'server_key',$5,$6,$7,$8,'server-auth-v1',$9,$10,$11)`,
    [uuidV7(), identity.tenantId, identity.appId, occurredAt,
      `server_key:${identity.serverKeyId}`, input.action, input.targetScope, input.targetRef,
      identity.requestDigest, input.outcome, input.reasonCode ?? null],
  ).then(() => undefined));
}

export async function handleServerBatch(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ServerRouteDependencies,
): Promise<void> {
  let body: Buffer;
  try { body = await readRawBody(request, dependencies.maximumBytes); }
  catch (error) {
    if (error instanceof RequestBodyError) return writeJson(response, error.statusCode, { error: error.message });
    throw error;
  }
  const path = new URL(request.url ?? "/", "http://openmasu.local").pathname;
  const auth = await verifyServerRequest({
    pool: dependencies.pool,
    payloadStore: dependencies.payloadStore,
    config: dependencies.config,
    headers: request.headers,
    method: request.method ?? "POST",
    path,
    body,
  });
  if (!auth.ok) return writeJson(response, 401, { error: "unauthorized" });
  const identity = auth.identity;
  if (!dependencies.keyBucket.allow(identity.serverKeyId) || !dependencies.appBucket.allow(identity.appId)) {
    return writeJson(response, 429, { error: "rate_limited" });
  }
  let value: Any;
  try { value = parseJsonBody<Any>(body); }
  catch { return writeJson(response, 400, { error: "malformed_json" }); }
  if (!Array.isArray(value.records) || value.records.length < 1
    || value.records.length > dependencies.maximumEvents) {
    return writeJson(response, 400, { error: "event_count_out_of_range" });
  }
  const receivedAt = new Date().toISOString();
  let records: Any[];
  let batchSubjectDigest: string | undefined;
  try {
    records = value.records.map((record: Any) => normalizeServerRecord(record, identity, receivedAt));
    batchSubjectDigest = subjectDigest(records, identity, dependencies.installationDigestKey);
  }
  catch (error) {
    const reason = error instanceof Error ? error.message : "record_invalid";
    await recordServerAudit(dependencies, identity, {
      action: "server_ingest_rejected",
      targetScope: "record",
      targetRef: `request-digest:${identity.requestDigest.slice(0, 32)}`,
      outcome: "failed",
      reasonCode: reason,
    });
    const status = [
      "server_authority_claim_forbidden",
      "server_event_name_forbidden",
      "server_batch_subject_mixed",
    ].includes(reason) ? 403 : 400;
    return writeJson(response, status, { error: reason });
  }
  if (batchSubjectDigest && await subjectIsWithdrawn(
    dependencies,
    identity,
    batchSubjectDigest,
    [...new Set(records.map((record) => record.processing_purpose_id))],
  )) {
    await recordServerAudit(dependencies, identity, {
      action: "server_ingest_rejected",
      targetScope: "record",
      targetRef: `request-digest:${identity.requestDigest.slice(0, 32)}`,
      outcome: "failed",
      reasonCode: "subject_withdrawn",
    });
    return writeJson(response, 403, { error: "subject_withdrawn" });
  }
  const durableBody = Buffer.from(JSON.stringify({ records }), "utf8");
  let ingestBatchId: string;
  try {
    ingestBatchId = await appendDurableBatch(dependencies.pool, dependencies.payloadStore, {
      tenantId: identity.tenantId,
      appId: identity.appId,
      producer: identity.producer,
      body: durableBody,
      eventCount: records.length,
      receivedAt,
      serverKeyId: identity.serverKeyId,
      ...(batchSubjectDigest ? { subjectDigest: batchSubjectDigest } : {}),
      requestNonce: identity.nonce,
      requestTimestampMs: identity.timestampMs,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "server_ingest_append_failed";
    if (!["privacy_subject_inactive", "privacy_scope_inactive"].includes(reason)) throw error;
    const auditReason = reason === "privacy_scope_inactive" ? reason : "subject_withdrawn";
    await recordServerAudit(dependencies, identity, {
      action: "server_ingest_rejected",
      targetScope: "record",
      targetRef: `request-digest:${identity.requestDigest.slice(0, 32)}`,
      outcome: "failed",
      reasonCode: auditReason,
    });
    return writeJson(response, 403, { error: auditReason });
  }
  await recordServerAudit(dependencies, identity, {
    action: "server_ingest_batch_append",
    targetScope: "ingest_batch",
    targetRef: ingestBatchId,
    outcome: "succeeded",
  });
  writeJson(response, 202, { ingest_batch_id: ingestBatchId, status: "pending" });
}
