import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import {
  verifyAdAttributionKitPostback,
  verifySkAdNetworkPostback,
  type VerificationResult,
} from "@open-mmp/apple-postback";
import { appendDurableBatch, uuidV7, withTenant, type PayloadStore } from "@open-mmp/runtime";
import type { KeyedTokenBucket } from "./rate-limit.js";

type JsonObject = Record<string, unknown>;
export type ApplePostbackKind = "skadnetwork" | "adattributionkit";

export class HourlyLedgerQuota {
  readonly #counts = new Map<string, number>();

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 0) throw new Error("invalid ledger quota");
  }

  record(tenantId: string, appId: string, now: Date): { readonly count: number; readonly withinLimit: boolean } {
    const hour = Math.floor(now.getTime() / 3_600_000);
    const key = `${tenantId}\u0000${appId}\u0000${hour}`;
    const count = (this.#counts.get(key) ?? 0) + 1;
    this.#counts.set(key, count);
    if (this.#counts.size > 4_096) {
      for (const candidate of this.#counts.keys()) {
        const candidateHour = Number(candidate.slice(candidate.lastIndexOf("\u0000") + 1));
        if (candidateHour < hour - 1) this.#counts.delete(candidate);
      }
    }
    return { count, withinLimit: count <= this.limit };
  }

  count(tenantId: string, appId: string, now: Date): number {
    return this.#counts.get(`${tenantId}\u0000${appId}\u0000${Math.floor(now.getTime() / 3_600_000)}`) ?? 0;
  }
}

export type ApplePostbackReceiverDependencies = {
  readonly pool: Pool;
  readonly payloadStore: PayloadStore;
  readonly maximumBytes: number;
  readonly acceptDevelopmentPostbacks: boolean;
  readonly sourceBucket: KeyedTokenBucket;
  readonly appBucket: KeyedTokenBucket;
  readonly invalidLedgerQuota: HourlyLedgerQuota;
  readonly now?: () => Date;
  readonly verificationKeys?: {
    readonly skanPublicKeyBase64?: string;
    readonly aakKeySet?: Readonly<Record<string, string>>;
  };
};

class PostbackRequestError extends Error {
  constructor(readonly statusCode: 400 | 429, message: string) {
    super(message);
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeEmpty(response: ServerResponse, statusCode: number): void {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": "0",
    "x-content-type-options": "nosniff",
  });
  response.end();
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const contentLength = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new PostbackRequestError(400, "postback_body_too_large");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    bytes += value.length;
    if (bytes > maximumBytes) throw new PostbackRequestError(400, "postback_body_too_large");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function parseBody(body: Buffer): JsonObject {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not_object");
    return parsed as JsonObject;
  } catch {
    throw new PostbackRequestError(400, "postback_json_malformed");
  }
}

function sourceKey(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    throw new PostbackRequestError(400, `${name}_invalid`);
  }
  return value;
}

function patternedString(value: unknown, name: string, pattern: RegExp, maximumLength = 128): string {
  const rendered = requiredString(value, name);
  if (rendered.length > maximumLength || !pattern.test(rendered)) {
    throw new PostbackRequestError(400, `${name}_invalid`);
  }
  return rendered;
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new PostbackRequestError(400, `${name}_invalid`);
  return Number(value);
}

function rangedInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  const rendered = requiredInteger(value, name);
  if (rendered < minimum || rendered > maximum) throw new PostbackRequestError(400, `${name}_invalid`);
  return rendered;
}

function requiredBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new PostbackRequestError(400, `${name}_invalid`);
  return value;
}

function enumeratedString(value: unknown, name: string, allowed: readonly string[]): string {
  const rendered = requiredString(value, name);
  if (!allowed.includes(rendered)) throw new PostbackRequestError(400, `${name}_invalid`);
  return rendered;
}

function optional<T>(value: unknown, parser: (candidate: unknown, name: string) => T, name: string): T | undefined {
  return value === undefined ? undefined : parser(value, name);
}

function resolvedEvidence(result: VerificationResult): JsonObject {
  if (result.verified) return result.authenticated;
  if (result.unverifiedClaims) return result.unverifiedClaims;
  return {};
}

function appleAppAdamId(kind: ApplePostbackKind, body: JsonObject, verification: VerificationResult): number {
  const result = kind === "skadnetwork"
    ? requiredInteger(body["app-id"], "app_id")
    : requiredInteger(resolvedEvidence(verification)["advertised-item-identifier"], "advertised_item_identifier");
  if (result < 1) throw new PostbackRequestError(400, "apple_app_adam_id_invalid");
  return result;
}

function pickOptional(
  target: JsonObject,
  source: JsonObject,
  pairs: readonly (readonly [string, string, (value: unknown, name: string) => unknown])[],
): void {
  for (const [sourceName, targetName, parser] of pairs) {
    const value = optional(source[sourceName], parser, targetName);
    if (value !== undefined) target[targetName] = value;
  }
}

function normalizedPayload(
  kind: ApplePostbackKind,
  body: JsonObject,
  verification: VerificationResult,
): JsonObject {
  const evidenceBoundary = {
    apple_signature_status: verification.verified ? "verified" : "unverified",
    unsigned_observation_fields: Object.keys(verification.unsigned).sort(),
  };
  if (kind === "skadnetwork") {
    const version = patternedString(body.version, "version", /^(3|4)\.[0-9]+$/, 16);
    const major = Number(version.split(".")[0]);
    const payload: JsonObject = {
      event_name: "skan_postback",
      version,
      ad_network_id: patternedString(body["ad-network-id"], "ad_network_id", /^[A-Za-z0-9.-]+$/),
      app_id: requiredInteger(body["app-id"], "app_id"),
      transaction_id: patternedString(body["transaction-id"], "transaction_id", /^[A-Za-z0-9._:-]{1,120}$/),
      attribution_signature: requiredString(body["attribution-signature"], "attribution_signature"),
      signature_verified: verification.verified,
      did_win: requiredBoolean(body["did-win"], "did_win"),
      extensions: evidenceBoundary,
    };
    pickOptional(payload, body, [
      ["source-identifier", "source_identifier", (value, name) => patternedString(value, name, /^[0-9]{2,4}$/)],
      ["campaign-id", "campaign_id", (value, name) => rangedInteger(value, name, 1, 100)],
      ["source-app-id", "source_app_id", requiredInteger],
      ["source-domain", "source_domain", (value, name) => patternedString(value, name, /^[A-Za-z0-9.-]+$/, 253)],
      ["conversion-value", "conversion_value", (value, name) => rangedInteger(value, name, 0, 63)],
      ["coarse-conversion-value", "coarse_conversion_value", (value, name) => enumeratedString(value, name, ["low", "medium", "high"])],
      ["postback-sequence-index", "postback_sequence_index", (value, name) => rangedInteger(value, name, 0, 2)],
      ["redownload", "redownload", requiredBoolean],
      ["country-code", "country_code", (value, name) => patternedString(value, name, /^[A-Z]{2}$/, 2)],
      ["fidelity-type", "fidelity_type", (value, name) => rangedInteger(value, name, 0, 1)],
    ]);
    if (payload.conversion_value !== undefined && payload.coarse_conversion_value !== undefined) {
      throw new PostbackRequestError(400, "conversion_value_ambiguous");
    }
    if (major === 3 && (payload.campaign_id === undefined
      || payload.source_identifier !== undefined
      || payload.postback_sequence_index !== undefined
      || payload.coarse_conversion_value !== undefined)) {
      throw new PostbackRequestError(400, "skan_version_fields_invalid");
    }
    if (major === 4 && (payload.source_identifier === undefined
      || payload.postback_sequence_index === undefined
      || payload.campaign_id !== undefined)) {
      throw new PostbackRequestError(400, "skan_version_fields_invalid");
    }
    if (Number(payload.postback_sequence_index ?? 0) > 0 && payload.conversion_value !== undefined) {
      throw new PostbackRequestError(400, "skan_fine_value_window_invalid");
    }
    return payload;
  }

  const claims = resolvedEvidence(verification);
  const payload: JsonObject = {
    event_name: "adattributionkit_postback",
    jws_string: requiredString(body["jws-string"], "jws_string"),
    signature_verified: verification.verified,
    postback_identifier: patternedString(claims["postback-identifier"], "postback_identifier", /^[A-Za-z0-9._:-]{1,120}$/),
    advertised_item_identifier: requiredInteger(claims["advertised-item-identifier"], "advertised_item_identifier"),
    conversion_type: enumeratedString(claims["conversion-type"], "conversion_type", ["download", "redownload"]),
    ad_network_identifier: patternedString(claims["ad-network-identifier"], "ad_network_identifier", /^[A-Za-z0-9.-]+$/),
    impression_type: enumeratedString(claims["impression-type"], "impression_type", ["app-impression"]),
    postback_sequence_index: rangedInteger(claims["postback-sequence-index"], "postback_sequence_index", 0, 2),
    did_win: requiredBoolean(claims["did-win"], "did_win"),
    extensions: evidenceBoundary,
  };
  if (verification.verified && verification.signingKeyEnvironment) {
    payload.signing_key_environment = verification.signingKeyEnvironment;
  }
  pickOptional(payload, claims, [
    ["source-identifier", "source_identifier", (value, name) => patternedString(value, name, /^[0-9]{2,4}$/)],
    ["publisher-item-identifier", "publisher_item_identifier", requiredInteger],
    ["marketplace-identifier", "marketplace_identifier", (value, name) => patternedString(value, name, /^[A-Za-z0-9.-]+$/, 253)],
  ]);
  pickOptional(payload, body, [
    ["conversion-value", "conversion_value", (value, name) => rangedInteger(value, name, 0, 63)],
    ["coarse-conversion-value", "coarse_conversion_value", (value, name) => enumeratedString(value, name, ["low", "medium", "high"])],
    ["ad-interaction-type", "ad_interaction_type", (value, name) => enumeratedString(value, name, ["view", "click"])],
    ["country-code", "country_code", (value, name) => patternedString(value, name, /^[A-Z]{2}$/, 2)],
  ]);
  if (payload.conversion_value !== undefined && payload.coarse_conversion_value !== undefined) {
    throw new PostbackRequestError(400, "conversion_value_ambiguous");
  }
  return payload;
}

function normalizedRecord(
  kind: ApplePostbackKind,
  scope: { readonly tenantId: string; readonly appId: string },
  body: JsonObject,
  verification: VerificationResult,
  receivedAt: string,
): JsonObject {
  const payload = normalizedPayload(kind, body, verification);
  const eventId = kind === "skadnetwork"
    ? `skan:${String(payload.transaction_id)}`
    : `aak:${String(payload.postback_identifier)}`;
  const producer = kind === "skadnetwork" ? "postback:skadnetwork" : "postback:adattributionkit";
  return {
    contract_version: "0.3.0",
    record_id: `apple-postback:${uuidV7(Date.parse(receivedAt))}`,
    delivery_id: `delivery:${uuidV7(Date.parse(receivedAt))}`,
    tenant_id: scope.tenantId,
    app_id: scope.appId,
    producer,
    producer_version: kind === "skadnetwork" ? String(payload.version) : "adattributionkit-jws-v1",
    event_id: eventId,
    event_name: kind === "skadnetwork" ? "skan_postback" : "adattributionkit_postback",
    schema_version: "0.3.0",
    occurred_at: receivedAt,
    occurred_at_source: "server",
    received_at: receivedAt,
    processing_purpose_id: "attribution",
    processing_sequence: 1,
    payload,
  };
}

async function resolveScope(pool: Pool, adamId: number): Promise<{ tenantId: string; appId: string } | undefined> {
  const result = await pool.query<{ tenant_id: string; app_id: string }>(
    "SELECT tenant_id, app_id FROM control.resolve_apple_app_adam_id($1::bigint)",
    [String(adamId)],
  );
  const row = result.rows[0];
  return row ? { tenantId: row.tenant_id, appId: row.app_id } : undefined;
}

async function recordUnregisteredAudit(
  pool: Pool,
  kind: ApplePostbackKind,
  adamId: number,
  requestDigest: string,
  now: Date,
): Promise<void> {
  const artifact = {
    postback_kind: kind,
    action: "postback_receive",
    outcome: "ignored",
    reason_code: "apple_app_not_registered",
    adam_id_digest: sha256(String(adamId)),
    request_digest: requestDigest,
    occurred_at: now.toISOString(),
  };
  await pool.query(
    `INSERT INTO control.public_postback_audits (
      public_postback_audit_id, occurred_at, postback_kind, action,
      outcome, reason_code, adam_id_digest, request_digest, artifact
    ) VALUES ($1,$2,$3,'postback_receive','ignored','apple_app_not_registered',$4,$5,$6::jsonb)`,
    [uuidV7(now.getTime()), now.toISOString(), kind, artifact.adam_id_digest, requestDigest, JSON.stringify(artifact)],
  );
}

async function recordInvalidAudit(
  pool: Pool,
  scope: { readonly tenantId: string; readonly appId: string },
  kind: ApplePostbackKind,
  requestDigest: string,
  reasonCode: string,
  count: number,
  now: Date,
): Promise<void> {
  await withTenant(pool, scope.tenantId, (client) => client.query(
    `INSERT INTO ledger.audit_logs (
      audit_log_id, tenant_id, app_id, occurred_at, actor_type, actor_ref,
      action, target_scope, target_ref, policy_version, request_digest,
      outcome, reason_code
    ) VALUES ($1,$2,$3,$4,'apple_postback',$5,'apple_postback_invalid',
      'postback',$6,'m4-postback-v1',$7,'failed',$8)`,
    [
      uuidV7(now.getTime()), scope.tenantId, scope.appId, now.toISOString(),
      `apple_postback:${kind}`, `postback:${kind}:invalid:${count}`, requestDigest, reasonCode,
    ],
  ).then(() => undefined));
}

function verifyPostback(
  kind: ApplePostbackKind,
  body: JsonObject,
  dependencies: ApplePostbackReceiverDependencies,
): VerificationResult {
  return kind === "skadnetwork"
    ? verifySkAdNetworkPostback(body, {
        ...(dependencies.verificationKeys?.skanPublicKeyBase64
          ? { publicKeyBase64: dependencies.verificationKeys.skanPublicKeyBase64 }
          : {}),
      })
    : verifyAdAttributionKitPostback(body, {
        acceptDevelopmentPostbacks: dependencies.acceptDevelopmentPostbacks,
        ...(dependencies.verificationKeys?.aakKeySet ? { keySet: dependencies.verificationKeys.aakKeySet } : {}),
      });
}

export async function receiveApplePostback(
  request: IncomingMessage,
  response: ServerResponse,
  kind: ApplePostbackKind,
  dependencies: ApplePostbackReceiverDependencies,
): Promise<void> {
  if (!dependencies.sourceBucket.allow(sourceKey(request))) {
    writeEmpty(response, 429);
    return;
  }
  try {
    const raw = await readBody(request, dependencies.maximumBytes);
    const body = parseBody(raw);
    const verification = verifyPostback(kind, body, dependencies);
    if (!verification.verified && verification.reason === "malformed") {
      throw new PostbackRequestError(400, "postback_signature_material_malformed");
    }
    const adamId = appleAppAdamId(kind, body, verification);
    if (!dependencies.appBucket.allow(`adam:${adamId}`)) {
      writeEmpty(response, 429);
      return;
    }
    const requestDigest = sha256(raw);
    const now = dependencies.now?.() ?? new Date();
    const receivedAt = now.toISOString();
    const scope = await resolveScope(dependencies.pool, adamId);
    if (!scope) {
      await recordUnregisteredAudit(dependencies.pool, kind, adamId, requestDigest, now);
      writeEmpty(response, 200);
      return;
    }

    const record = normalizedRecord(kind, scope, body, verification, receivedAt);
    if (!verification.verified) {
      const quota = dependencies.invalidLedgerQuota.record(scope.tenantId, scope.appId, now);
      if (!quota.withinLimit) {
        await recordInvalidAudit(
          dependencies.pool, scope, kind, requestDigest, verification.reason, quota.count, now,
        );
        writeEmpty(response, 200);
        return;
      }
    }

    const durableBody = Buffer.from(JSON.stringify({ records: [record] }), "utf8");
    await appendDurableBatch(dependencies.pool, dependencies.payloadStore, {
      tenantId: scope.tenantId,
      appId: scope.appId,
      producer: kind === "skadnetwork" ? "postback:skadnetwork" : "postback:adattributionkit",
      body: durableBody,
      eventCount: 1,
      receivedAt,
    });
    writeEmpty(response, 200);
  } catch (error) {
    if (error instanceof PostbackRequestError) {
      writeEmpty(response, error.statusCode);
      return;
    }
    throw error;
  }
}
