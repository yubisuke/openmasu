import type { IncomingMessage } from "node:http";
import { type TrackingLinkRecord } from "./tracking-links.js";

export function sourceKey(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

export function dashboardAppId(pathname: string): string | undefined {
  const match = /^\/dashboard\/apps\/([^/]+)(?:\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

export function adminAppId(pathname: string): string | undefined {
  const match = /^\/v1\/admin\/apps\/([^/]+)(?:\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

export function decodedPathPart(pathname: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(pathname);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]); } catch { return undefined; }
}

export function trackingLinkAction(pathname: string): { trackingLinkId: string; status: "paused" | "archived" } | undefined {
  const match = /\/tracking-links\/([^/]+)\/(pause|archive)$/.exec(pathname);
  if (!match) return undefined;
  try {
    return { trackingLinkId: decodeURIComponent(match[1]), status: match[2] === "pause" ? "paused" : "archived" };
  } catch { return undefined; }
}

export function sdkKeyId(pathname: string): string | undefined {
  return decodedPathPart(pathname, /\/sdk-keys\/([^/]+)\/retire$/);
}

export function serverKeyId(pathname: string): string | undefined {
  return decodedPathPart(pathname, /\/server-keys\/([^/]+)\/retire$/);
}

export function operatorWebhookDestinationId(pathname: string): string | undefined {
  return decodedPathPart(pathname, /\/operator-webhooks\/([^/]+)\/disable$/);
}

export function operatorBulkExportDestinationId(pathname: string): string | undefined {
  return decodedPathPart(pathname, /\/operator-bulk-exports\/([^/]+)\/disable$/);
}

export function metricScheduleId(pathname: string): string | undefined {
  return decodedPathPart(pathname, /\/metric-schedules\/([^/]+)\/(?:disable|preview-replacement|replace)$/);
}

export function jsonFormValue(body: URLSearchParams, name: string): unknown {
  const value = body.get(name);
  if (value === null || value.trim() === "") throw new Error(`${name}_required`);
  return JSON.parse(value);
}

export function publicReason(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  return /^[a-z0-9_:-]{1,128}$/.test(message) ? message : fallback;
}

export function measurementLink(baseUrl: string, slug: string): string {
  return `${baseUrl.replace(/\/$/, "")}/r/${encodeURIComponent(slug)}`;
}

export function listedTrackingLink(baseUrl: string, link: TrackingLinkRecord): TrackingLinkRecord & { readonly measurement_url: string } {
  return { ...link, measurement_url: measurementLink(baseUrl, link.slug) };
}
