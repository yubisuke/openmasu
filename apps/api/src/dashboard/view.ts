import type { MetricQuery } from "../report-query.js";
import type {
  DifferenceAuditPage,
  MetricReportPage,
  MetricReportRow,
  RecordCountRow,
} from "../reporting.js";
import type { FraudAuditRow } from "../fraud-reporting.js";
import type { GoogleDeliveryHealth } from "../google-delivery-health.js";
import type { OperatorDeliveryHealth } from "../operator-delivery-health.js";

export type DashboardApp = {
  readonly app_id: string;
  readonly created_at: string;
};

export type DashboardChart = {
  readonly metric_name: string;
  readonly series: readonly (number | undefined)[];
};

export type DashboardTrackingLink = {
  readonly tracking_link_id: string;
  readonly measurement_url: string;
  readonly destination_url: string;
  readonly network?: string;
  readonly campaign_id?: string;
  readonly status: "active" | "paused" | "archived";
  readonly created_at: string;
};

export type DashboardSdkKey = {
  readonly sdk_key_id: string;
  readonly platform: "android" | "ios";
  readonly status: "active" | "retired";
  readonly created_at: string;
  readonly status_changed_at: string;
};

export type DashboardServerKey = {
  readonly server_key_id: string;
  readonly producer: string;
  readonly status: "active" | "retired";
  readonly created_at: string;
  readonly status_changed_at: string;
};

export type DashboardOperatorWebhook = {
  readonly destination_id: string;
  readonly endpoint_url: string;
  readonly events: readonly string[];
  readonly status: "active" | "disabled";
  readonly created_at: string;
  readonly status_changed_at: string;
};

export type DashboardOperatorBulkExport = {
  readonly destination_id: string;
  readonly endpoint_url: string;
  readonly bucket_name: string;
  readonly object_prefix: string;
  readonly region: string;
  readonly events: readonly string[];
  readonly start_at: string;
  readonly status: "active" | "disabled";
  readonly created_at: string;
  readonly status_changed_at: string;
};

export type DashboardView = {
  readonly apps: readonly DashboardApp[];
  readonly selectedAppId?: string;
  readonly query?: MetricQuery;
  readonly rows: readonly MetricReportRow[];
  readonly deterministicRows: readonly MetricReportRow[];
  readonly appleAggregateRows: readonly MetricReportRow[];
  readonly records: readonly RecordCountRow[];
  readonly differences: readonly Record<string, unknown>[];
  readonly undefinedCount: number;
  readonly charts: readonly DashboardChart[];
  readonly deterministicCharts: readonly DashboardChart[];
  readonly appleAggregateCharts: readonly DashboardChart[];
  readonly trackingLinks: readonly DashboardTrackingLink[];
  readonly sdkKeys: readonly DashboardSdkKey[];
  readonly serverKeys: readonly DashboardServerKey[];
  readonly operatorWebhooks: readonly DashboardOperatorWebhook[];
  readonly operatorBulkExports: readonly DashboardOperatorBulkExport[];
  readonly fraudRows: readonly FraudAuditRow[];
  readonly googleDeliveryHealth?: GoogleDeliveryHealth;
  readonly operatorDeliveryHealth?: OperatorDeliveryHealth;
  readonly csrfToken: string;
  readonly canOperate: boolean;
  readonly canAdminister: boolean;
  readonly nextCursor?: string;
  readonly recordNextCursor?: string;
  readonly differenceNextCursor?: string;
  readonly metadata: {
    readonly watermark?: string;
    readonly snapshotIds: readonly string[];
    readonly aggregationTimeZones: readonly string[];
    readonly freshnessStates: readonly string[];
    readonly metricDefinitionVersions: readonly string[];
    readonly ruleBundles: readonly string[];
    readonly policyVersions: readonly string[];
  };
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en"));
}

function compare(left: MetricReportRow, right: MetricReportRow): number {
  return left.metric_name.localeCompare(right.metric_name, "en")
    || left.grouping_digest.localeCompare(right.grouping_digest, "en")
    || left.metric_run_id.localeCompare(right.metric_run_id, "en");
}

export function buildDashboardView(input: {
  readonly apps: readonly DashboardApp[];
  readonly selectedAppId?: string;
  readonly query?: MetricQuery;
  readonly metrics?: MetricReportPage;
  readonly records?: readonly RecordCountRow[];
  readonly recordNextCursor?: string;
  readonly differences?: DifferenceAuditPage;
  readonly differenceNextCursor?: string;
  readonly trackingLinks?: readonly DashboardTrackingLink[];
  readonly sdkKeys?: readonly DashboardSdkKey[];
  readonly serverKeys?: readonly DashboardServerKey[];
  readonly operatorWebhooks?: readonly DashboardOperatorWebhook[];
  readonly operatorBulkExports?: readonly DashboardOperatorBulkExport[];
  readonly fraudRows?: readonly FraudAuditRow[];
  readonly googleDeliveryHealth?: GoogleDeliveryHealth;
  readonly operatorDeliveryHealth?: OperatorDeliveryHealth;
  readonly csrfToken: string;
  readonly canOperate?: boolean;
  readonly canAdminister?: boolean;
}): DashboardView {
  const rows = [...(input.metrics?.data ?? [])].sort(compare);
  const aggregateNames = new Set([
    "skan_attributed_installs", "skan_conversion_value_distribution", "aak_attributed_installs",
    "aak_attributed_reengagements",
  ]);
  const deterministicRows = rows.filter((row) => !aggregateNames.has(row.metric_name));
  const appleAggregateRows = rows.filter((row) => aggregateNames.has(row.metric_name));
  const byMetric = new Map<string, (number | undefined)[]>();
  for (const row of rows) {
    const series = byMetric.get(row.metric_name) ?? [];
    series.push(row.value_state === "present" && row.value_unscaled !== undefined
      ? Number(row.value_unscaled)
      : undefined);
    byMetric.set(row.metric_name, series);
  }
  const charts = [...byMetric].map(([metric_name, series]) => ({ metric_name, series }));
  return {
    apps: [...input.apps].sort((left, right) => left.app_id.localeCompare(right.app_id, "en")),
    ...(input.selectedAppId ? { selectedAppId: input.selectedAppId } : {}),
    ...(input.query ? { query: input.query } : {}),
    rows,
    deterministicRows,
    appleAggregateRows,
    records: input.records ?? [],
    differences: input.differences?.data ?? [],
    undefinedCount: rows.filter((row) => row.value_state === "undefined").length,
    charts,
    deterministicCharts: charts.filter((chart) => !aggregateNames.has(chart.metric_name)),
    appleAggregateCharts: charts.filter((chart) => aggregateNames.has(chart.metric_name)),
    trackingLinks: [...(input.trackingLinks ?? [])].sort((left, right) =>
      right.created_at.localeCompare(left.created_at, "en")
      || left.tracking_link_id.localeCompare(right.tracking_link_id, "en")),
    sdkKeys: [...(input.sdkKeys ?? [])].sort((left, right) =>
      right.created_at.localeCompare(left.created_at, "en")
      || left.sdk_key_id.localeCompare(right.sdk_key_id, "en")),
    serverKeys: [...(input.serverKeys ?? [])].sort((left, right) =>
      right.created_at.localeCompare(left.created_at, "en")
      || left.server_key_id.localeCompare(right.server_key_id, "en")),
    operatorWebhooks: [...(input.operatorWebhooks ?? [])].sort((left, right) =>
      right.created_at.localeCompare(left.created_at, "en")
      || left.destination_id.localeCompare(right.destination_id, "en")),
    operatorBulkExports: [...(input.operatorBulkExports ?? [])].sort((left, right) =>
      right.created_at.localeCompare(left.created_at, "en")
      || left.destination_id.localeCompare(right.destination_id, "en")),
    fraudRows: [...(input.fraudRows ?? [])],
    ...(input.googleDeliveryHealth ? { googleDeliveryHealth: input.googleDeliveryHealth } : {}),
    ...(input.operatorDeliveryHealth ? { operatorDeliveryHealth: input.operatorDeliveryHealth } : {}),
    csrfToken: input.csrfToken,
    canOperate: input.canOperate ?? false,
    canAdminister: input.canAdminister ?? false,
    ...(input.metrics?.next_cursor ? { nextCursor: input.metrics.next_cursor } : {}),
    ...(input.recordNextCursor ? { recordNextCursor: input.recordNextCursor } : {}),
    ...(input.differenceNextCursor ? { differenceNextCursor: input.differenceNextCursor } : {}),
    metadata: {
      ...(input.query?.watermarkAtMost ? { watermark: input.query.watermarkAtMost } : {}),
      snapshotIds: unique(rows.map((row) => row.input_snapshot_id)),
      aggregationTimeZones: unique(rows.map((row) => row.aggregation_time_zone)),
      freshnessStates: unique(rows.map((row) => row.data_freshness)),
      metricDefinitionVersions: unique(rows.map((row) => row.metric_definition_version)),
      ruleBundles: unique(rows.map((row) => `${row.rule_bundle_id}:${row.rule_bundle_hash}`)),
      policyVersions: unique(rows.flatMap((row) => row.policy_versions)),
    },
  };
}
