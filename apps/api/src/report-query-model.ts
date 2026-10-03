import type { OpenMasuMetricRunV04 } from "../../../packages/contracts/src/generated/contract-types.js";

type MetricGrouping = NonNullable<OpenMasuMetricRunV04["grouping"]>["dimensions"];
export type GroupingDimension = keyof MetricGrouping;

export const groupingDimensionAllowlist: Readonly<Record<GroupingDimension, true>> = {
  campaign_id: true,
  ad_group_id: true,
  creative_id: true,
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

export type DifferenceCursor = {
  readonly kind: "difference";
  readonly reconciliationId: string;
  readonly selectionSequence?: string;
};

export type RecordCountCursor = {
  readonly kind: "record";
  readonly metricName: string;
  readonly groupingText: string;
};

export type ReportCursorKind = "metric" | "difference" | "record";

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
  readonly differenceAfter?: DifferenceCursor;
  readonly recordAfter?: RecordCountCursor;
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
const canonicalTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const differenceReasonPattern = /^[a-z][a-z0-9_]{2,127}$/;
const selectionSequencePattern = /^(0|[1-9]\d{0,18})$/;
const groupingKeyPrefix = "grouping_";

export const reportTransportKeys = new Set([
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
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}

function one(params: URLSearchParams, key: string): string | undefined {
  const values = params.getAll(key);
  if (values.length > 1) throw new ReportQueryError("duplicate_filter");
  return values[0];
}

function decodedCursor(encoded: string): Record<string, unknown> {
  try {
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    if (decoded.length < 2 || decoded.length > 4096) throw new Error("invalid");
    const parsed = JSON.parse(decoded) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
    return parsed as Record<string, unknown>;
  } catch {
    throw new ReportQueryError("cursor_invalid");
  }
}

function parseMetricCursor(encoded: string): MetricCursor {
  const parsed = decodedCursor(encoded);
  if (Object.keys(parsed).sort().join(",") !== "groupingDigest,metricName,metricRunId"
    || typeof parsed.metricName !== "string" || !metricNamePattern.test(parsed.metricName)
    || typeof parsed.groupingDigest !== "string" || !digestPattern.test(parsed.groupingDigest)
    || typeof parsed.metricRunId !== "string" || !identifierPattern.test(parsed.metricRunId)) {
    throw new ReportQueryError("cursor_invalid");
  }
  return {
    metricName: parsed.metricName,
    groupingDigest: parsed.groupingDigest,
    metricRunId: parsed.metricRunId,
  };
}

export { parseMetricCursor as decodeMetricCursor };

function parseDifferenceCursor(encoded: string): DifferenceCursor {
  const parsed = decodedCursor(encoded);
  const keys = Object.keys(parsed).sort().join(",");
  const legacy = keys === "kind,reconciliationId";
  const bounded = keys === "kind,reconciliationId,selectionSequence";
  const selectionSequence = parsed.selectionSequence;
  if ((!legacy && !bounded)
    || parsed.kind !== "difference"
    || typeof parsed.reconciliationId !== "string"
    || !identifierPattern.test(parsed.reconciliationId)
    || (bounded && (
      typeof selectionSequence !== "string"
      || !selectionSequencePattern.test(selectionSequence)
      || BigInt(selectionSequence) > 9_223_372_036_854_775_807n
    ))) {
    throw new ReportQueryError("cursor_invalid");
  }
  return {
    kind: "difference",
    reconciliationId: parsed.reconciliationId,
    ...(bounded ? { selectionSequence: selectionSequence as string } : {}),
  };
}

function parseRecordCountCursor(encoded: string): RecordCountCursor {
  const parsed = decodedCursor(encoded);
  if (Object.keys(parsed).sort().join(",") !== "groupingText,kind,metricName"
    || parsed.kind !== "record"
    || typeof parsed.metricName !== "string" || !metricNamePattern.test(parsed.metricName)
    || typeof parsed.groupingText !== "string" || parsed.groupingText.length > 2048) {
    throw new ReportQueryError("cursor_invalid");
  }
  try {
    const grouping = JSON.parse(parsed.groupingText) as unknown;
    if (!grouping || typeof grouping !== "object" || Array.isArray(grouping)) throw new Error("invalid");
    if (Object.keys(grouping as Record<string, unknown>).some((key) => !(key in groupingDimensionAllowlist))) {
      throw new Error("invalid");
    }
  } catch {
    throw new ReportQueryError("cursor_invalid");
  }
  return { kind: "record", metricName: parsed.metricName, groupingText: parsed.groupingText };
}

export function encodeMetricCursor(cursor: MetricCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function encodeDifferenceCursor(cursor: DifferenceCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function encodeRecordCountCursor(cursor: RecordCountCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function validateGrouping(dimension: GroupingDimension, value: string): void {
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
  readonly cursorKind?: ReportCursorKind;
}): ParsedReportQuery {
  const maximumRows = input.maximumRows ?? 1000;
  const maximumExportRows = input.maximumExportRows ?? 200_000;
  for (const key of input.searchParams.keys()) {
    if (key.startsWith(groupingKeyPrefix) && !reportTransportKeys.has(key)) {
      const requested = key.slice(groupingKeyPrefix.length);
      if (["installation_id", "click_id", "record_id", "payload", "payload_ref"].includes(requested)) {
        throw new ReportQueryError("identifying_grouping");
      }
    }
    if (!reportTransportKeys.has(key)) throw new ReportQueryError("unknown_filter");
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
    "aak_attributed_reengagements",
  ]);
  const selectedAggregate = metricNames.filter((name) => aggregateMetricNames.has(name));
  const selectedEngagement = metricNames.some(name => ["engagement_custom_event_converters_24h", "engagement_ad_revenue_24h_usd"].includes(name));
  if (selectedEngagement && Object.keys(grouping).some(key => !["campaign_id", "metric_date"].includes(key))) {
    throw new ReportQueryError("metric_series_mismatch");
  }
  const selectedDeterministic = metricNames.filter((name) => !aggregateMetricNames.has(name));
  const deterministicOnlyDimensions: GroupingDimension[] = [
    "campaign_id", "ad_group_id", "creative_id", "network", "country", "cohort_date", "attribution_status",
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
  const cursorKind = input.cursorKind ?? "metric";
  const cursor = afterValue === undefined
    ? {}
    : cursorKind === "metric"
      ? { after: parseMetricCursor(afterValue) }
      : cursorKind === "difference"
        ? { differenceAfter: parseDifferenceCursor(afterValue) }
        : { recordAfter: parseRecordCountCursor(afterValue) };

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
      ...cursor,
    },
  };
}
