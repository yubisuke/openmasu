import { createHash, createPublicKey, verify, type JsonWebKey as CryptoJsonWebKey } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { uuidV7, withTenant, type PayloadStore } from "@openmasu/runtime";

type JsonObject = Record<string, unknown>;
type Fetch = typeof fetch;

export type GooglePlayRtdnReceiverDependencies = {
  readonly pool: Pool;
  readonly payloadStore: PayloadStore;
  readonly expectedAudience: string;
  readonly expectedServiceAccountEmail: string;
  readonly maximumBytes: number;
  readonly now?: () => Date;
  readonly fetch?: Fetch;
};

class RtdnRequestError extends Error {
  constructor(readonly statusCode: 400 | 401 | 503, message: string) {
    super(message);
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RtdnRequestError(400, `${label}_invalid`);
  return value as JsonObject;
}

function string(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum) {
    throw new RtdnRequestError(400, `${label}_invalid`);
  }
  return value;
}

function exactKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new RtdnRequestError(400, `${label}_unknown_field`);
}

async function body(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) throw new RtdnRequestError(400, "rtdn_body_too_large");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const next = Buffer.from(chunk);
    bytes += next.length;
    if (bytes > maximumBytes) throw new RtdnRequestError(400, "rtdn_body_too_large");
    chunks.push(next);
  }
  return Buffer.concat(chunks);
}

function parseJson(value: Buffer, label: string): JsonObject {
  try {
    return object(JSON.parse(value.toString("utf8")), label);
  } catch (error) {
    if (error instanceof RtdnRequestError) throw error;
    throw new RtdnRequestError(400, `${label}_malformed`);
  }
}

function jwtPart(value: string, label: string): JsonObject {
  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length > 16 * 1024) throw new Error("too_large");
    return object(JSON.parse(decoded.toString("utf8")), label);
  } catch {
    throw new RtdnRequestError(401, `${label}_invalid`);
  }
}

export async function verifyGooglePushToken(
  authorization: string | undefined,
  config: {
    readonly audience: string;
    readonly serviceAccountEmail: string;
    readonly now: Date;
    readonly fetch?: Fetch;
    readonly jwksUrl?: string;
  },
): Promise<void> {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? "");
  if (!match) throw new RtdnRequestError(401, "rtdn_authentication_required");
  const [encodedHeader, encodedClaims, encodedSignature] = match[1].split(".");
  const header = jwtPart(encodedHeader, "rtdn_jwt_header");
  const claims = jwtPart(encodedClaims, "rtdn_jwt_claims");
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256) {
    throw new RtdnRequestError(401, "rtdn_jwt_header_invalid");
  }
  const nowSeconds = Math.floor(config.now.getTime() / 1_000);
  const issuer = claims.iss;
  if (!new Set(["accounts.google.com", "https://accounts.google.com"]).has(String(issuer))
    || claims.aud !== config.audience
    || claims.email !== config.serviceAccountEmail
    || claims.email_verified !== true
    || typeof claims.iat !== "number" || typeof claims.exp !== "number"
    || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)
    || claims.iat > nowSeconds + 300 || claims.exp < nowSeconds - 300
    || claims.exp <= claims.iat || claims.exp - claims.iat > 3_900) {
    throw new RtdnRequestError(401, "rtdn_jwt_claims_invalid");
  }
  const jwksUrl = config.jwksUrl ?? "https://www.googleapis.com/oauth2/v3/certs";
  const url = new URL(jwksUrl);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || (!loopback && url.hostname !== "www.googleapis.com") || url.username || url.password) {
    throw new RtdnRequestError(503, "rtdn_jwks_endpoint_invalid");
  }
  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(url, {
      headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new RtdnRequestError(503, "rtdn_jwks_unavailable");
  }
  if (!response.ok) throw new RtdnRequestError(503, "rtdn_jwks_unavailable");
  const jwks = object(await response.json(), "rtdn_jwks");
  if (!Array.isArray(jwks.keys)) throw new RtdnRequestError(503, "rtdn_jwks_invalid");
  const key = jwks.keys.find((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const jwk = candidate as JsonObject;
    return jwk.kid === header.kid && jwk.kty === "RSA" && jwk.alg === "RS256" && jwk.use === "sig";
  });
  if (!key) throw new RtdnRequestError(401, "rtdn_jwt_key_unknown");
  let valid = false;
  try {
    valid = verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedClaims}`, "utf8"),
      createPublicKey({ key: key as CryptoJsonWebKey, format: "jwk" }),
      Buffer.from(encodedSignature, "base64url"),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new RtdnRequestError(401, "rtdn_jwt_signature_invalid");
}

function empty(response: ServerResponse, status: number): void {
  response.writeHead(status, { "cache-control": "no-store", "content-length": "0", "x-content-type-options": "nosniff" });
  response.end();
}

export async function receiveGooglePlayRtdn(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: GooglePlayRtdnReceiverDependencies,
): Promise<void> {
  const now = dependencies.now?.() ?? new Date();
  try {
    if (!dependencies.expectedAudience || !dependencies.expectedServiceAccountEmail) {
      throw new RtdnRequestError(503, "rtdn_receiver_not_configured");
    }
    await verifyGooglePushToken(request.headers.authorization, {
      audience: dependencies.expectedAudience,
      serviceAccountEmail: dependencies.expectedServiceAccountEmail,
      now,
      fetch: dependencies.fetch,
    });
    const envelope = parseJson(await body(request, dependencies.maximumBytes), "rtdn_envelope");
    exactKeys(envelope, ["message", "subscription"], "rtdn_envelope");
    const message = object(envelope.message, "rtdn_message");
    exactKeys(message, ["attributes", "data", "messageId", "orderingKey", "publishTime"], "rtdn_message");
    const messageId = string(message.messageId, "rtdn_message_id", 256);
    const encoded = string(message.data, "rtdn_data", dependencies.maximumBytes * 2);
    let decoded: Buffer;
    try {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error("invalid");
      decoded = Buffer.from(encoded, "base64");
      if (decoded.length === 0 || decoded.length > dependencies.maximumBytes
        || decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) throw new Error("invalid");
    } catch {
      throw new RtdnRequestError(400, "rtdn_data_invalid");
    }
    const notification = parseJson(decoded, "rtdn_notification");
    exactKeys(notification, ["version", "packageName", "eventTimeMillis", "subscriptionNotification",
      "oneTimeProductNotification", "voidedPurchaseNotification", "testNotification", "pendingRefundReviewNotification"], "rtdn_notification");
    const subscription = notification.subscriptionNotification;
    if (!subscription || typeof subscription !== "object" || Array.isArray(subscription)) {
      empty(response, 204);
      return;
    }
    const subscriptionNotification = subscription as JsonObject;
    exactKeys(subscriptionNotification, ["version", "notificationType", "purchaseToken"], "rtdn_subscription");
    if (subscriptionNotification.notificationType !== 2) {
      empty(response, 204);
      return;
    }
    const packageName = string(notification.packageName, "rtdn_package", 255);
    if (!/^[A-Za-z][A-Za-z0-9_.]{2,254}$/.test(packageName)) throw new RtdnRequestError(400, "rtdn_package_invalid");
    const eventMillis = string(notification.eventTimeMillis, "rtdn_event_time", 32);
    if (!/^[0-9]{10,16}$/.test(eventMillis) || !Number.isFinite(Number(eventMillis))) {
      throw new RtdnRequestError(400, "rtdn_event_time_invalid");
    }
    const eventTime = new Date(Number(eventMillis));
    if (!Number.isFinite(eventTime.getTime())) throw new RtdnRequestError(400, "rtdn_event_time_invalid");
    const purchaseToken = string(subscriptionNotification.purchaseToken, "rtdn_purchase_token", 64 * 1024);
    const resolved = await dependencies.pool.query<{ tenant_id: string; app_id: string }>(
      "SELECT tenant_id, app_id FROM control.resolve_android_package($1)", [packageName],
    );
    const identity = resolved.rows[0];
    if (!identity) {
      empty(response, 204);
      return;
    }
    const tokenDigest = sha256(purchaseToken);
    const initial = await withTenant(dependencies.pool, identity.tenant_id, async (client) => (await client.query<{
      product_id: string; subject_record_id: string; installation_id: string;
    }>(
      `SELECT token.product_id, result.subject_record_id, fact.installation_id
         FROM control.google_play_purchase_tokens AS token
         JOIN ledger.google_play_purchase_verification_results AS result
           ON result.verification_id=token.verification_id
          AND result.tenant_id=token.tenant_id AND result.app_id=token.app_id
         JOIN ledger.purchase_facts AS fact
           ON fact.record_id=result.verified_record_id
          AND fact.tenant_id=result.tenant_id AND fact.app_id=result.app_id
        WHERE token.tenant_id=$1 AND token.app_id=$2 AND token.token_digest=$3
          AND token.purchase_kind='subscription_initial' AND token.product_id IS NOT NULL
          AND result.verdict='verified' AND result.purchase_kind='subscription_initial'`,
      [identity.tenant_id, identity.app_id, tokenDigest],
    )).rows[0]);
    if (!initial) {
      empty(response, 204);
      return;
    }
    const verificationId = uuidV7(now.getTime());
    const tokenRef = await dependencies.payloadStore.write(
      { tenantId: identity.tenant_id, appId: identity.app_id, objectId: `google-play-rtdn-${verificationId}` },
      Buffer.from(JSON.stringify({ purchase_token: purchaseToken, installation_id: initial.installation_id }), "utf8"),
    );
    try {
      const inserted = await withTenant(dependencies.pool, identity.tenant_id, async (client) => {
        const messageInsert = await client.query(
          `INSERT INTO control.google_play_rtdn_messages (
             message_digest, tenant_id, app_id, verification_id, subject_record_id,
             token_digest, evidence_ref, notification_type, event_time, received_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,2,$8,$9) ON CONFLICT DO NOTHING`,
          [sha256(`${dependencies.expectedServiceAccountEmail}\0${messageId}`), identity.tenant_id,
            identity.app_id, verificationId, initial.subject_record_id, tokenDigest, tokenRef,
            eventTime.toISOString(), now.toISOString()],
        );
        if (messageInsert.rowCount !== 1) return false;
        await client.query(
          `INSERT INTO ephemeral.google_play_product_verifications (
             verification_id, tenant_id, app_id, subject_record_id, token_ref, token_digest,
             product_id, purchase_kind, verified_record_id, next_attempt_at, requested_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,'subscription_renewal',$8,$9::timestamptz,$10)`,
          [verificationId, identity.tenant_id, identity.app_id, initial.subject_record_id, tokenRef,
            tokenDigest, initial.product_id, `record:google-play-renewal:${verificationId}`,
            now.toISOString(), now.toISOString()],
        );
        return true;
      });
      if (!inserted) await dependencies.payloadStore.purge(tokenRef);
    } catch (error) {
      await dependencies.payloadStore.purge(tokenRef);
      throw error;
    }
    empty(response, 204);
  } catch (error) {
    if (error instanceof RtdnRequestError) {
      empty(response, error.statusCode);
      return;
    }
    empty(response, 503);
  }
}
