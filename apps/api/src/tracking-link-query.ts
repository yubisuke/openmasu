import { createHmac, timingSafeEqual } from "node:crypto";

export type TrackingLinkFilters = Readonly<{
  status?: "active" | "paused" | "archived";
  campaign_id?: string;
  slug?: string;
  limit: number;
}>;
export type TrackingLinkPosition = Readonly<{ created_at: string; tracking_link_id: string }>;
export type TrackingLinkQuery = TrackingLinkFilters & Readonly<{
  cursor?: string;
}>;
type Cursor = Readonly<{
  version: 1; tenant_id: string; app_id: string; filters: TrackingLinkFilters;
  state_sequence: string; after: TrackingLinkPosition;
}>;

export class TrackingLinkQueryError extends Error {
  constructor(readonly code: string, readonly statusCode = 400) { super(code); }
}

export function parseTrackingLinkQuery(params: URLSearchParams, allowAppId = false): TrackingLinkQuery {
  const allowed = new Set(["status", "campaign_id", "slug", "limit", "cursor", ...(allowAppId ? ["app_id"] : [])]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) throw new TrackingLinkQueryError("tracking_link_query_invalid");
  }
  const status = params.get("status") || undefined;
  const campaign = params.get("campaign_id") || undefined;
  const slug = params.get("slug") || undefined;
  const limitValue = params.get("limit") || "200";
  const limit = Number(limitValue);
  if (status && !["active", "paused", "archived"].includes(status)
    || campaign && !/^[A-Za-z0-9._:-]{1,128}$/.test(campaign)
    || slug && !/^[A-Za-z0-9_-]{12,64}$/.test(slug)
    || !/^[1-9][0-9]{0,2}$/.test(limitValue) || limit > 200) {
    throw new TrackingLinkQueryError("tracking_link_query_invalid");
  }
  const cursor = params.get("cursor") || undefined;
  if (cursor && (cursor.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor))) {
    throw new TrackingLinkQueryError("tracking_link_cursor_invalid");
  }
  return { ...(status ? { status: status as TrackingLinkFilters["status"] } : {}),
    ...(campaign ? { campaign_id: campaign } : {}), ...(slug ? { slug } : {}), limit,
    ...(cursor ? { cursor } : {}) };
}

export function trackingLinkFilters(query: TrackingLinkQuery): TrackingLinkFilters {
  return { ...(query.status ? { status: query.status } : {}),
    ...(query.campaign_id ? { campaign_id: query.campaign_id } : {}),
    ...(query.slug ? { slug: query.slug } : {}), limit: query.limit };
}

function signature(body: string, key?: string): Buffer {
  if (!key) throw new TrackingLinkQueryError("tracking_link_cursor_unavailable", 503);
  return createHmac("sha256", key).update("openmasu:tracking-link-list:v1\0").update(body).digest();
}

export function encodeTrackingLinkCursor(cursor: Cursor, key?: string): string {
  const body = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return `${body}.${signature(body, key).toString("base64url")}`;
}

export function decodeTrackingLinkCursor(query: TrackingLinkQuery, tenantId: string, appId: string, key?: string): Cursor | undefined {
  if (!query.cursor) return undefined;
  const [body, signed] = query.cursor.split(".");
  const expected = signature(body, key), actual = Buffer.from(signed ?? "", "base64url");
  if (actual.toString("base64url") !== signed || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new TrackingLinkQueryError("tracking_link_cursor_invalid");
  try {
    const value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Cursor;
    if (value.version !== 1 || value.tenant_id !== tenantId || value.app_id !== appId
      || JSON.stringify(value.filters) !== JSON.stringify(trackingLinkFilters(query))
      || !/^(0|[1-9][0-9]{0,18})$/.test(value.state_sequence)
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.after.tracking_link_id)
      || new Date(value.after.created_at).toISOString() !== value.after.created_at) throw new Error();
    return value;
  } catch { throw new TrackingLinkQueryError("tracking_link_cursor_invalid"); }
}

export function trackingLinkPageUrl(appId: string, query: TrackingLinkQuery, cursor: string): string {
  const params = new URLSearchParams(Object.entries(trackingLinkFilters(query)).map(([key, value]) => [key, String(value)]));
  params.set("cursor", cursor);
  return `/dashboard/apps/${encodeURIComponent(appId)}/tracking-links?${params}`;
}
