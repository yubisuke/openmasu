import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { appendDurableBatch, uuidV7, type PayloadStore } from "@openmasu/runtime";
import { executePrivacyRequest, type PrivacyRequestBody } from "./privacy.js";
import { type KeyedTokenBucket } from "./rate-limit.js";
import { parseJsonBody, readRawBody, RequestBodyError } from "./raw-body.js";
import {
  installationIdDigest,
  issueInstallationCredential,
  recordSdkAudit,
  revokeInstallationCredential,
  verifySdkRequest,
  type SdkAuthConfig,
  type VerifiedSdkRequest,
} from "./sdk-auth.js";

type Any = Record<string, any>;

export type SdkRouteDependencies = {
  pool: Pool;
  payloadStore: PayloadStore;
  config: SdkAuthConfig;
  maximumBytes: number;
  maximumEvents: number;
  enrollmentBucket: KeyedTokenBucket;
  installationBucket: KeyedTokenBucket;
  appBucket: KeyedTokenBucket;
  privacyBucket: KeyedTokenBucket;
};

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(`${JSON.stringify(value)}\n`);
}

async function auditFailure(dependencies: SdkRouteDependencies, failure: Awaited<ReturnType<typeof verifySdkRequest>> & { ok: false }): Promise<void> {
  const actorType = failure.failure.actorRef.startsWith("sdk_installation:") ? "sdk_installation" : "sdk_key";
  await recordSdkAudit(dependencies.pool, dependencies.config, {
    actorType,
    actorRef: failure.failure.actorRef,
    action: "sdk_authenticate",
    targetScope: actorType === "sdk_installation" ? "installation" : "sdk_key",
    targetRef: failure.failure.actorRef,
    requestDigest: failure.failure.requestDigest,
    outcome: "failed",
    reasonCode: failure.failure.reason,
  });
}

async function authenticate(
  request: IncomingMessage,
  body: Buffer,
  dependencies: SdkRouteDependencies,
  requireInstallation: boolean,
): Promise<VerifiedSdkRequest | undefined> {
  const path = new URL(request.url ?? "/", "http://openmasu.local").pathname;
  const result = await verifySdkRequest({
    pool: dependencies.pool,
    payloadStore: dependencies.payloadStore,
    config: dependencies.config,
    headers: request.headers,
    method: request.method ?? "POST",
    path,
    body,
    requireInstallation,
  });
  if (!result.ok) {
    await auditFailure(dependencies, result);
    return undefined;
  }
  return result.identity;
}

function normalizedRecord(
  source: Any,
  identity: VerifiedSdkRequest,
  receivedAt: string,
  config: SdkAuthConfig,
): Any {
  const payload = source.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("event_payload_invalid");
  if (payload.adservices_context !== undefined || payload.extensions?.adservices_context !== undefined) {
    throw new Error("device_adservices_claim_forbidden");
  }
  const adServicesToken = payload.extensions?.adservices_attribution_token_protected;
  if (adServicesToken !== undefined) {
    if (identity.platform !== "ios" || source.event_name !== "install") {
      throw new Error("adservices_token_scope_invalid");
    }
    if (typeof adServicesToken !== "string" || adServicesToken.length < 1
      || Buffer.byteLength(adServicesToken, "utf8") > 64 * 1024) {
      throw new Error("adservices_token_invalid");
    }
  }
  if (typeof payload.installation_id === "string"
    && installationIdDigest(config, payload.installation_id) !== identity.installationIdDigest) {
    throw new Error("installation_scope_mismatch");
  }
  const processingPurposeId = (() => {
    if (source.event_name === "install") return "attribution";
    if (source.event_name === "ad_revenue") return "revenue_measurement";
    if (source.event_name === "consent_changed" || source.event_name === "privacy_control") return "fraud_prevention";
    return "analytics";
  })();
  const recordId = `record:${uuidV7()}`;
  return {
    contract_version: "0.4.0",
    record_id: recordId,
    delivery_id: `delivery:${uuidV7()}`,
    tenant_id: identity.tenantId,
    app_id: identity.appId,
    producer: identity.platform === "ios" ? "sdk-ios" : "sdk-android",
    producer_version: source.producer_version,
    ...(source.producer_variant ? { producer_variant: source.producer_variant } : {}),
    ...(source.wrapper_version ? { wrapper_version: source.wrapper_version } : {}),
    event_id: source.event_id,
    event_name: source.event_name,
    schema_version: "0.4.0",
    occurred_at: source.occurred_at,
    occurred_at_source: source.occurred_at_source,
    received_at: receivedAt,
    // Processing purpose is assigned by the authenticated runtime, never trusted from the client.
    processing_purpose_id: processingPurposeId,
    processing_sequence: source.processing_sequence,
    payload,
  };
}

export async function handleSdkEnrollment(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: SdkRouteDependencies,
): Promise<void> {
  const body = await readRawBody(request, Math.min(dependencies.maximumBytes, 32 * 1024));
  const identity = await authenticate(request, body, dependencies, false);
  if (!identity) return writeJson(response, 401, { error: "unauthorized" });
  if (!dependencies.enrollmentBucket.allow(identity.sdkKeyId)) return writeJson(response, 429, { error: "rate_limited" });
  let value: Any;
  try { value = parseJsonBody<Any>(body); }
  catch { return writeJson(response, 400, { error: "malformed_json" }); }
  if (typeof value.installation_id !== "string") return writeJson(response, 400, { error: "installation_id_invalid" });
  try {
    const credential = await issueInstallationCredential({
      pool: dependencies.pool,
      payloadStore: dependencies.payloadStore,
      config: dependencies.config,
      sdkKeyId: identity.sdkKeyId,
      installationId: value.installation_id,
    });
    const auditLogId = await recordSdkAudit(dependencies.pool, dependencies.config, {
      actorType: "sdk_key", actorRef: `sdk_key:${identity.sdkKeyId}`,
      action: "installation_enroll", targetScope: "installation",
      targetRef: credential.installation_key_id, requestDigest: identity.requestDigest,
      outcome: "succeeded",
    });
    writeJson(response, 201, { ...credential, auth_ref: `sdk_auth:${auditLogId}` });
  } catch (error) {
    writeJson(response, error instanceof Error && error.message.includes("duplicate") ? 409 : 400, {
      error: error instanceof Error ? error.message : "enrollment_failed",
    });
  }
}

export async function handleSdkBatch(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: SdkRouteDependencies,
): Promise<void> {
  let body: Buffer;
  try { body = await readRawBody(request, dependencies.maximumBytes); }
  catch (error) {
    if (error instanceof RequestBodyError) return writeJson(response, error.statusCode, { error: error.message });
    throw error;
  }
  const identity = await authenticate(request, body, dependencies, true);
  if (!identity) return writeJson(response, 401, { error: "unauthorized" });
  if (!dependencies.installationBucket.allow(identity.installationKeyId!)
    || !dependencies.appBucket.allow(identity.sdkKeyId)) {
    return writeJson(response, 429, { error: "rate_limited" });
  }
  let value: Any;
  try { value = parseJsonBody<Any>(body); }
  catch { return writeJson(response, 400, { error: "malformed_json" }); }
  if (!Array.isArray(value.records) || value.records.length < 1 || value.records.length > dependencies.maximumEvents) {
    return writeJson(response, 400, { error: "event_count_out_of_range" });
  }
  const receivedAt = new Date().toISOString();
  let records: Any[];
  try { records = value.records.map((record: Any) => normalizedRecord(record, identity, receivedAt, dependencies.config)); }
  catch (error) { return writeJson(response, 403, { error: error instanceof Error ? error.message : "record_invalid" }); }
  const durableBody = Buffer.from(JSON.stringify({ records }), "utf8");
  const ingestBatchId = await appendDurableBatch(dependencies.pool, dependencies.payloadStore, {
    tenantId: identity.tenantId,
    appId: identity.appId,
    producer: identity.platform === "ios" ? "sdk-ios" : "sdk-android",
    body: durableBody,
    eventCount: records.length,
    receivedAt,
    sdkKeyId: identity.sdkKeyId,
    installationKeyId: identity.installationKeyId,
    requestNonce: identity.nonce,
    requestTimestampMs: identity.timestampMs,
  });
  await recordSdkAudit(dependencies.pool, dependencies.config, {
    actorType: "sdk_installation", actorRef: `sdk_installation:${identity.installationKeyId}`,
    action: "ingest_batch_append", targetScope: "ingest_batch", targetRef: ingestBatchId,
    requestDigest: identity.requestDigest, outcome: "succeeded",
  });
  writeJson(response, 202, { ingest_batch_id: ingestBatchId, status: "pending" });
}

export async function handleDevicePrivacy(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: SdkRouteDependencies,
): Promise<void> {
  const body = await readRawBody(request, Math.min(dependencies.maximumBytes, 32 * 1024));
  const identity = await authenticate(request, body, dependencies, true);
  if (!identity) return writeJson(response, 401, { error: "unauthorized" });
  if (!dependencies.privacyBucket.allow(identity.installationKeyId!)) return writeJson(response, 429, { error: "rate_limited" });
  let value: Any;
  try { value = parseJsonBody<Any>(body); }
  catch { return writeJson(response, 400, { error: "malformed_json" }); }
  const subject = typeof value.installation_id === "string" ? value.installation_id : "";
  if (!subject || installationIdDigest(dependencies.config, subject) !== identity.installationIdDigest) {
    await recordSdkAudit(dependencies.pool, dependencies.config, {
      actorType: "sdk_installation", actorRef: `sdk_installation:${identity.installationKeyId}`,
      action: "privacy_delete", targetScope: "privacy_request", targetRef: "privacy:denied",
      requestDigest: identity.requestDigest, outcome: "failed", reasonCode: "installation_scope_mismatch",
    });
    return writeJson(response, 403, { error: "installation_scope_mismatch" });
  }
  const auditLogId = await recordSdkAudit(dependencies.pool, dependencies.config, {
    actorType: "sdk_installation", actorRef: `sdk_installation:${identity.installationKeyId}`,
    action: "sdk_authenticate", targetScope: "installation", targetRef: identity.installationKeyId!,
    requestDigest: identity.requestDigest, outcome: "succeeded",
  });
  const privacyBody: PrivacyRequestBody = {
    tenant_id: identity.tenantId,
    app_id: identity.appId,
    requested_via: "on_device_sdk",
    deletion_scope: "installation",
    deletion_subject_ref: subject,
  };
  const artifact = await executePrivacyRequest(dependencies.pool, {
    tenantId: identity.tenantId, appId: identity.appId,
    actorType: "sdk_installation", actorRef: `sdk_installation:${identity.installationKeyId}`,
    requesterAuthRef: `sdk_auth:${auditLogId}`, installationKeyId: identity.installationKeyId,
    deletionSubjectDigest: identity.installationIdDigest,
  }, privacyBody, dependencies.payloadStore);
  await revokeInstallationCredential({ pool: dependencies.pool, payloadStore: dependencies.payloadStore, identity });
  writeJson(response, 201, artifact);
}
