import { jcs } from "@openmasu/attribution-core";
import { comparisonMeaning } from "@openmasu/runtime";
import type { MetricQuery } from "./report-query.js";
import type { MetricReportPage } from "./reporting.js";
import { reportToSnapshot } from "./report-snapshot.js";

export class ComparisonExportError extends Error {
  constructor(code: string) { super(code); this.name = "ComparisonExportError"; }
}

/** One complete bounded query, using the exact same pure converter as the CLI. */
export function comparisonExport(page: MetricReportPage, query: MetricQuery, declaredAggregation?: string) {
  if (query.after || query.supersession !== "latest") throw new ComparisonExportError("comparison_requires_latest_without_cursor");
  if (page.next_cursor || page.data.length > 10000) throw new ComparisonExportError("comparison_incomplete_or_limit_exceeded");
  if (query.metricNames?.length !== 1 || !query.dateFrom || !query.dateTo || !query.watermarkAtMost) {
    throw new ComparisonExportError("comparison_requires_one_metric_dates_and_exact_watermark");
  }
  const first = page.data[0];
  if (!first || page.data.some(r => r.metric_name !== first.metric_name || r.metric_definition_version !== first.metric_definition_version
      || r.aggregation_time_zone !== first.aggregation_time_zone)) throw new ComparisonExportError("comparison_requires_one_nonempty_definition");
  const meanings = page.data.map(r => r.comparison_context ? comparisonMeaning(r.comparison_context) : undefined);
  const aggregations = new Set(meanings.map(meaning => meaning?.aggregation));
  const aggregation = meanings.every(Boolean) && aggregations.size === 1 ? meanings[0]!.aggregation : declaredAggregation;
  if (aggregation !== "cumulative" && aggregation !== "on_day") throw new ComparisonExportError("comparison_aggregation_declaration_required");
  let snapshot: ReturnType<typeof reportToSnapshot>;
  try {
    snapshot = reportToSnapshot(page, { source: "OpenMasu saved metric report", conditions: {
      date_from: query.dateFrom, date_to: query.dateTo, time_zone: first.aggregation_time_zone,
      maturity: "unknown", aggregation, attribution_scope: query.grouping?.attribution_status ?? "all",
      metric_definition: `${first.metric_name}@${first.metric_definition_version}`, source_cutoff: query.watermarkAtMost,
    }, rows: [] });
  } catch { throw new ComparisonExportError("comparison_rows_do_not_match_selected_conditions"); }
  const body = `${jcs(snapshot)}\n`;
  if (Buffer.byteLength(body, "utf8") > 4 * 1024 * 1024) throw new ComparisonExportError("comparison_byte_limit_exceeded");
  return body;
}
