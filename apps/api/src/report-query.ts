import type { OpenMMPMetricRunV03 } from "../../../packages/contracts/src/generated/contract-types.js";

type MetricGrouping = NonNullable<OpenMMPMetricRunV03["grouping"]>["dimensions"];
export type GroupingDimension = keyof MetricGrouping;

export const groupingDimensionAllowlist: Readonly<Record<GroupingDimension, true>> = {
  campaign_id: true,
  network: true,
  country: true,
  cohort_date: true,
  metric_date: true,
  attribution_status: true,
  apple_conversion_bucket: true,
};

export type MetricCursor = {
  readonly metricName: string;
  readonly groupingDigest: string;
  readonly metricRunId: string;
};

export type MetricQuery = {
  readonly tenantId: string;
  readonly appId: string;
  readonly metricNames?: readonly string[];
  readonly metricDefinitionVersion?: string;
  readonly grouping?: Readonly<Partial<Record<GroupingDimension, string>>>;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly watermarkAtMost?: string;
  readonly differenceReasonCode?: string;
  readonly supersession: "latest" | "all";
  readonly limit: number;
  readonly after?: MetricCursor;
};

export type ParsedReportQuery = {
  readonly query: MetricQuery;
  readonly format: "json" | "csv";
  readonly export: boolean;
};

export type ParameterizedQuery = {
  readonly text: string;
  readonly values: readonly unknown[];
};

export class ReportQueryError extends Error {
  readonly statusCode = 400;
  constructor(readonly code: string) {
    super(code);
  }
}

const metricNamePattern = /^[a-z][a-z0-9_]{2,127}$/;
const identifierPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const canonicalTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const differenceReasonPattern = /^[a-z][a-z0-9_]{2,127}$/;
const groupingKeyPrefix = "grouping_";

const transportKeys = new Set([
  "app_id",
  "metric_name",
  "metric_definition_version",
  "date_from",
  "date_to",
  "watermark_at_most",
  "difference_reason_code",
  "supersession",
  "limit",
  "after",
  "format",
  "export",
  ...Object.keys(groupingDimensionAllowlist).map((key) => `${groupingKeyPrefix}${key}`),
]);

function canonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function canonicalTimestamp(value: string): boolean {
  return canonicalTimestampPattern.test(value)
    && !Number.isNaN(new Date(value).valueOf())
    && new Date(value).toISOString() === value;
}

function one(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1) throw new ReportQueryError("duplicate_filter");
  return values[0];
}

function parseCursor(encoded: string): MetricCursor {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
    if (Object.keys(parsed).sort().join(",") !== "groupingDigest,metricName,metricRunId"
      || typeof parsed.metricName !== "string" || !metricNamePattern.test(parsed.metricName)
      || typeof parsed.groupingDigest !== "string" || !digestPattern.test(parsed.groupingDigest)
      || typeof parsed.metricRunId !== "string" || !identifierPattern.test(parsed.metricRunId)) {
      throw new Error("invalid");
    }
    return {
      metricName: parsed.metricName,
      groupingDigest: parsed.groupingDigest,
      metricRunId: parsed.metricRunId,
    };
  } catch {
    throw new ReportQueryError("cursor_invalid");
  }
}

export function encodeMetricCursor(cursor: MetricCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function validateGrouping(dimension: GroupingDimension, value: string): void {
  const valid = dimension === "country"
    ? /^[A-Z]{2}$/.test(value)
    : dimension === "cohort_date" || dimension === "metric_date"
      ? canonicalDate(value)
      : dimension === "attribution_status"
        ? new Set(["organic", "non_organic", "unattributed"]).has(value)
        : dimension === "apple_conversion_bucket"
          ? /^(fine:([0-9]|[1-5][0-9]|6[0-3])|coarse:(low|medium|high))$/.test(value)
        : identifierPattern.test(value);
  if (!valid) throw new ReportQueryError("grouping_value_invalid");
}

export function parseMetricQuery(input: {
  readonly tenantId: string;
  readonly appId: string;
  readonly searchParams: URLSearchParams;
  readonly maximumRows?: number;
  readonly maximumExportRows?: number;
}): ParsedReportQuery {
  const maximumRows = input.maximumRows ?? 1000;
  const maximumExportRows = input.maximumExportRows ?? 200_000;
  for (const key of input.searchParams.keys()) {
    if (key.startsWith(groupingKeyPrefix) && !transportKeys.has(key)) {
      const requested = key.slice(groupingKeyPrefix.length);
      if (["installation_id", "click_id", "record_id", "payload", "payload_ref"].includes(requested)) {
        throw new ReportQueryError("identifying_grouping");
      }
    }
    if (!transportKeys.has(key)) throw new ReportQueryError("unknown_filter");
  }

  const requestedAppId = one(input.searchParams, "app_id");
  if (requestedAppId !== undefined && requestedAppId !== input.appId) {
    throw new ReportQueryError("app_scope_mismatch");
  }

  const format = one(input.searchParams, "format") ?? "json";
  if (format !== "json" && format !== "csv") throw new ReportQueryError("unsupported_format");
  const exportValue = one(input.searchParams, "export") ?? "false";
  if (exportValue !== "true" && exportValue !== "false") throw new ReportQueryError("export_invalid");
  const exportRows = exportValue === "true";
  if (exportRows && format !== "csv") throw new ReportQueryError("export_requires_csv");

  const metricNames = [...new Set(input.searchParams.getAll("metric_name"))].sort();
  if (metricNames.some((value) => !metricNamePattern.test(value))) throw new ReportQueryError("metric_name_invalid");
  const metricDefinitionVersion = one(input.searchParams, "metric_definition_version");
  if (metricDefinitionVersion !== undefined && (metricDefinitionVersion.length < 1 || metricDefinitionVersion.length > 64)) {
    throw new ReportQueryError("metric_definition_version_invalid");
  }

  const grouping: Partial<Record<GroupingDimension, string>> = {};
  for (const dimension of Object.keys(groupingDimensionAllowlist) as GroupingDimension[]) {
    const value = one(input.searchParams, `${groupingKeyPrefix}${dimension}`);
    if (value === undefined) continue;
    validateGrouping(dimension, value);
    grouping[dimension] = value;
  }
  const aggregateMetricNames = new Set([
    "skan_attributed_installs", "skan_conversion_value_distribution", "aak_attributed_installs",
  ]);
  const selectedAggregate = metricNames.filter((name) => aggregateMetricNames.has(name));
  const selectedDeterministic = metricNames.filter((name) => !aggregateMetricNames.has(name));
  const deterministicOnlyDimensions: GroupingDimension[] = [
    "campaign_id", "network", "country", "cohort_date", "attribution_status",
  ];
  if (selectedAggregate.length > 0 && deterministicOnlyDimensions.some((dimension) => grouping[dimension] !== undefined)) {
    throw new ReportQueryError("metric_series_mismatch");
  }
  if (grouping.apple_conversion_bucket !== undefined && (
    selectedAggregate.length !== 1 || selectedAggregate[0] !== "skan_conversion_value_distribution" ||
    selectedDeterministic.length > 0
  )) {
    throw new ReportQueryError("metric_series_mismatch");
  }

  const dateFrom = one(input.searchParams, "date_from");
  const dateTo = one(input.searchParams, "date_to");
  if ((dateFrom !== undefined && !canonicalDate(dateFrom)) || (dateTo !== undefined && !canonicalDate(dateTo))) {
    throw new ReportQueryError("date_invalid");
  }
  if (dateFrom !== undefined && dateTo !== undefined && dateFrom >= dateTo) {
    throw new ReportQueryError("date_range_invalid");
  }
  const watermarkAtMost = one(input.searchParams, "watermark_at_most");
  if (watermarkAtMost !== undefined && !canonicalTimestamp(watermarkAtMost)) {
    throw new ReportQueryError("watermark_invalid");
  }
  const differenceReasonCode = one(input.searchParams, "difference_reason_code");
  if (differenceReasonCode !== undefined && !differenceReasonPattern.test(differenceReasonCode)) {
    throw new ReportQueryError("difference_reason_invalid");
  }
  const supersession = one(input.searchParams, "supersession") ?? "latest";
  if (supersession !== "latest" && supersession !== "all") throw new ReportQueryError("supersession_invalid");

  const limitValue = one(input.searchParams, "limit");
  const limit = limitValue === undefined ? (exportRows ? maximumExportRows : 200) : Number(limitValue);
  const limitMaximum = exportRows ? maximumExportRows : maximumRows;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > limitMaximum) throw new ReportQueryError("limit_invalid");
  const afterValue = one(input.searchParams, "after");

  return {
    format,
    export: exportRows,
    query: {
      tenantId: input.tenantId,
      appId: input.appId,
      ...(metricNames.length > 0 ? { metricNames } : {}),
      ...(metricDefinitionVersion !== undefined ? { metricDefinitionVersion } : {}),
      ...(Object.keys(grouping).length > 0 ? { grouping } : {}),
      ...(dateFrom !== undefined ? { dateFrom } : {}),
      ...(dateTo !== undefined ? { dateTo } : {}),
      ...(watermarkAtMost !== undefined ? { watermarkAtMost } : {}),
      ...(differenceReasonCode !== undefined ? { differenceReasonCode } : {}),
      supersession,
      limit,
      ...(afterValue !== undefined ? { after: parseCursor(afterValue) } : {}),
    },
  };
}

function push(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${values.length}`;
}

function runDateExpression(alias: string): string {
  return `COALESCE(NULLIF(${alias}.grouping->>'metric_date',''), NULLIF(${alias}.grouping->>'cohort_date',''))`;
}

export function buildMetricQuery(query: MetricQuery): ParameterizedQuery {
  const values: unknown[] = [query.tenantId, query.appId];
  const predicates = ["mr.tenant_id=$1", "mr.app_id=$2"];
  if (query.metricNames) predicates.push(`mr.metric_name=ANY(${push(values, query.metricNames)}::text[])`);
  if (query.metricDefinitionVersion) predicates.push(`mr.metric_definition_version=${push(values, query.metricDefinitionVersion)}`);
  for (const [dimension, value] of Object.entries(query.grouping ?? {}) as [GroupingDimension, string][]) {
    predicates.push(`mr.grouping->>'${dimension}'=${push(values, value)}`);
  }
  if (query.dateFrom) predicates.push(`${runDateExpression("mr")} >= ${push(values, query.dateFrom)}`);
  if (query.dateTo) predicates.push(`${runDateExpression("mr")} < ${push(values, query.dateTo)}`);
  if (query.watermarkAtMost) predicates.push(`mr.input_received_at_watermark <= ${push(values, query.watermarkAtMost)}`);
  if (query.supersession === "latest") {
    predicates.push(`NOT EXISTS (
      SELECT 1 FROM ledger.metric_runs AS replacement
      WHERE replacement.tenant_id=mr.tenant_id AND replacement.app_id=mr.app_id
        AND replacement.supersedes_metric_run_id=mr.metric_run_id
    )`);
  }
  if (query.after) {
    const metric = push(values, query.after.metricName);
    const grouping = push(values, query.after.groupingDigest);
    const run = push(values, query.after.metricRunId);
    predicates.push(`(mr.metric_name COLLATE "C", mr.grouping_digest COLLATE "C", mr.metric_run_id COLLATE "C")
      > (${metric} COLLATE "C", ${grouping} COLLATE "C", ${run} COLLATE "C")`);
  }
  const limit = push(values, query.limit + 1);
  return {
    text: `SELECT mr.artifact, mr.grouping_digest,
      EXISTS (
        SELECT 1 FROM ledger.metric_runs AS replacement
        WHERE replacement.tenant_id=mr.tenant_id AND replacement.app_id=mr.app_id
          AND replacement.supersedes_metric_run_id=mr.metric_run_id
      ) AS superseded
      FROM ledger.metric_runs AS mr
      WHERE ${predicates.join("\n        AND ")}
      ORDER BY mr.metric_name COLLATE "C", mr.grouping_digest COLLATE "C", mr.metric_run_id COLLATE "C"
      LIMIT ${limit}`,
    values,
  };
}

export function buildDifferenceQuery(query: MetricQuery): ParameterizedQuery {
  const values: unknown[] = [query.tenantId, query.appId];
  const predicates = ["rr.tenant_id=$1", "rr.app_id=$2"];
  if (query.differenceReasonCode) {
    predicates.push(`rr.difference_reason_code=${push(values, query.differenceReasonCode)}`);
  }
  const artifactDate = "COALESCE(NULLIF(rr.artifact->>'metric_date',''), NULLIF(rr.artifact->>'cohort_date',''))";
  if (query.dateFrom) predicates.push(`${artifactDate} >= ${push(values, query.dateFrom)}`);
  if (query.dateTo) predicates.push(`${artifactDate} < ${push(values, query.dateTo)}`);
  if (query.supersession === "latest") {
    predicates.push(`NOT EXISTS (
      SELECT 1 FROM ledger.reconciliation_results AS replacement
      WHERE replacement.tenant_id=rr.tenant_id AND replacement.app_id=rr.app_id
        AND replacement.supersedes_reconciliation_id=rr.reconciliation_id
    )`);
  }
  const limit = push(values, query.limit + 1);
  return {
    text: `SELECT rr.artifact,
      EXISTS (
        SELECT 1 FROM ledger.reconciliation_results AS replacement
        WHERE replacement.tenant_id=rr.tenant_id AND replacement.app_id=rr.app_id
          AND replacement.supersedes_reconciliation_id=rr.reconciliation_id
      ) AS superseded
      FROM ledger.reconciliation_results AS rr
      WHERE ${predicates.join("\n        AND ")}
      ORDER BY rr.reconciliation_id COLLATE "C"
      LIMIT ${limit}`,
    values,
  };
}
