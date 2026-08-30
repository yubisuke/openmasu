import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { PayloadStore } from "@openmasu/runtime";
import {
  appleLeafKeyFromChain,
  decodeCompactJwsPayloadUnverified,
  normalizeAppleNotification,
  sha256,
  verifyCompactJws,
} from "@openmasu/commerce-lifecycle";
import { recordCommerceNotification } from "./commerce-notifications.js";

type JsonObject = Record<string, unknown>;

export type AppleStoreNotificationDependencies = {
  readonly pool: Pool;
  readonly payloadStore: PayloadStore;
  readonly trustedRootFingerprints: ReadonlySet<string>;
  readonly maximumBytes: number;
  readonly now?: () => Date;
  readonly verifySignedData?: (compact: string) => JsonObject;
};

class AppleStoreNotificationError extends Error {
  constructor(readonly statusCode: 400 | 401 | 404 | 503, message: string) { super(message); }
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppleStoreNotificationError(400, `${label}_invalid`);
  return value as JsonObject;
}

function string(value: unknown, label: string, maximum = 4096): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum) {
    throw new AppleStoreNotificationError(400, `${label}_invalid`);
  }
  return value;
}

async function body(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const next = Buffer.from(chunk);
    bytes += next.length;
    if (bytes > maximumBytes) throw new AppleStoreNotificationError(400, "apple_store_notification_too_large");
    chunks.push(next);
  }
  return Buffer.concat(chunks);
}

function empty(response: ServerResponse, status: number): void {
  response.writeHead(status, { "cache-control": "no-store", "content-length": "0", "x-content-type-options": "nosniff" });
  response.end();
}

export async function receiveAppleStoreNotification(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: AppleStoreNotificationDependencies,
): Promise<void> {
  const now = dependencies.now?.() ?? new Date();
  try {
    const raw = await body(request, dependencies.maximumBytes);
    let envelope: JsonObject;
    try { envelope = object(JSON.parse(raw.toString("utf8")), "apple_store_envelope"); }
    catch { throw new AppleStoreNotificationError(400, "apple_store_envelope_malformed"); }
    if (Object.keys(envelope).some((key) => key !== "signedPayload")) {
      throw new AppleStoreNotificationError(400, "apple_store_envelope_unknown_field");
    }
    const compact = string(envelope.signedPayload, "apple_store_signed_payload", dependencies.maximumBytes * 2);
    let untrusted: JsonObject;
    try { untrusted = decodeCompactJwsPayloadUnverified(compact); }
    catch { throw new AppleStoreNotificationError(400, "apple_store_signed_payload_invalid"); }
    const untrustedData = object(untrusted.data, "apple_store_data");
    const bundleId = string(untrustedData.bundleId, "apple_store_bundle_id", 255);
    const environment = untrustedData.environment;
    const appAppleId = untrustedData.appAppleId === undefined ? undefined : Number(untrustedData.appAppleId);
    if (!new Set(["Sandbox", "Production"]).has(String(environment))
      || (environment === "Production" && (!Number.isSafeInteger(appAppleId) || Number(appAppleId) <= 0))
      || (appAppleId !== undefined && (!Number.isSafeInteger(appAppleId) || appAppleId <= 0))) {
      throw new AppleStoreNotificationError(400, "apple_store_scope_invalid");
    }
    const resolved = await dependencies.pool.query<{ tenant_id: string; app_id: string }>(
      "SELECT tenant_id, app_id FROM control.resolve_apple_store_registration($1,$2)", [bundleId, appAppleId ?? null],
    );
    const identity = resolved.rows.length === 1 ? resolved.rows[0] : undefined;
    if (!identity) {
      // Keep the public provider endpoint non-enumerating.
      empty(response, 200);
      return;
    }
    if (!dependencies.verifySignedData && dependencies.trustedRootFingerprints.size === 0) {
      throw new AppleStoreNotificationError(503, "apple_store_roots_unconfigured");
    }
    const verifySignedData = dependencies.verifySignedData ?? ((value: string) => {
      const key = appleLeafKeyFromChain(value, dependencies.trustedRootFingerprints, now);
      return verifyCompactJws(value, key);
    });
    let normalized;
    try {
      normalized = normalizeAppleNotification(compact, verifySignedData, {
        bundleId,
        ...(appAppleId === undefined ? {} : { appAppleId }),
        environment: environment as "Sandbox" | "Production",
      });
    } catch {
      // Invalid signatures and scope mismatches get the same public response as
      // an unknown registration and never reach protected storage.
      empty(response, 200);
      return;
    }
    const notificationDigest = sha256(normalized.notificationUuid);
    const subjectDigest = normalized.event.originalTransactionDigest ?? normalized.event.transactionDigest;
    await recordCommerceNotification({
      pool: dependencies.pool,
      payloadStore: dependencies.payloadStore,
      tenantId: identity.tenant_id,
      appId: identity.app_id,
      payload: raw,
      notificationDigest,
      ...(subjectDigest ? { subjectDigest } : {}),
      // Notifications are signals. Only the authenticated Server API read-back is
      // allowed to create financial lifecycle facts.
      event: { ...normalized.event, financialEffect: "none" },
      receivedAt: now,
      readbackOperation: normalized.event.financialEffect === "refund" ? "apple_refund_history" : "apple_transaction_history",
    });
    empty(response, 200);
  } catch (error) {
    empty(response, error instanceof AppleStoreNotificationError ? error.statusCode : 503);
  }
}
