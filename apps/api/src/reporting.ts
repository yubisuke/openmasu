import type { Pool } from "pg";
import { withTenant } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import {
  buildDifferenceQuery,
  buildMetricQuery,
  encodeMetricCursor,
  ReportQueryError,
  type GroupingDimension,
  type MetricQuery,
} from "./report-query.js";

type Any = Record<string, any>;
export type ReportFormat = "json" | "csv";

export const metricColumns = [
  "metric_run_id", "metric_name", "metric_definition_version", "policy_versions",
  "input_received_at_watermark", "input_snapshot_id", "data_freshness",
  "value_state", "undefined_reason", "value_unscaled", "value_type",
  "currency", "amount_scale", "ratio_scale", "grouping",
  "rule_bundle_id", "rule_bundle_hash", "aggregation_time_zone", "computed_at",
  "reproducibility_status", "supersedes_metric_run_id", "input_ledger_position",
  "grouping_digest", "superseded",
] as const;

export const differenceColumns = [
  "reconciliation_id", "input_snapshot_id", "external_snapshot_id",
  "difference_reason_code", "difference_reason_version", "matching_keys",
  "candidates", "exclusions", "windows", "joins", "freshness",
  "supersedes_reconciliation_id", "superseded",
] as const;

export type MetricReportRow = {
  readonly metric_run_id: string;
  readonly metric_name: string;
  readonly metric_definition_version: string;
  readonly policy_versions: readonly string[];
  readonly input_received_at_watermark: string;
  readonly input_snapshot_id: string;
  readonly data_freshness: string;
  readonly value_state: "present" | "undefined";
  readonly undefined_reason: string | null;
  readonly value_unscaled?: string;
  readonly value_type: string;
  readonly currency: string | null;
  readonly amount_scale: number | null;
  readonly ratio_scale: number | null;
  readonly grouping: Readonly<Record<string, string>>;
  readonly rule_bundle_id: string;
  readonly rule_bundle_hash: string;
  readonly aggregation_time_zone: string;
  readonly computed_at: string;
  readonly reproducibility_status: string;
  readonly supersedes_metric_run_id: string | null;
  readonly input_ledger_position: string;
  readonly grouping_digest: string;
  readonly superseded: boolean;
};

export type MetricReportPage = {
  readonly data: readonly MetricReportRow[];
  readonly next_cursor?: string;
};

export type DifferenceAuditPage = {
  readonly data: readonly Any[];
};

export type RecordCountRow = {
  readonly metric_name:
    | "daily_click_count"
    | "daily_install_count"
    | "skan_attributed_installs"
    | "skan_conversion_value_distribution"
    | "aak_attributed_installs";
  readonly grouping: Readonly<Record<string, string>>;
  readonly count: string;
};

const recordCountMetricNames = new Set([
  "daily_click_count",
  "daily_install_count",
  "skan_attributed_installs",
  "skan_conversion_value_distribution",
  "aak_attributed_installs",
]);

export function supportsRecordCounts(query: MetricQuery): boolean {
  return query.metricNames === undefined
    || query.metricNames.every((name) => recordCountMetricNames.has(name));
}

function metricRow(artifact: Any, groupingDigest: string, superseded: boolean): MetricReportRow {
  const valueState = artifact.value_state ?? "present";
  if (valueState === "present" && typeof artifact.value_unscaled !== "string") {
    throw new Error(`metric run ${artifact.metric_run_id} has no present value`);
  }
  if (valueState === "undefined" && typeof artifact.undefined_reason !== "string") {
    throw new Error(`metric run ${artifact.metric_run_id} has no undefined reason`);
  }
  return {
    metric_run_id: artifact.metric_run_id,
    metric_name: artifact.metric_name,
    metric_definition_version: artifact.metric_definition_version,
    policy_versions: [
      `rule_bundle:${artifact.rule_bundle_version}`,
      ...(artifact.fx_policy_version ? [`fx:${artifact.fx_policy_version}`] : []),
    ],
    input_received_at_watermark: artifact.input_received_at_watermark,
    input_snapshot_id: artifact.input_snapshot_id,
    data_freshness: artifact.data_freshness,
    value_state: valueState,
    undefined_reason: artifact.undefined_reason ?? null,
    ...(valueState === "present" ? { value_unscaled: artifact.value_unscaled } : {}),
    value_type: artifact.value_type,
    currency: artifact.currency ?? null,
    amount_scale: artifact.amount_scale ?? null,
    ratio_scale: artifact.ratio_scale ?? null,
    grouping: artifact.grouping?.dimensions ?? {},
    rule_bundle_id: artifact.rule_bundle_id,
    rule_bundle_hash: artifact.rule_bundle_hash,
    aggregation_time_zone: artifact.aggregation_time_zone,
    computed_at: artifact.computed_at,
    reproducibility_status: artifact.reproducibility_status,
    supersedes_metric_run_id: artifact.supersedes_metric_run_id ?? null,
    input_ledger_position: artifact.input_ledger_position,
    grouping_digest: groupingDigest,
    superseded,
  };
}

export function csvCell(value: unknown): string {
  const text = value === null || value === undefined
    ? ""
    : typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function encodeCsv(rows: readonly Any[], columns: readonly string[]): string {
  return `${[
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
  ].join("\n")}\n`;
}

export async function metricReport(
  pool: Pool,
  identity: AppAdminIdentity,
  query: MetricQuery,
): Promise<MetricReportPage> {
  const statement = buildMetricQuery(query);
  return withTenant(pool, identity.tenantId, async (client) => {
    const result = await client.query<{ artifact: Any; grouping_digest: string; superseded: boolean }>(
      statement.text,
      [...statement.values],
    );
    const hasNext = result.rows.length > query.limit;
    const rows = result.rows.slice(0, query.limit).map((row) => metricRow(
      row.artifact,
      row.grouping_digest,
      row.superseded,
    ));
    const last = rows.at(-1);
    return {
      data: rows,
      ...(hasNext && last ? {
        next_cursor: encodeMetricCursor({
          metricName: last.metric_name,
          groupingDigest: last.grouping_digest,
          metricRunId: last.metric_run_id,
        }),
      } : {}),
    };
  });
}

export async function differenceAudit(
  pool: Pool,
  identity: AppAdminIdentity,
  query: MetricQuery,
): Promise<DifferenceAuditPage> {
  const statement = buildDifferenceQuery(query);
  return withTenant(pool, identity.tenantId, async (client) => {
    const result = await client.query<{ artifact: Any; superseded: boolean }>(statement.text, [...statement.values]);
    return {
      data: result.rows.slice(0, query.limit).map(({ artifact, superseded }) => ({ ...artifact, superseded })),
    };
  });
}

const dimensionSql: Readonly<Record<GroupingDimension, string>> = {
  campaign_id: "event.campaign_id",
  network: "event.network",
  country: "event.country",
  cohort_date: "event.metric_date",
  metric_date: "event.metric_date",
  attribution_status: "event.attribution_status",
  apple_conversion_bucket: "event.apple_conversion_bucket",
};

function bind(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${values.length}`;
}

export async function recordCounts(
  pool: Pool,
  identity: AppAdminIdentity,
  query: MetricQuery,
): Promise<readonly RecordCountRow[]> {
  if (!query.watermarkAtMost) throw new Error("watermark_required");
  if (!supportsRecordCounts(query)) throw new ReportQueryError("raw_metric_unsupported");
  const values: unknown[] = [query.tenantId, query.appId, query.watermarkAtMost];
  const basePredicates = [
    "logical.tenant_id=$1",
    "logical.app_id=$2",
    "raw.received_at <= $3",
    "raw.payload_lifecycle_status='available'",
  ];
  const eventPredicates: string[] = [];
  const requestedMetricNames = query.metricNames;
  if (requestedMetricNames?.length) {
    eventPredicates.push(`event.metric_name=ANY(${bind(values, requestedMetricNames)}::text[])`);
  }
  for (const [dimension, value] of Object.entries(query.grouping ?? {}) as [GroupingDimension, string][]) {
    eventPredicates.push(`${dimensionSql[dimension]}=${bind(values, value)}`);
  }
  if (query.dateFrom) eventPredicates.push(`event.metric_date >= ${bind(values, query.dateFrom)}`);
  if (query.dateTo) eventPredicates.push(`event.metric_date < ${bind(values, query.dateTo)}`);

  const requestedDimensions = new Set<GroupingDimension>([
    "metric_date",
    ...Object.keys(query.grouping ?? {}) as GroupingDimension[],
  ]);
  if (requestedMetricNames === undefined || requestedMetricNames.includes("skan_conversion_value_distribution")) {
    requestedDimensions.add("apple_conversion_bucket");
  }
  const groupingPairs: string[] = [];
  for (const dimension of requestedDimensions) {
    groupingPairs.push(`'${dimension}'`, dimensionSql[dimension]);
  }
  const groupingExpression = `jsonb_strip_nulls(jsonb_build_object(${groupingPairs.join(",")}))`;
  const sql = `WITH deterministic_event AS (
    SELECT CASE logical.event_name
        WHEN 'click' THEN 'daily_click_count'
        ELSE 'daily_install_count'
      END AS metric_name,
      timezone('UTC', control.canonical_timestamp_value(raw.occurred_at))::date::text AS metric_date,
      CASE WHEN logical.event_name='click' THEN click.campaign_id ELSE install.campaign_id END AS campaign_id,
      CASE WHEN logical.event_name='click' THEN click.network ELSE install.network END AS network,
      CASE WHEN logical.event_name='click' THEN click.country ELSE install.country END AS country,
      CASE WHEN logical.event_name='install' THEN coalesce(attribution.status, 'unattributed') END AS attribution_status,
      NULL::text AS apple_conversion_bucket
    FROM ledger.logical_events AS logical
    JOIN ledger.raw_records_current AS raw
      ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
    LEFT JOIN ledger.click_facts AS click ON click.logical_event_id=logical.logical_event_id
    LEFT JOIN ledger.install_facts AS install ON install.logical_event_id=logical.logical_event_id
    LEFT JOIN LATERAL (
      SELECT candidate.status FROM ledger.attribution_results AS candidate
      WHERE candidate.tenant_id=logical.tenant_id AND candidate.app_id=logical.app_id
        AND candidate.subject_scope='installation_level'
        AND candidate.subject_ref=install.installation_id
        AND candidate.decided_at <= $3
      ORDER BY candidate.decided_at DESC, candidate.attribution_id DESC LIMIT 1
    ) AS attribution ON logical.event_name='install'
    WHERE ${basePredicates.join("\n      AND ")}
      AND logical.event_name IN ('click','install')
  ), apple_event AS (
    SELECT logical.event_name,
      timezone('UTC', control.canonical_timestamp_value(fact.received_at))::date::text AS metric_date,
      NULL::text AS campaign_id,
      NULL::text AS network,
      NULL::text AS country,
      NULL::text AS attribution_status,
      fact.conversion_bucket AS apple_conversion_bucket
    FROM ledger.logical_events AS logical
    JOIN ledger.raw_records_current AS raw
      ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
    JOIN ledger.apple_postback_facts AS fact
      ON fact.tenant_id=logical.tenant_id
     AND fact.app_id=logical.app_id
     AND fact.logical_event_id=logical.logical_event_id
    JOIN LATERAL (
      SELECT candidate.status FROM ledger.attribution_results AS candidate
      WHERE candidate.tenant_id=logical.tenant_id AND candidate.app_id=logical.app_id
        AND candidate.subject_scope='aggregate'
        AND candidate.decided_at <= $3
        AND candidate.artifact->'evidence_refs' @>
          jsonb_build_array(jsonb_build_object('ref', raw.record_id))
      ORDER BY candidate.decided_at DESC, candidate.attribution_id DESC LIMIT 1
    ) AS attribution ON attribution.status='non_organic'
    WHERE ${basePredicates.join("\n      AND ")}
      AND logical.event_name IN ('skan_postback','adattributionkit_postback')
      AND fact.signature_verified
      AND fact.did_win
      AND fact.source_identifier_present
      AND fact.conversion_bucket IS NOT NULL
  ), event AS (
    SELECT * FROM deterministic_event
    UNION ALL
    SELECT series.metric_name, apple.metric_date, apple.campaign_id, apple.network,
      apple.country, apple.attribution_status,
      CASE WHEN series.metric_name='skan_conversion_value_distribution'
        THEN apple.apple_conversion_bucket ELSE NULL END AS apple_conversion_bucket
    FROM apple_event AS apple
    CROSS JOIN LATERAL (
      SELECT 'skan_attributed_installs'::text AS metric_name
      WHERE apple.event_name='skan_postback'
      UNION ALL
      SELECT 'skan_conversion_value_distribution'::text
      WHERE apple.event_name='skan_postback' AND apple.apple_conversion_bucket IS NOT NULL
      UNION ALL
      SELECT 'aak_attributed_installs'::text
      WHERE apple.event_name='adattributionkit_postback'
    ) AS series
  )
  , counts AS (
    SELECT event.metric_name,
      ${groupingExpression} AS grouping,
      count(*)::text AS count
    FROM event
    WHERE ${eventPredicates.length ? eventPredicates.join("\n      AND ") : "true"}
    GROUP BY event.metric_name, ${groupingExpression}
  )
  SELECT metric_name, grouping, count
  FROM counts
  ORDER BY metric_name COLLATE "C", grouping::text COLLATE "C"`;

  return withTenant(pool, identity.tenantId, async (client) => {
    const result = await client.query<RecordCountRow>(sql, values);
    return result.rows;
  });
}

export function encodeMetricReport(page: MetricReportPage, format: ReportFormat): {
  readonly contentType: string;
  readonly body: string;
} {
  return format === "csv"
    ? { contentType: "text/csv; charset=utf-8", body: encodeCsv(page.data, metricColumns) }
    : { contentType: "application/json", body: `${JSON.stringify(page)}\n` };
}

export function encodeDifferenceAudit(page: DifferenceAuditPage, format: ReportFormat): {
  readonly contentType: string;
  readonly body: string;
} {
  return format === "csv"
    ? { contentType: "text/csv; charset=utf-8", body: encodeCsv(page.data, differenceColumns) }
    : { contentType: "application/json", body: `${JSON.stringify(page)}\n` };
}
