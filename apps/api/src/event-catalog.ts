import type { Pool, PoolClient } from "pg";
import { withTenant } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import { recordDashboardAuditWithClient } from "./session.js";

const eventKey = /^[a-z][a-z0-9_]{0,63}$/;
export type CatalogLifecycle = "planned" | "active" | "deprecated";
export type EventCatalogEntry = {
  event_key: string; revision: number; display_name: string; meaning: string | null;
  firing_condition: string | null; lifecycle: CatalogLifecycle | null;
  observation_state: "observed" | "not_observed"; observed_count: string | null; last_received_at: string | null;
};
export type EventCatalogQuery = { prefix: string; after: string; limit: number };
export type EventCatalogPage = { data: EventCatalogEntry[]; next_cursor: string | null };
export class EventCatalogError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}

export function parseEventCatalogQuery(params: URLSearchParams): EventCatalogQuery {
  if ([...params.keys()].some(key => !["prefix", "after", "limit"].includes(key) || params.getAll(key).length !== 1)) {
    throw new EventCatalogError("event_catalog_query_invalid");
  }
  const prefix = params.get("prefix") ?? "", after = params.get("after") ?? "", rawLimit = params.get("limit") ?? "50";
  if (prefix !== "" && !eventKey.test(prefix) || after !== "" && !eventKey.test(after)
      || !/^[1-9][0-9]{0,2}$/.test(rawLimit) || Number(rawLimit) > 100) throw new EventCatalogError("event_catalog_query_invalid");
  return { prefix, after, limit: Number(rawLimit) };
}

export function normalizeEventCatalogRevision(body: Record<string, unknown>) {
  const fields = ["event_key", "expected_revision", "display_name", "meaning", "firing_condition", "lifecycle"];
  if (Object.keys(body).some(key => !fields.includes(key)) || typeof body.event_key !== "string" || !eventKey.test(body.event_key)
      || !Number.isSafeInteger(body.expected_revision) || Number(body.expected_revision) < 0 || Number(body.expected_revision) >= 2147483647
      || typeof body.lifecycle !== "string" || !["planned", "active", "deprecated"].includes(body.lifecycle)) throw new EventCatalogError("event_catalog_revision_invalid");
  const text = (key: string, maximum: number): string => {
    const value = body[key];
    if (typeof value !== "string" || value.length > maximum || value.trim().length === 0 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new EventCatalogError("event_catalog_revision_invalid");
    }
    return value;
  };
  return { event_key: body.event_key, expected_revision: Number(body.expected_revision),
    display_name: text("display_name", 120), meaning: text("meaning", 1000), firing_condition: text("firing_condition", 1000),
    lifecycle: body.lifecycle as CatalogLifecycle };
}

// Counts describe retained accepted logical events, not users or complete delivery.
const observations = `SELECT fact.event_key,count(*)::text AS observed_count,max(raw.received_at)::text AS last_received_at
  FROM ledger.custom_event_facts fact JOIN ledger.logical_events event USING (tenant_id,app_id,logical_event_id)
  JOIN ledger.raw_records_current raw USING (tenant_id,app_id,record_id)
  WHERE fact.tenant_id=$1 AND fact.app_id=$2 AND event.record_lifecycle='active'
    AND raw.payload_lifecycle_status='available' AND fact.event_key ~ '^[a-z][a-z0-9_]{0,63}$'`;

export async function listEventCatalog(pool: Pool, identity: AppAdminIdentity, query: EventCatalogQuery): Promise<EventCatalogPage> {
  return withTenant(pool, identity.tenantId, async client => {
    const result = await client.query<EventCatalogEntry>(`WITH observed AS (${observations} GROUP BY fact.event_key),
      catalog AS (SELECT * FROM control.event_catalog_current WHERE tenant_id=$1 AND app_id=$2),
      keys AS (SELECT event_key FROM catalog UNION SELECT event_key FROM observed)
      SELECT keys.event_key,COALESCE(catalog.revision,0) AS revision,COALESCE(catalog.display_name,keys.event_key) AS display_name,
        catalog.meaning,catalog.firing_condition,catalog.lifecycle,
        CASE WHEN observed.observed_count IS NULL THEN 'not_observed' ELSE 'observed' END AS observation_state,
        observed.observed_count,observed.last_received_at
      FROM keys LEFT JOIN catalog USING (event_key) LEFT JOIN observed USING (event_key)
      WHERE starts_with(keys.event_key,$3) AND keys.event_key COLLATE "C">$4 COLLATE "C"
      ORDER BY keys.event_key COLLATE "C" LIMIT $5`, [identity.tenantId, identity.appId, query.prefix, query.after, query.limit + 1]);
    const data = result.rows.slice(0, query.limit);
    return { data, next_cursor: result.rows.length > query.limit ? data.at(-1)!.event_key : null };
  });
}

/** Serialize catalog edits and new schedule admission, never a read-only preview. */
export async function lockEventCatalog(client: PoolClient, identity: AppAdminIdentity): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([identity.tenantId, identity.appId, "metric-schedules"])]);
}

export async function saveEventCatalogRevision(pool: Pool, identity: AppAdminIdentity, body: Record<string, unknown>) {
  const entry = normalizeEventCatalogRevision(body);
  return withTenant(pool, identity.tenantId, async client => {
    await lockEventCatalog(client, identity);
    const current = await client.query<{ revision: number }>(`SELECT revision FROM control.event_catalog_current
      WHERE tenant_id=$1 AND app_id=$2 AND event_key=$3`, [identity.tenantId, identity.appId, entry.event_key]);
    if ((current.rows[0]?.revision ?? 0) !== entry.expected_revision) throw new EventCatalogError("event_catalog_revision_conflict", 409);
    const revision = entry.expected_revision + 1;
    await client.query(`INSERT INTO control.event_catalog_revisions
      (tenant_id,app_id,event_key,revision,display_name,meaning,firing_condition,lifecycle) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [identity.tenantId, identity.appId, entry.event_key, revision, entry.display_name, entry.meaning, entry.firing_condition, entry.lifecycle]);
    await recordDashboardAuditWithClient(client, { tenantId: identity.tenantId, appId: identity.appId, actorRef: `admin_key:${identity.keyId}`,
      action: "event_catalog_revision", targetScope: "app", targetRef: `event-catalog:${entry.event_key}:${revision}`, outcome: "succeeded" });
    const { expected_revision: _expected, ...metadata } = entry;
    return { ...metadata, revision };
  });
}

/** Selected keys are queried directly, independently of the bounded browsing page. */
export async function selectableConversionKeys(client: PoolClient, identity: AppAdminIdentity, selected?: unknown): Promise<string[]> {
  if (selected !== undefined && (!Array.isArray(selected) || selected.length > 50 || selected.some(key => typeof key !== "string" || !eventKey.test(key)))) {
    throw new Error("custom_conversion_event_keys_invalid");
  }
  const keys = selected as string[] | undefined;
  const result = await client.query<{ event_key: string; lifecycle: string | null }>(`WITH observed AS (
      ${observations} AND ($3::text[] IS NULL OR fact.event_key=ANY($3)) GROUP BY fact.event_key),
    catalog AS (SELECT event_key,lifecycle FROM control.event_catalog_current WHERE tenant_id=$1 AND app_id=$2
      AND ($3::text[] IS NULL OR event_key=ANY($3))),
    keys AS (SELECT event_key FROM catalog UNION SELECT event_key FROM observed)
    SELECT keys.event_key,catalog.lifecycle FROM keys LEFT JOIN catalog USING (event_key)
    ${keys ? "" : "WHERE catalog.lifecycle IS DISTINCT FROM 'deprecated'"}
    ORDER BY keys.event_key COLLATE "C" LIMIT $4`, [identity.tenantId, identity.appId, keys ?? null, keys ? 50 : 100]);
  if (keys && result.rows.some(row => row.lifecycle === "deprecated")) throw new Error("custom_conversion_event_key_deprecated");
  return result.rows.map(row => row.event_key);
}

/** Advanced definitions keep their existing admission, but cannot bypass an explicit deprecation. */
export async function rejectDeprecatedConversionKeys(client: PoolClient, identity: AppAdminIdentity, keys: string[]): Promise<void> {
  if (!keys.length) return;
  const deprecated = await client.query(`SELECT 1 FROM control.event_catalog_current WHERE tenant_id=$1 AND app_id=$2
    AND event_key=ANY($3::text[]) AND lifecycle='deprecated' LIMIT 1`, [identity.tenantId, identity.appId, keys]);
  if (deprecated.rowCount) throw new Error("custom_conversion_event_key_deprecated");
}
