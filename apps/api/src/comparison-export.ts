import { jcs } from "@openmasu/attribution-core";
import { comparisonMeaning } from "@openmasu/runtime";
import type { MetricQuery } from "./report-query.js";
import type { MetricReportPage } from "./reporting.js";
import { reportToSnapshot } from "./report-snapshot.js";
import { comparisonDigest, parseSnapshot } from "./cohort-comparison.js";

export class ComparisonExportError extends Error {
  constructor(code: string) { super(code); this.name = "ComparisonExportError"; }
}

export function requireComparisonQuery(query: MetricQuery) {
  if (query.after || query.supersession !== "latest") throw new ComparisonExportError("comparison_requires_latest_without_cursor");
  if (query.metricNames?.length !== 1 || !query.dateFrom || !query.dateTo || !query.watermarkAtMost) {
    throw new ComparisonExportError("comparison_requires_one_metric_dates_and_exact_watermark");
  }
  if (query.differenceReasonCode) throw new ComparisonExportError("comparison_requires_metric_selection");
}

/** One complete bounded query, using the exact same pure converter as the CLI. */
export function comparisonExport(page: MetricReportPage, query: MetricQuery, declaredAggregation?: string, fixedRead = false) {
  requireComparisonQuery(query);
  if (page.next_cursor || page.data.length > 10000) throw new ComparisonExportError("comparison_incomplete_or_limit_exceeded");
  const first = page.data[0];
  if (!first || first.metric_name !== query.metricNames![0] || page.data.some(r => r.metric_name !== first.metric_name || r.metric_definition_version !== first.metric_definition_version
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
  if (fixedRead) {
    const scope = { tenant_id: query.tenantId, app_id: query.appId };
    const filters = { metric_definition_version: query.metricDefinitionVersion ?? null, grouping: { ...query.grouping } };
    snapshot = parseSnapshot({ ...snapshot, acquisition: {
      version: 1, state: "complete", method: "postgres_repeatable_read", scope, filters, row_count: snapshot.rows.length,
      selection_sha256: comparisonDigest(snapshot.provenance!.runs), query_sha256: comparisonDigest({ scope, filters, conditions: snapshot.conditions }),
      upstream_completeness: "unknown",
    } });
  }
  const body = `${jcs(snapshot)}\n`;
  if (Buffer.byteLength(body, "utf8") > 4 * 1024 * 1024) throw new ComparisonExportError("comparison_byte_limit_exceeded");
  return body;
}
