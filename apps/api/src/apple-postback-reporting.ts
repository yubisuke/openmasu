import type { Pool } from "pg";
import { acquirePrivacyTenantXactFence, appleObservationValues, type AppleObservation } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import { AttributionReportError, parseAttributionQuery } from "./attribution-reporting.js";

export const appleReportLimits = { source_rows: 100000, days: 366, milliseconds: 5000 } as const;
export type AppleReportQuery = { date_from: string; date_to: string; watermark_at_most: string };
type Platform = "skadnetwork" | "adattributionkit";
type Count = { receipt_date: string; platform: Platform; count: string };
export type ApplePostbackReport = {
  selection: AppleReportQuery & { app_id: string; time_zone: "UTC" };
  privacy: "current"; conversion_schema: "not_recorded"; coverage: "retained_receiver_ledger_only";
  maximum_source_rows: number;
  observations: (Count & AppleObservation & { verification: "verified" | "failed" })[];
  receipts: (Count & { state: "pending" | "processed" | "post_processing_pending" | "failed" | "not_recorded" })[];
  deliveries: (Count & { state: "accepted_unique" | "duplicate_delivery" | "event_id_conflict" | "other_rejection" | "not_recorded" })[];
  quota_rejections: (Count & { reason: "signature_invalid" | "unknown_key" | "development_postback_rejected" | "other" })[];
};
export class AppleReportError extends Error {
  constructor(readonly code: string, readonly statusCode = 400) { super(code); }
}
export function parseAppleReportQuery(params: URLSearchParams): AppleReportQuery {
  if (params.has("time_zone")) throw new AppleReportError("unknown_filter");
  const withZone = new URLSearchParams(params); withZone.set("time_zone", "UTC");
  try {
    const { time_zone: _, ...selection } = parseAttributionQuery(withZone);
    return selection;
  } catch (error) {
    if (error instanceof AttributionReportError) throw new AppleReportError(error.code, error.statusCode);
    throw error;
  }
}

/** Bounded metadata only: never serialize identifiers, signatures, source values or arbitrary extensions. */
export async function applePostbackReport(pool: Pool, identity: AppAdminIdentity, query: AppleReportQuery): Promise<ApplePostbackReport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('openmasu.tenant_id',$1,true)", [identity.tenantId]);
    await client.query("SET LOCAL statement_timeout = '5s'");
    await acquirePrivacyTenantXactFence(client, identity.tenantId, "shared");
    const pending = await client.query<{ pending_count: string }>("SELECT pending_count FROM control.privacy_deletion_backlog()");
    if (pending.rows[0]?.pending_count !== "0") throw new AppleReportError("apple_privacy_pending", 409);
    const values: unknown[] = [identity.tenantId, identity.appId, query.date_from, query.date_to, query.watermark_at_most, appleReportLimits.source_rows + 1];
    const metadata = Object.entries(appleObservationValues).map(([key, vocabulary]) => {
      values.push(vocabulary);
      return `CASE WHEN fact.artifact->'observation'->>'version'='1' AND fact.artifact->'observation'->>'${key}'=ANY($${values.length}::text[])
        THEN fact.artifact->'observation'->>'${key}' ELSE 'not_recorded' END AS ${key}`;
    }).join(",");
    // All fragments below are fixed internal SQL, never request-supplied values or identifiers.
    const time = (column: string) => `${column} >= ($3::date::timestamp AT TIME ZONE 'UTC') AND ${column} < ($4::date::timestamp AT TIME ZONE 'UTC') AND ${column} <= $5::timestamptz`;
    const retained = (column: string) => `NOT EXISTS (SELECT 1 FROM ledger.privacy_requests request
      WHERE request.tenant_id=$1 AND request.status='completed'
        AND (request.artifact->>'deletion_scope'='tenant' OR (request.app_id=$2 AND request.artifact->>'deletion_scope'='app'))
        AND control.canonical_timestamp_value(request.requested_at) >= ${column})`;
    const result = await client.query<Pick<ApplePostbackReport, "observations" | "receipts" | "deliveries" | "quota_rejections"> & { source_counts: number[] }>(
      `WITH receipt_source AS MATERIALIZED (
        SELECT timezone('UTC',control.canonical_timestamp_value(b.received_at))::date::text AS receipt_date,
          CASE b.producer WHEN 'postback:skadnetwork' THEN 'skadnetwork' ELSE 'adattributionkit' END AS platform,
          CASE WHEN b.status='processed' AND b.reason_code='post_processing_pending' THEN 'post_processing_pending'
            WHEN b.status IN ('pending','processed','failed') THEN b.status ELSE 'not_recorded' END AS state
        FROM ledger.ingest_batches_current b
        WHERE b.tenant_id=$1 AND b.app_id=$2 AND b.producer IN ('postback:skadnetwork','postback:adattributionkit')
          AND ${time("control.canonical_timestamp_value(b.received_at)")} AND ${retained("control.canonical_timestamp_value(b.received_at)")}
          AND NOT EXISTS (SELECT 1 FROM ledger.ingest_batch_records member
            JOIN ledger.event_deliveries d ON d.tenant_id=member.tenant_id AND d.app_id=member.app_id AND d.record_id=member.record_id
            LEFT JOIN ledger.raw_records_current own ON own.tenant_id=d.tenant_id AND own.app_id=d.app_id AND own.record_id=d.record_id
            LEFT JOIN ledger.raw_records_current canonical ON canonical.tenant_id=d.tenant_id AND canonical.app_id=d.app_id AND canonical.record_id=d.canonical_record_id
            WHERE member.tenant_id=b.tenant_id AND member.app_id=b.app_id AND member.ingest_batch_id=b.ingest_batch_id
              AND (own.payload_lifecycle_status<>'available' OR canonical.payload_lifecycle_status<>'available'))
        LIMIT $6
      ), delivery_source AS MATERIALIZED (
        SELECT timezone('UTC',d.received_at_ts)::date::text AS receipt_date,
          CASE producer.value WHEN 'postback:skadnetwork' THEN 'skadnetwork' ELSE 'adattributionkit' END AS platform,
          CASE WHEN d.reason_code='event_id_conflict' THEN 'event_id_conflict'
            WHEN d.duplicate_resolution='duplicate_delivery' THEN 'duplicate_delivery'
            WHEN d.ingestion_status='accepted' AND d.duplicate_resolution='unique' THEN 'accepted_unique'
            WHEN d.ingestion_status='rejected' THEN 'other_rejection' ELSE 'not_recorded' END AS state
        FROM ledger.event_deliveries d
        LEFT JOIN ledger.raw_records_current own ON own.tenant_id=d.tenant_id AND own.app_id=d.app_id AND own.record_id=d.record_id
        LEFT JOIN ledger.raw_records_current canonical ON canonical.tenant_id=d.tenant_id AND canonical.app_id=d.app_id AND canonical.record_id=d.canonical_record_id
        LEFT JOIN LATERAL (SELECT min(b.producer) AS value,count(DISTINCT b.producer) AS producers
          FROM ledger.ingest_batch_records member JOIN ledger.ingest_batches b USING (tenant_id,app_id,ingest_batch_id)
          WHERE member.tenant_id=d.tenant_id AND member.app_id=d.app_id AND member.record_id=d.record_id) lineage ON true
        CROSS JOIN LATERAL (SELECT CASE WHEN lineage.producers=1 THEN lineage.value
          WHEN lineage.producers=0 THEN coalesce(own.producer,canonical.producer) END AS value) producer
        WHERE d.tenant_id=$1 AND d.app_id=$2 AND producer.value IN ('postback:skadnetwork','postback:adattributionkit')
          AND (own.record_id IS NULL OR own.payload_lifecycle_status='available')
          AND (canonical.record_id IS NULL OR canonical.payload_lifecycle_status='available')
          AND ${time("d.received_at_ts")} AND ${retained("d.received_at_ts")} LIMIT $6
      ), observation_source AS MATERIALIZED (
        SELECT timezone('UTC',raw.received_at_ts)::date::text AS receipt_date,
          CASE fact.event_name WHEN 'skan_postback' THEN 'skadnetwork' ELSE 'adattributionkit' END AS platform,
          CASE WHEN fact.signature_verified THEN 'verified' ELSE 'failed' END AS verification,${metadata}
        FROM ledger.apple_postback_facts fact JOIN ledger.logical_events logical USING (tenant_id,app_id,logical_event_id)
        JOIN ledger.raw_records_current raw ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
        WHERE fact.tenant_id=$1 AND fact.app_id=$2 AND raw.payload_lifecycle_status='available'
          AND ${time("raw.received_at_ts")} AND ${retained("raw.received_at_ts")} LIMIT $6
      ), quota_source AS MATERIALIZED (
        SELECT timezone('UTC',control.canonical_timestamp_value(a.occurred_at))::date::text AS receipt_date,
          CASE a.actor_ref WHEN 'apple_postback:skadnetwork' THEN 'skadnetwork' ELSE 'adattributionkit' END AS platform,
          CASE WHEN a.reason_code IN ('signature_invalid','unknown_key','development_postback_rejected') THEN a.reason_code ELSE 'other' END AS reason
        FROM ledger.audit_logs a WHERE a.tenant_id=$1 AND a.app_id=$2 AND a.actor_type='apple_postback'
          AND a.action='apple_postback_invalid' AND a.target_scope='postback' AND a.outcome='failed'
          AND a.actor_ref IN ('apple_postback:skadnetwork','apple_postback:adattributionkit')
          AND ${time("control.canonical_timestamp_value(a.occurred_at)")} AND ${retained("control.canonical_timestamp_value(a.occurred_at)")} LIMIT $6
      )
      SELECT ARRAY[(SELECT count(*) FROM receipt_source),(SELECT count(*) FROM delivery_source),
        (SELECT count(*) FROM observation_source),(SELECT count(*) FROM quota_source)]::int[] AS source_counts,
        ${["receipt", "delivery", "observation", "quota"].map((source, index) => `(SELECT coalesce(jsonb_agg(dimensions || jsonb_build_object('count',count) ORDER BY dimensions::text COLLATE "C"),'[]'::jsonb)
          FROM (SELECT to_jsonb(s) AS dimensions,count(*)::text AS count FROM ${source}_source s GROUP BY to_jsonb(s)) grouped)
          AS ${["receipts", "deliveries", "observations", "quota_rejections"][index]}`).join(",")}`,
      values,
    );
    const { source_counts, ...counts } = result.rows[0];
    if (source_counts.some(count => count > appleReportLimits.source_rows)) throw new AppleReportError("apple_source_limit", 413);
    await client.query("COMMIT");
    return { selection: { app_id: identity.appId, time_zone: "UTC", ...query }, privacy: "current", conversion_schema: "not_recorded",
      coverage: "retained_receiver_ledger_only", maximum_source_rows: appleReportLimits.source_rows, ...counts };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof AppleReportError) throw error;
    throw new AppleReportError("apple_report_unavailable", 503);
  } finally { client.release(); }
}
