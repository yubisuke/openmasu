import { groupingDimensionAllowlist, type MetricQuery } from "../report-query.js";

export const reportFields = [
  ["date_from", "Date from (inclusive)"], ["date_to", "Date to (exclusive)"],
  ["grouping_campaign_id", "Campaign ID"], ["grouping_country", "Country (two uppercase letters)"],
  ["grouping_attribution_status", "Attribution status (organic / non_organic / unattributed)"],
  ["grouping_cohort_date", "Cohort date"], ["grouping_metric_date", "Metric date"],
  ["grouping_network", "Network"], ["grouping_apple_conversion_bucket", "Apple conversion bucket"],
  ["metric_definition_version", "Definition version"], ["watermark_at_most", "Watermark (UTC ISO timestamp)"],
  ["difference_reason_code", "Difference reason"],
] as const;

/** HTML GET forms submit blank controls. Only known optional dashboard controls may be omitted. */
export function dashboardReportParams(input: URLSearchParams): URLSearchParams {
  const optional = new Set<string>(["metric_name", ...reportFields.map(([name]) => name)]);
  const result = new URLSearchParams();
  for (const [key, value] of input) {
    if (value === "" && optional.has(key)) continue;
    result.append(key, value);
  }
  return result;
}

export function reportSelectionParams(query: MetricQuery): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of query.metricNames ?? []) params.append("metric_name", name);
  if (query.metricDefinitionVersion) params.set("metric_definition_version", query.metricDefinitionVersion);
  for (const dimension of Object.keys(groupingDimensionAllowlist)) {
    const value = query.grouping?.[dimension as keyof typeof groupingDimensionAllowlist];
    if (value !== undefined) params.set(`grouping_${dimension}`, value);
  }
  if (query.dateFrom) params.set("date_from", query.dateFrom);
  if (query.dateTo) params.set("date_to", query.dateTo);
  if (query.watermarkAtMost) params.set("watermark_at_most", query.watermarkAtMost);
  if (query.differenceReasonCode) params.set("difference_reason_code", query.differenceReasonCode);
  params.set("supersession", query.supersession);
  return params;
}
