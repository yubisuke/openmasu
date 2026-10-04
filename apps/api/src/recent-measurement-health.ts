import type { PoolClient } from "pg";
import { MEASUREMENT_EVENTS, MEASUREMENT_PRODUCERS, MEASUREMENT_SDK_VERSIONS,
  measurementGroupLimit, SDK_POST_PROCESSING_PENDING_REASON, type MeasurementClasses } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import type { RecentMeasurementHealth, ReceiptCounts } from "./measurement-notices.js";

export type MeasurementWindowHours = 1 | 24 | 168;
export class MeasurementHealthQueryError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: string) { super(code); }
}
export function parseMeasurementWindow(params: URLSearchParams): MeasurementWindowHours {
  if ([...params.keys()].some(key => key !== "window_hours")) throw new MeasurementHealthQueryError("unknown_health_filter");
  const hours = params.getAll("window_hours");
  if (hours.length > 1 || hours.length === 1 && !["1", "24", "168"].includes(hours[0]!)) {
    throw new MeasurementHealthQueryError("health_window_invalid");
  }
  return Number(hours[0] ?? "24") as MeasurementWindowHours;
}

type GroupRow = MeasurementClasses & Record<`current_${keyof ReceiptCounts}` | `previous_${keyof ReceiptCounts}`, string | null>;
const snapshotAt = "date_trunc('milliseconds', transaction_timestamp())";
const timestamp = (sql: string) => `to_char((${sql}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export async function recentMeasurementGroups(client: PoolClient, identity: AppAdminIdentity, hours: MeasurementWindowHours): Promise<
  Pick<RecentMeasurementHealth, "groups" | "pending_groups">> {
  const args = [identity.tenantId, identity.appId, hours, [...MEASUREMENT_EVENTS], [...MEASUREMENT_PRODUCERS], [...MEASUREMENT_SDK_VERSIONS]];
  const classes = (event: string, producer: string, version: string) => `
    CASE WHEN ${event}=ANY($4::text[]) THEN ${event} ELSE 'other' END AS event_name,
    CASE WHEN ${producer}=ANY($5::text[]) THEN ${producer} ELSE 'other' END AS producer,
    CASE WHEN ${producer} IN ('sdk-android','sdk-ios') AND ${version}=ANY($6::text[])
      THEN ${version} ELSE 'other' END AS producer_version`;
  const rowCounts = (period: "current" | "previous") => {
    const when = period === "current" ? `received_at_ts >= ${snapshotAt}-$3::int*interval '1 hour'`
      : `received_at_ts < ${snapshotAt}-$3::int*interval '1 hour'`;
    return [
      `count(*) FILTER (WHERE ${when} AND ingestion_status='accepted' AND duplicate_resolution<>'duplicate_delivery')::text AS ${period}_accepted`,
      `count(*) FILTER (WHERE ${when} AND ingestion_status='rejected')::text AS ${period}_rejected`,
      `count(*) FILTER (WHERE ${when} AND ingestion_status='accepted' AND duplicate_resolution='duplicate_delivery')::text AS ${period}_duplicate`,
      `count(*) FILTER (WHERE ${when} AND timeliness='late')::text AS ${period}_late`,
      `count(*) FILTER (WHERE ${when} AND metadata_missing)::text AS ${period}_metadata_not_recorded`,
      `${timestamp(`max(received_at_ts) FILTER (WHERE ${when})`)} AS ${period}_latest_received_at`,
    ].join(",");
  };
  const deliveries = await client.query<GroupRow>(`WITH classified AS (
    SELECT ${classes("diagnostic_event_name", "diagnostic_producer", "diagnostic_producer_version")},
      received_at_ts, ingestion_status, duplicate_resolution, timeliness,
      diagnostic_event_name IS NULL OR diagnostic_producer IS NULL OR diagnostic_producer_version IS NULL AS metadata_missing
    FROM ledger.event_deliveries WHERE tenant_id=$1 AND app_id=$2
      AND received_at_ts >= ${snapshotAt}-($3::int*2)*interval '1 hour'
      AND received_at_ts < ${snapshotAt}
  ) SELECT event_name,producer,producer_version,${rowCounts("current")},${rowCounts("previous")}
    FROM classified GROUP BY event_name,producer,producer_version ORDER BY producer,producer_version,event_name
    LIMIT ${measurementGroupLimit}`, args);
  const pending = await client.query<RecentMeasurementHealth["pending_groups"][number]>(`WITH classified AS (
    SELECT ${classes("g->>'event_name'", "batch.producer", "g->>'producer_version'")},
      CASE WHEN g->>'event_count' ~ '^([1-9]|[1-9][0-9]|100)$' THEN (g->>'event_count')::int ELSE 0 END AS events,
      batch.received_at, current_batch.status='processed' AS post_processing
    FROM ledger.ingest_batches AS batch
    JOIN ledger.ingest_batches_current AS current_batch USING (ingest_batch_id,tenant_id,app_id)
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_array_length(batch.diagnostic_groups)>0
      THEN batch.diagnostic_groups ELSE jsonb_build_array(jsonb_build_object('event_count',batch.event_count)) END) AS g
    WHERE batch.tenant_id=$1 AND batch.app_id=$2
      AND (current_batch.status='pending' OR (current_batch.status='processed' AND current_batch.reason_code=$7))
      AND control.canonical_timestamp_value(batch.received_at) >= ${snapshotAt}-$3::int*interval '1 hour'
      AND control.canonical_timestamp_value(batch.received_at) < ${snapshotAt}
  ) SELECT event_name,producer,producer_version,sum(events)::text AS pending,
    coalesce(sum(events) FILTER (WHERE post_processing),0)::text AS post_processing_pending,
    ${timestamp("min(control.canonical_timestamp_value(received_at))")} AS oldest_received_at
    FROM classified GROUP BY event_name,producer,producer_version ORDER BY producer,producer_version,event_name
    LIMIT ${measurementGroupLimit}`, [...args, SDK_POST_PROCESSING_PENDING_REASON]);
  const counts = (row: GroupRow, period: "current" | "previous"): ReceiptCounts => ({
    accepted: row[`${period}_accepted`]!, rejected: row[`${period}_rejected`]!, duplicate: row[`${period}_duplicate`]!,
    late: row[`${period}_late`]!, metadata_not_recorded: row[`${period}_metadata_not_recorded`]!,
    latest_received_at: row[`${period}_latest_received_at`],
  });
  return { groups: deliveries.rows.map(row => ({ event_name: row.event_name, producer: row.producer,
    producer_version: row.producer_version, current: counts(row, "current"), previous: counts(row, "previous") })),
    pending_groups: pending.rows };
}
