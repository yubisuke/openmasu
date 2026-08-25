import { createHash } from "node:crypto";

type JsonObject = Record<string, unknown>;
type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

const DEFAULT_BASE_URL = "https://datamanager.googleapis.com";
const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_ID = /^[A-Za-z0-9._:~+/=-]{1,256}$/;
const SAFE_DIAGNOSTIC_REASON = /^[A-Z][A-Z0-9_]{0,127}$/;

export type GoogleConversionEligibilityInput = {
  readonly verifiedResultId: string;
  readonly verificationVerdict: "verified" | "failed" | "unavailable";
  readonly verifiedRecordId: string | null;
  readonly financialStatus: "settled" | "pending" | "refunded";
  readonly attributionStatus: "non_organic" | "organic" | "unattributed";
  readonly attributionFinality: "final" | "provisional";
  readonly clickNetwork: string;
  readonly sourceQualifiedGclid: string;
  readonly destinationEnabled: boolean;
  readonly appAudience: "general" | "mixed" | "child_directed";
  readonly redacted: boolean;
  readonly withdrawn: boolean;
  readonly amountUnscaled: string;
  readonly amountScale: number;
  readonly currency: string;
  readonly eventTimestamp: string;
  readonly operatingAccountId: string;
  readonly conversionActionId: string;
};

export type EligibleGoogleConversion = Readonly<{
  verifiedResultId: string;
  verifiedRecordId: string;
  gclid: string;
  amountUnscaled: string;
  amountScale: number;
  currency: string;
  eventTimestamp: string;
  operatingAccountId: string;
  conversionActionId: string;
}>;

export type GoogleDataManagerRequest = Readonly<{
  destinations: readonly [Readonly<{
    operatingAccount: Readonly<{ accountType: "GOOGLE_ADS"; accountId: string }>;
    productDestinationId: string;
  }>];
  events: readonly [Readonly<{
    adIdentifiers: Readonly<{ gclid: string }>;
    conversionValue: number;
    currency: string;
    eventTimestamp: string;
    transactionId: string;
    eventSource: "APP";
  }>];
}>;

export type PreparedGoogleConversion = Readonly<{
  transactionId: string;
  request: GoogleDataManagerRequest;
  body: Buffer;
}>;

export type GoogleProviderFailureReason =
  | "transport_error"
  | "redirect_rejected"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_rejected"
  | "response_too_large"
  | "response_invalid";

export type GoogleDeliveryResult =
  | Readonly<{ outcome: "accepted"; requestId: string; httpStatus: number }>
  | Readonly<{ outcome: "retry"; reason: GoogleProviderFailureReason; httpStatus?: number }>
  | Readonly<{ outcome: "terminal"; reason: GoogleProviderFailureReason; httpStatus: number }>;

export type SafeDiagnosticCount = Readonly<{ reason: string; recordCount: string }>;
export type GoogleRequestStatus = "processing" | "success" | "partial_success" | "failure";
export type GoogleRequestStatusResult =
  | Readonly<{
    outcome: "status";
    status: GoogleRequestStatus;
    errors: readonly SafeDiagnosticCount[];
    warnings: readonly SafeDiagnosticCount[];
  }>
  | Readonly<{ outcome: "retry"; reason: GoogleProviderFailureReason; httpStatus?: number }>
  | Readonly<{ outcome: "terminal"; reason: GoogleProviderFailureReason; httpStatus: number }>;

export type GoogleDataManagerTransport = Readonly<{
  accessToken: string;
  fetch?: FetchLike;
  baseUrl?: string;
  maximumRequestBytes?: number;
  maximumResponseBytes?: number;
  timeoutMilliseconds?: number;
}>;

function object(value: unknown, error: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as JsonObject;
}

function strictKeys(value: JsonObject, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  if (Object.keys(value).some((key) => !allow.has(key))) throw new Error("google_conversion_field_forbidden");
}

function boundedString(value: unknown, label: string, pattern: RegExp, maximum = 255): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || !pattern.test(value)) {
    throw new Error(`google_conversion_${label}_invalid`);
  }
  return value;
}

function exactBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`google_conversion_${label}_invalid`);
  return value;
}

function exactEnum<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`google_conversion_${label}_invalid`);
  }
  return value as T;
}

/**
 * Applies the fail-closed Issue #63 gate before any provider request exists.
 * Extra fields are rejected so identifiers such as installation IDs, Play
 * tokens, device IDs, IP addresses, User-Agent values, and user data cannot
 * accidentally flow through a permissive spread operation.
 */
export function normalizeGoogleConversionEligibility(value: unknown): EligibleGoogleConversion {
  const input = object(value, "google_conversion_input_invalid");
  strictKeys(input, [
    "verifiedResultId", "verificationVerdict", "verifiedRecordId", "financialStatus",
    "attributionStatus", "attributionFinality", "clickNetwork", "sourceQualifiedGclid",
    "destinationEnabled", "appAudience", "redacted", "withdrawn", "amountUnscaled",
    "amountScale", "currency", "eventTimestamp", "operatingAccountId", "conversionActionId",
  ]);

  const verifiedResultId = boundedString(input.verifiedResultId, "verified_result_id", /^[A-Za-z0-9._:-]+$/);
  if (exactEnum(input.verificationVerdict, ["verified", "failed", "unavailable"] as const,
    "verification_verdict") !== "verified") throw new Error("google_conversion_not_verified");
  const verifiedRecordId = boundedString(input.verifiedRecordId, "verified_record_id", /^[A-Za-z0-9._:-]+$/);
  if (exactEnum(input.financialStatus, ["settled", "pending", "refunded"] as const,
    "financial_status") !== "settled") throw new Error("google_conversion_not_settled");
  if (exactEnum(input.attributionStatus, ["non_organic", "organic", "unattributed"] as const,
    "attribution_status") !== "non_organic") throw new Error("google_conversion_not_non_organic");
  if (exactEnum(input.attributionFinality, ["final", "provisional"] as const,
    "attribution_finality") !== "final") throw new Error("google_conversion_not_final");
  if (input.clickNetwork !== "google_ads") throw new Error("google_conversion_network_ineligible");
  const gclid = boundedString(input.sourceQualifiedGclid, "gclid", /^[A-Za-z0-9_-]+$/, 512);
  if (!exactBoolean(input.destinationEnabled, "destination_enabled")) {
    throw new Error("google_conversion_destination_disabled");
  }
  if (exactEnum(input.appAudience, ["general", "mixed", "child_directed"] as const,
    "app_audience") === "child_directed") throw new Error("google_conversion_child_directed");
  if (exactBoolean(input.redacted, "redacted")) throw new Error("google_conversion_redacted");
  if (exactBoolean(input.withdrawn, "withdrawn")) throw new Error("google_conversion_withdrawn");
  const amountUnscaled = boundedString(input.amountUnscaled, "amount_unscaled", /^(0|[1-9][0-9]*)$/, 40);
  if (!Number.isInteger(input.amountScale) || (input.amountScale as number) < 0 || (input.amountScale as number) > 18) {
    throw new Error("google_conversion_amount_scale_invalid");
  }
  const currency = boundedString(input.currency, "currency", /^[A-Z]{3}$/, 3);
  if (typeof input.eventTimestamp !== "string" || !Number.isFinite(Date.parse(input.eventTimestamp))) {
    throw new Error("google_conversion_event_timestamp_invalid");
  }
  const eventTimestamp = new Date(input.eventTimestamp).toISOString();
  const operatingAccountId = boundedString(input.operatingAccountId, "operating_account_id", /^[0-9]+$/, 32);
  const conversionActionId = boundedString(input.conversionActionId, "conversion_action_id", /^[0-9]+$/, 32);
  return {
    verifiedResultId, verifiedRecordId, gclid, amountUnscaled, amountScale: input.amountScale as number,
    currency, eventTimestamp, operatingAccountId, conversionActionId,
  };
}

function expandJsonNumber(value: string, scale: number): bigint | undefined {
  const match = /^([0-9]+)(?:\.([0-9]+))?(?:e([+-]?[0-9]+))?$/i.exec(value);
  if (!match) return undefined;
  const whole = match[1]!;
  const fraction = match[2] ?? "";
  const exponent = Number.parseInt(match[3] ?? "0", 10);
  if (!Number.isSafeInteger(exponent)) return undefined;
  const decimalPlaces = fraction.length - exponent;
  const digits = BigInt(`${whole}${fraction}`);
  if (decimalPlaces === scale) return digits;
  if (decimalPlaces < scale) return digits * (10n ** BigInt(scale - decimalPlaces));
  const divisor = 10n ** BigInt(decimalPlaces - scale);
  return digits % divisor === 0n ? digits / divisor : undefined;
}

/** Convert the contract integer+scale money shape to a JSON number without rounding. */
export function exactGoogleConversionValue(amountUnscaled: string, amountScale: number): number {
  if (!/^(0|[1-9][0-9]*)$/.test(amountUnscaled) || !Number.isInteger(amountScale)
    || amountScale < 0 || amountScale > 18) throw new Error("google_conversion_money_invalid");
  const padded = amountUnscaled.padStart(amountScale + 1, "0");
  const decimal = amountScale === 0
    ? padded
    : `${padded.slice(0, -amountScale)}.${padded.slice(-amountScale)}`.replace(/\.0+$/, "")
      .replace(/(\.[0-9]*?)0+$/, "$1");
  const numeric = Number(decimal);
  const serialized = JSON.stringify(numeric);
  if (!Number.isFinite(numeric) || typeof serialized !== "string"
    || expandJsonNumber(serialized, amountScale) !== BigInt(amountUnscaled)) {
    throw new Error("google_conversion_money_precision_loss");
  }
  return numeric;
}

export function googleConversionTransactionId(verifiedResultId: string): string {
  boundedString(verifiedResultId, "verified_result_id", /^[A-Za-z0-9._:-]+$/);
  return `openmasu_${createHash("sha256")
    .update(`openmasu:google-data-manager:v1:${verifiedResultId}`, "utf8").digest("hex")}`;
}

export function buildGoogleDataManagerIngestRequest(value: unknown): PreparedGoogleConversion {
  const input = normalizeGoogleConversionEligibility(value);
  const transactionId = googleConversionTransactionId(input.verifiedResultId);
  const request: GoogleDataManagerRequest = {
    destinations: [{
      operatingAccount: { accountType: "GOOGLE_ADS", accountId: input.operatingAccountId },
      productDestinationId: input.conversionActionId,
    }],
    events: [{
      adIdentifiers: { gclid: input.gclid },
      conversionValue: exactGoogleConversionValue(input.amountUnscaled, input.amountScale),
      currency: input.currency,
      eventTimestamp: input.eventTimestamp,
      transactionId,
      eventSource: "APP",
    }],
  };
  return { transactionId, request, body: Buffer.from(JSON.stringify(request), "utf8") };
}

function checkedBaseUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("google_data_manager_endpoint_invalid");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("google_data_manager_endpoint_https_required");
  }
  if (!loopback && url.hostname !== "datamanager.googleapis.com") {
    throw new Error("google_data_manager_endpoint_host_forbidden");
  }
  return url;
}

function transport(config: GoogleDataManagerTransport): Required<Pick<GoogleDataManagerTransport,
"accessToken" | "fetch" | "maximumRequestBytes" | "maximumResponseBytes" | "timeoutMilliseconds">> & { base: URL } {
  if (typeof config.accessToken !== "string" || config.accessToken.length < 1
    || Buffer.byteLength(config.accessToken, "utf8") > 64 * 1024) throw new Error("google_data_manager_access_token_invalid");
  const positive = (value: number | undefined, fallback: number, label: string): number => {
    const result = value ?? fallback;
    if (!Number.isInteger(result) || result < 1) throw new Error(`google_data_manager_${label}_invalid`);
    return result;
  };
  return {
    accessToken: config.accessToken,
    fetch: config.fetch ?? fetch,
    base: checkedBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL),
    maximumRequestBytes: positive(config.maximumRequestBytes, DEFAULT_MAX_REQUEST_BYTES, "maximum_request_bytes"),
    maximumResponseBytes: positive(config.maximumResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, "maximum_response_bytes"),
    timeoutMilliseconds: positive(config.timeoutMilliseconds, 10_000, "timeout"),
  };
}

async function boundedBody(response: Response, maximumBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const parts: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const part = Buffer.from(value);
      length += part.length;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error("response_too_large");
      }
      parts.push(part);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(parts, length);
}

function safeJson(body: Buffer): JsonObject | undefined {
  try {
    return object(JSON.parse(body.toString("utf8")), "invalid");
  } catch {
    return undefined;
  }
}

function httpFailure(status: number): GoogleDeliveryResult | undefined {
  if (status >= 300 && status < 400) return { outcome: "terminal", reason: "redirect_rejected", httpStatus: status };
  if (status === 429) return { outcome: "retry", reason: "rate_limited", httpStatus: status };
  if (status >= 500) return { outcome: "retry", reason: "provider_unavailable", httpStatus: status };
  if (status >= 400) return { outcome: "terminal", reason: "provider_rejected", httpStatus: status };
  return undefined;
}

export async function sendGoogleDataManagerEvent(
  prepared: PreparedGoogleConversion,
  config: GoogleDataManagerTransport,
): Promise<GoogleDeliveryResult> {
  const options = transport(config);
  if (!Buffer.isBuffer(prepared.body) || prepared.body.length < 2
    || prepared.body.length > options.maximumRequestBytes) throw new Error("google_data_manager_request_size_invalid");
  let response: Response;
  try {
    response = await options.fetch(new URL("/v1/events:ingest", options.base), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.accessToken}`,
        "content-type": "application/json",
      },
      body: new Uint8Array(prepared.body),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMilliseconds),
    });
  } catch {
    return { outcome: "retry", reason: "transport_error" };
  }
  const failed = httpFailure(response.status);
  if (failed) return failed.outcome === "accepted"
    ? { outcome: "retry", reason: "response_invalid", httpStatus: response.status }
    : failed;
  let body: Buffer;
  try {
    body = await boundedBody(response, options.maximumResponseBytes);
  } catch {
    return { outcome: "retry", reason: "response_too_large", httpStatus: response.status };
  }
  if (response.status < 200 || response.status >= 300) {
    return { outcome: "terminal", reason: "provider_rejected", httpStatus: response.status };
  }
  const parsed = safeJson(body);
  if (!parsed || typeof parsed.requestId !== "string" || !REQUEST_ID.test(parsed.requestId)) {
    return { outcome: "retry", reason: "response_invalid", httpStatus: response.status };
  }
  return { outcome: "accepted", requestId: parsed.requestId, httpStatus: response.status };
}

function diagnosticCounts(value: unknown, member: "errorCounts" | "warningCounts"): readonly SafeDiagnosticCount[] {
  if (value === undefined) return [];
  const info = object(value, "google_data_manager_diagnostic_invalid");
  const rows = info[member];
  if (rows === undefined) return [];
  if (!Array.isArray(rows) || rows.length > 64) throw new Error("google_data_manager_diagnostic_invalid");
  return rows.map((row) => {
    const item = object(row, "google_data_manager_diagnostic_invalid");
    if (typeof item.reason !== "string" || !SAFE_DIAGNOSTIC_REASON.test(item.reason)
      || typeof item.recordCount !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(item.recordCount)) {
      throw new Error("google_data_manager_diagnostic_invalid");
    }
    return { reason: item.reason, recordCount: item.recordCount };
  });
}

export function parseGoogleDataManagerRequestStatus(value: unknown): Exclude<GoogleRequestStatusResult,
{ outcome: "retry" } | { outcome: "terminal" }> {
  const response = object(value, "google_data_manager_status_invalid");
  strictKeys(response, ["requestStatusPerDestination"]);
  if (!Array.isArray(response.requestStatusPerDestination)
    || response.requestStatusPerDestination.length !== 1) throw new Error("google_data_manager_status_invalid");
  const destination = object(response.requestStatusPerDestination[0], "google_data_manager_status_invalid");
  const status = exactEnum(destination.requestStatus,
    ["PROCESSING", "SUCCESS", "PARTIAL_SUCCESS", "FAILED"] as const, "request_status");
  return {
    outcome: "status",
    status: status === "PROCESSING" ? "processing" : status === "SUCCESS" ? "success"
      : status === "PARTIAL_SUCCESS" ? "partial_success" : "failure",
    errors: diagnosticCounts(destination.errorInfo, "errorCounts"),
    warnings: diagnosticCounts(destination.warningInfo, "warningCounts"),
  };
}

export async function retrieveGoogleDataManagerRequestStatus(
  requestId: string,
  config: GoogleDataManagerTransport,
): Promise<GoogleRequestStatusResult> {
  if (!REQUEST_ID.test(requestId)) throw new Error("google_data_manager_request_id_invalid");
  const options = transport(config);
  const url = new URL("/v1/requestStatus:retrieve", options.base);
  url.searchParams.set("requestId", requestId);
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${options.accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMilliseconds),
    });
  } catch {
    return { outcome: "retry", reason: "transport_error" };
  }
  const failed = httpFailure(response.status);
  if (failed) return failed.outcome === "accepted"
    ? { outcome: "retry", reason: "response_invalid", httpStatus: response.status }
    : failed;
  let body: Buffer;
  try {
    body = await boundedBody(response, options.maximumResponseBytes);
  } catch {
    return { outcome: "retry", reason: "response_too_large", httpStatus: response.status };
  }
  const parsed = safeJson(body);
  if (!parsed) return { outcome: "retry", reason: "response_invalid", httpStatus: response.status };
  try {
    return parseGoogleDataManagerRequestStatus(parsed);
  } catch {
    return { outcome: "retry", reason: "response_invalid", httpStatus: response.status };
  }
}

/**
 * Google documents diagnostics as delayed: begin after 30 minutes, multiply
 * subsequent waits by 1.3, cap each wait at 60 minutes, and stop after 24 hours.
 */
export function googleDiagnosticPollPlan(input: {
  readonly pollAttempt: number;
  readonly acceptedAt: string;
  readonly now: string;
}): Readonly<{ outcome: "poll_after"; delayMilliseconds: number }> | Readonly<{ outcome: "expired" }> {
  if (!Number.isInteger(input.pollAttempt) || input.pollAttempt < 0) {
    throw new Error("google_data_manager_poll_attempt_invalid");
  }
  const accepted = Date.parse(input.acceptedAt);
  const now = Date.parse(input.now);
  if (!Number.isFinite(accepted) || !Number.isFinite(now) || now < accepted) {
    throw new Error("google_data_manager_poll_time_invalid");
  }
  if (now - accepted >= 24 * 60 * 60 * 1_000) return { outcome: "expired" };
  return {
    outcome: "poll_after",
    delayMilliseconds: Math.min(60 * 60 * 1_000,
      Math.round(30 * 60 * 1_000 * (1.3 ** input.pollAttempt))),
  };
}
