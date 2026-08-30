import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export type ResolvedWebhookEndpoint = Readonly<{
  url: URL;
  address: string;
  family: 4 | 6;
}>;

export type WebhookLookup = (
  hostname: string,
) => Promise<readonly Readonly<{ address: string; family: number }>[]>;

export const OPERATOR_WEBHOOK_EVENTS = [
  "session_start", "custom_event", "purchase", "refund", "ad_revenue",
] as const;
export type OperatorWebhookEventName = typeof OPERATOR_WEBHOOK_EVENTS[number];

export function normalizeOperatorWebhookEvents(value: unknown): readonly OperatorWebhookEventName[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > OPERATOR_WEBHOOK_EVENTS.length) {
    throw new Error("operator_webhook_events_invalid");
  }
  const result = [...new Set(value.map((entry) => {
    if (typeof entry !== "string" || !OPERATOR_WEBHOOK_EVENTS.includes(entry as OperatorWebhookEventName)) {
      throw new Error("operator_webhook_events_invalid");
    }
    return entry as OperatorWebhookEventName;
  }))].sort((left, right) => left.localeCompare(right, "en"));
  if (result.length !== value.length) throw new Error("operator_webhook_events_invalid");
  return result;
}

export function operatorWebhookReference(secret: Buffer, kind: string, value: string): string {
  if (secret.length < 32 || !/^[a-z_]{3,32}$/.test(kind) || value.length < 1) {
    throw new Error("operator_webhook_reference_input_invalid");
  }
  return createHmac("sha256", secret).update(`openmasu:${kind}:v1\0${value}`, "utf8").digest("hex");
}

export function operatorWebhookSignature(secret: Buffer, body: Buffer): string {
  if (secret.length < 32 || body.length < 1) throw new Error("operator_webhook_signature_input_invalid");
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function exactOrigin(value: string, allowSyntheticLoopback: boolean): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("operator_webhook_allowlist_origin_invalid"); }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || (url.protocol !== "https:" && !(allowSyntheticLoopback && loopback && url.protocol === "http:"))) {
    throw new Error("operator_webhook_allowlist_origin_invalid");
  }
  return url.origin;
}

export function normalizeWebhookAllowlist(
  values: readonly string[],
  allowSyntheticLoopback = false,
): readonly string[] {
  return [...new Set(values.map((value) => exactOrigin(value.trim(), allowSyntheticLoopback)))]
    .sort((left, right) => left.localeCompare(right, "en"));
}

export function normalizeWebhookEndpoint(
  value: unknown,
  allowlist: readonly string[],
  allowSyntheticLoopback = false,
): URL {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > 2048) {
    throw new Error("operator_webhook_endpoint_invalid");
  }
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("operator_webhook_endpoint_invalid"); }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.username || url.password || url.search || url.hash || !url.pathname.startsWith("/")) {
    throw new Error("operator_webhook_endpoint_invalid");
  }
  if (url.protocol !== "https:" && !(allowSyntheticLoopback && loopback && url.protocol === "http:")) {
    throw new Error("operator_webhook_endpoint_https_required");
  }
  const normalizedAllowlist = normalizeWebhookAllowlist(allowlist, allowSyntheticLoopback);
  if (!normalizedAllowlist.includes(url.origin)) throw new Error("operator_webhook_endpoint_not_allowed");
  return url;
}

function publicIpv4(value: string): boolean {
  const parts = value.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function publicIpv6(value: string): boolean {
  const address = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (address === "::" || address === "::1") return false;
  if (address.startsWith("::ffff:")) return publicIpv4(address.slice("::ffff:".length));
  const first = Number.parseInt(address.split(":")[0] || "0", 16);
  if (!Number.isFinite(first)) return false;
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xff00) === 0xff00) return false;
  if (address.startsWith("2001:db8:")) return false;
  return true;
}

export function isPublicWebhookAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? publicIpv4(address) : family === 6 ? publicIpv6(address) : false;
}

const defaultLookup: WebhookLookup = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export async function resolveWebhookEndpoint(
  value: unknown,
  allowlist: readonly string[],
  options: Readonly<{
    allowSyntheticLoopback?: boolean;
    lookup?: WebhookLookup;
    resolutionTimeoutMilliseconds?: number;
  }> = {},
): Promise<ResolvedWebhookEndpoint> {
  const allowSyntheticLoopback = options.allowSyntheticLoopback ?? false;
  const resolutionTimeoutMilliseconds = options.resolutionTimeoutMilliseconds ?? 5_000;
  if (!Number.isSafeInteger(resolutionTimeoutMilliseconds)
    || resolutionTimeoutMilliseconds < 100 || resolutionTimeoutMilliseconds > 30_000) {
    throw new Error("operator_webhook_dns_timeout_invalid");
  }
  const url = normalizeWebhookEndpoint(value, allowlist, allowSyntheticLoopback);
  const literalFamily = isIP(url.hostname.replace(/^\[|\]$/g, ""));
  const addresses = literalFamily
    ? [{ address: url.hostname.replace(/^\[|\]$/g, ""), family: literalFamily }]
    : await new Promise<readonly Readonly<{ address: string; family: number }>[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("operator_webhook_dns_timeout")), resolutionTimeoutMilliseconds);
      void (options.lookup ?? defaultLookup)(url.hostname).then(resolve, reject).finally(() => clearTimeout(timer));
    });
  if (addresses.length < 1) throw new Error("operator_webhook_dns_empty");
  const normalized = addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }));
  if (normalized.some((entry) => ![4, 6].includes(entry.family)
    || (!allowSyntheticLoopback && !isPublicWebhookAddress(entry.address)))) {
    throw new Error("operator_webhook_address_forbidden");
  }
  const selected = normalized.sort((left, right) => left.family - right.family
    || left.address.localeCompare(right.address, "en"))[0]!;
  return { url, address: selected.address, family: selected.family };
}
