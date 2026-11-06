import type { Pool } from "pg";
import { acquirePrivacyTenantSessionReadFence } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";

export type SubscriptionQuery = { date_from: string; date_to: string; watermark_at_most: string };
export class SubscriptionReportError extends Error {
  constructor(readonly code: string, readonly statusCode = 400) { super(code); }
}
export function parseSubscriptionQuery(params: URLSearchParams): SubscriptionQuery {
  const keys = ["date_from", "date_to", "watermark_at_most"];
  if ([...params.keys()].some(key => !keys.includes(key)) || keys.some(key => params.getAll(key).length !== 1)) {
    throw new SubscriptionReportError("subscription_filters_invalid");
  }
  const from = params.get("date_from")!, to = params.get("date_to")!, cutoff = params.get("watermark_at_most")!;
  const day = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
  if (!day(from) || !day(to) || from >= to || Date.parse(to) - Date.parse(from) > 31 * 86400000) {
    throw new SubscriptionReportError("subscription_date_range_invalid");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cutoff)
    || !Number.isFinite(Date.parse(cutoff)) || new Date(cutoff).toISOString() !== cutoff) {
    throw new SubscriptionReportError("subscription_watermark_invalid");
  }
  return { date_from: from, date_to: to, watermark_at_most: cutoff };
}

/** Internal evidence only. Identifiers never cross the aggregate response boundary. */
export type SubscriptionEvidence = {
  kind: "notification" | "observation" | "renewal";
  series: string | null; event_key: string; event_kind: string;
  event_at: string; recorded_at: string; bound: boolean;
  state: string | null; expiry_at: string | null;
  requested_at?: string | null;
};
const states = ["active", "canceled", "expired", "in_grace_period", "on_hold", "paused", "pending", "pending_purchase_canceled"];
const safeState = (state: string | null) => {
  const name = state?.replace(/^subscription_state_/, "");
  return name && states.includes(name) ? name : "unknown";
};
const later = (current: string | null, next: string): string => current === null || next > current ? next : current;

export function projectSubscriptions(rows: readonly SubscriptionEvidence[], query: SubscriptionQuery) {
  if (rows.length > 10000) throw new SubscriptionReportError("subscription_source_limit", 413);
  const daily = new Map<string, { date: string; verified_renewals: number; observed_expiries: number; notification_signals: number; unknown_series_signals: number }>();
  for (let time = Date.parse(query.date_from); time < Date.parse(query.date_to); time += 86400000) {
    const date = new Date(time).toISOString().slice(0, 10);
    daily.set(date, { date, verified_renewals: 0, observed_expiries: 0, notification_signals: 0, unknown_series_signals: 0 });
  }
  const latest = new Map<string, { state: string; at: string; requested: string }>();
  const seen = new Set<string>(), expiries = new Map<string, { at: string | null; requested: string }>();
  let unknownObservations = 0, lastReadback: string | null = null, lastNotification: string | null = null, lastReceipt: string | null = null;
  for (const row of rows) {
    if (row.recorded_at > query.watermark_at_most) continue;
    if (row.kind === "notification") {
      lastNotification = later(lastNotification, row.event_at);
      lastReceipt = later(lastReceipt, row.recorded_at);
    }
    const key = JSON.stringify([row.kind, row.event_key]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (row.kind === "notification") {
      const day = daily.get(row.event_at.slice(0, 10));
      if (day) { day.notification_signals++; if (!row.bound) day.unknown_series_signals++; }
    } else if (row.kind === "renewal") {
      if (row.bound) { const day = daily.get(row.event_at.slice(0, 10)); if (day) day.verified_renewals++; }
    } else {
      lastReadback = later(lastReadback, row.event_at);
      if (!row.bound || !row.series) { unknownObservations++; continue; }
      const state = safeState(row.state), prior = latest.get(row.series), requested = row.requested_at ?? row.event_at;
      if (!prior || requested > prior.requested) latest.set(row.series, { state, at: row.event_at, requested });
      else if (requested === prior.requested) latest.set(row.series, {
        state: state === prior.state ? state : "unknown", at: later(prior.at, row.event_at), requested });
      if (state === "expired" && row.expiry_at && row.expiry_at <= row.event_at) {
        const priorExpiry = expiries.get(row.series);
        if (!priorExpiry || requested > priorExpiry.requested) expiries.set(row.series, { at: row.expiry_at, requested });
        else if (requested === priorExpiry.requested && row.expiry_at !== priorExpiry.at) expiries.set(row.series, { at: null, requested });
      }
    }
  }
  for (const expiry of expiries.values()) {
    const day = expiry.at && daily.get(expiry.at.slice(0, 10)); if (day) day.observed_expiries++;
  }
  const grouped = new Map<string, { state: string; series_count: number; oldest_observed_at: string; newest_observed_at: string }>();
  for (const row of latest.values()) {
    const group = grouped.get(row.state) ?? { state: row.state, series_count: 0, oldest_observed_at: row.at, newest_observed_at: row.at };
    group.series_count++;
    if (row.at < group.oldest_observed_at) group.oldest_observed_at = row.at;
    if (row.at > group.newest_observed_at) group.newest_observed_at = row.at;
    grouped.set(row.state, group);
  }
  return { provider: "google_play" as const, meaning: "last_observed_not_entitlement" as const,
    privacy: "current" as const, completeness: "unknown" as const,
    selection: { ...query, time_zone: "UTC" }, daily: [...daily.values()],
    last_observed_states: [...grouped.values()].sort((a, b) => a.state.localeCompare(b.state, "en")),
    unknown_series_observations: unknownObservations,
    evidence_times: { last_notification_occurred_at: lastNotification, last_notification_received_at: lastReceipt, last_readback_observed_at: lastReadback } };
}
export type SubscriptionReport = ReturnType<typeof projectSubscriptions>;

// Existing verified initial purchases are the protected token-to-series binding.
// No provider/token information is returned by the public projection, and no new
// materialized state needs separate deletion or restore-reapplication machinery.
const evidenceSql = `WITH bindings AS MATERIALIZED (
  SELECT result.token_digest,result.decided_at,
    (source.payload_lifecycle_status='available' AND settled.payload_lifecycle_status='available') AS retained
  FROM ledger.google_play_purchase_verification_results result
  JOIN ledger.raw_records_current source ON source.tenant_id=result.tenant_id AND source.app_id=result.app_id AND source.record_id=result.subject_record_id
  JOIN ledger.raw_records_current settled ON settled.tenant_id=result.tenant_id AND settled.app_id=result.app_id AND settled.record_id=result.verified_record_id
  WHERE result.tenant_id=$1 AND result.app_id=$2 AND result.verdict='verified' AND result.purchase_kind='subscription_initial'
), facts AS (
  SELECT fact.*,coalesce(fact.subject_digest,notification.subject_digest) AS series_digest,binding.decided_at AS bound_at
  FROM ledger.commerce_lifecycle_facts fact
  LEFT JOIN ledger.commerce_lifecycle_facts notification ON notification.tenant_id=fact.tenant_id AND notification.app_id=fact.app_id
    AND notification.provider=fact.provider AND notification.notification_digest=fact.notification_digest
    AND notification.event_kind NOT IN ('subscription_state_verified','readback_failed')
  LEFT JOIN bindings binding ON binding.token_digest=coalesce(fact.subject_digest,notification.subject_digest)
  WHERE fact.tenant_id=$1 AND fact.app_id=$2 AND fact.provider='google_play' AND fact.recorded_at<=$3
    AND (binding.retained IS NULL OR binding.retained)
    AND NOT EXISTS (SELECT 1 FROM ledger.privacy_requests deletion WHERE deletion.tenant_id=$1
      AND deletion.requested_at>=fact.recorded_at AND (deletion.artifact->>'deletion_scope'='tenant'
        OR (deletion.app_id=$2 AND deletion.artifact->>'deletion_scope'='app')))
), evidence AS (
  SELECT CASE WHEN event_kind='subscription_state_verified' THEN 'observation' ELSE 'notification' END AS kind,
    series_digest AS series,
    CASE WHEN event_kind='subscription_state_verified' THEN lifecycle_fact_id::text
      ELSE jsonb_build_array(series_digest,event_kind,effective_at)::text END AS event_key,
    event_kind,effective_at::text AS event_at,recorded_at::text,
    coalesce(bound_at<=$3 AND (event_kind<>'subscription_state_verified' OR artifact->'subscription_observation'->>'binding'='token'),false) AS bound,
    subscription_state AS state,artifact->'subscription_observation'->>'expiry_at' AS expiry_at,
    artifact->'subscription_observation'->>'requested_at' AS requested_at
  FROM facts WHERE event_kind LIKE 'subscription_%'
  UNION ALL
  SELECT 'renewal',result.token_digest,result.verified_record_id::text,'subscription_renewal',
    purchase.occurred_at::text,result.decided_at::text,true,NULL,NULL,NULL
  FROM ledger.google_play_purchase_verification_results result
  JOIN bindings binding ON binding.token_digest=result.token_digest AND binding.retained AND binding.decided_at<=$3
  JOIN ledger.purchase_facts purchase ON purchase.tenant_id=result.tenant_id AND purchase.app_id=result.app_id AND purchase.record_id=result.verified_record_id
  JOIN ledger.raw_records_current raw ON raw.tenant_id=purchase.tenant_id AND raw.app_id=purchase.app_id AND raw.record_id=purchase.record_id
  WHERE result.tenant_id=$1 AND result.app_id=$2 AND result.verdict='verified' AND result.purchase_kind='subscription_renewal'
    AND result.decided_at<=$3 AND raw.received_at<=$3 AND raw.payload_lifecycle_status='available'
)
SELECT * FROM evidence LIMIT 10001`;

export async function subscriptionReport(pool: Pool, identity: AppAdminIdentity, query: SubscriptionQuery): Promise<SubscriptionReport> {
  const client = await pool.connect();
  let fence: (() => Promise<void>) | undefined, transaction = false, timeout: string | undefined;
  try {
    timeout = (await client.query<{ value: string }>("SELECT current_setting('statement_timeout') AS value")).rows[0].value;
    await client.query("SELECT set_config('statement_timeout','5000',false)");
    fence = await acquirePrivacyTenantSessionReadFence(client, identity.tenantId);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction = true;
    await client.query("SELECT set_config('openmasu.tenant_id',$1,true)", [identity.tenantId]);
    const pending = await client.query<{ pending_count: string }>("SELECT pending_count FROM control.privacy_deletion_backlog()");
    if (pending.rows[0]?.pending_count !== "0") throw new SubscriptionReportError("subscription_privacy_pending", 409);
    const rows = await client.query<SubscriptionEvidence>(evidenceSql, [identity.tenantId, identity.appId, query.watermark_at_most]);
    const report = projectSubscriptions(rows.rows, query);
    await client.query("COMMIT"); transaction = false;
    return report;
  } catch (error) {
    if (error instanceof SubscriptionReportError) throw error;
    throw new SubscriptionReportError("subscription_report_unavailable", 503);
  } finally {
    let failed: Error | undefined;
    try {
      if (transaction) await client.query("ROLLBACK");
      if (fence) await fence();
      if (timeout !== undefined) await client.query("SELECT set_config('statement_timeout',$1,false)", [timeout]);
    } catch { failed = new Error("subscription_report_cleanup_failed"); }
    client.release(failed);
    if (failed) throw new SubscriptionReportError("subscription_report_unavailable", 503);
  }
}
