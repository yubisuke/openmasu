import type { Pool } from "pg";
import { acquisitionKpiRole, isCalendarActivityMetricDefinition } from "@openmasu/contracts/definitions";
import { comparisonMeaning, comparisonMaturity } from "@openmasu/runtime/metric-comparison";
import { comparisonDigest, parseComparisonContext } from "./cohort-comparison.js";
import { buildAcquisitionKpiSets } from "./acquisition-kpis.js";
import { acquisitionKpiDimensions } from "@openmasu/runtime/acquisition-kpi-key";
import { acquisitionPeriodRows, buildAcquisitionPeriods, type AcquisitionPeriodSummary } from "./acquisition-period.js";
import type { AppAdminIdentity } from "./admin-auth.js";
import type { MetricQuery } from "./report-query.js";
import { fixedMetricSelections, type SelectionOptions } from "./fixed-comparison.js";
import { encodeCsv, type MetricReportRow } from "./reporting.js";
import { previousAnalysisQuery } from "./saved-analysis.js";
import { metricValueLabel } from "./dashboard/metric-value.js";

export type AnalysisObservation = {
  run_id: string; snapshot_id: string; watermark: string; state: string; reason: string | null;
  value_unscaled: string | null; label: string; currency: string | null; scale: number | null;
  activity_unit: MetricReportRow["activity_unit"] | null;
  freshness: string; source_observation: string; import_completion: string;
};
export type PeriodAnalysisRow = { metric_name: string; dimensions: Record<string, string>; day_offset: number;
  current_date: string; previous_date: string; status: "compared" | "incomparable"; reason: string | null;
  current: AnalysisObservation[]; previous: AnalysisObservation[]; delta_current_minus_previous: string | null };
export type PeriodAnalysis = { current_from: string; current_to: string; previous_from: string; previous_to: string;
  watermark_at_most: string; acquisition: "complete"; source_completeness: "unknown";
  current_count: number; previous_count: number; selection_digest: string; rows: PeriodAnalysisRow[];
  summaries: AcquisitionPeriodSummary[] };

function observation(row: MetricReportRow): AnalysisObservation {
  return { run_id: row.metric_run_id, snapshot_id: row.input_snapshot_id, watermark: row.input_received_at_watermark,
    state: row.value_state, reason: row.unavailable_reason ?? row.undefined_reason,
    value_unscaled: row.value_state === "present" ? row.value_unscaled ?? null : null, label: metricValueLabel(row),
    currency: row.currency, scale: row.value_type === "count" ? 0 : row.ratio_scale ?? row.amount_scale,
    activity_unit: row.activity_unit ?? null,
    freshness: row.data_freshness, source_observation: JSON.stringify(row.source_observation ?? null),
    import_completion: JSON.stringify(row.import_completion ?? null) };
}

function eligibility(row: MetricReportRow, kpis: Map<string, string | null>): { reason: string | null; meaning?: string } {
  if (row.value_state !== "present") return { reason: row.unavailable_reason ?? row.undefined_reason ?? row.value_state };
  if (row.superseded || row.reproducibility_status !== "fully_reproducible") return { reason: "historical_or_unavailable" };
  if ([row.privacy_update_state, row.late_input_update_state, row.attribution_update_state].includes("unavailable")) return { reason: "evidence_unavailable" };
  if ([row.cost_update_state, row.privacy_update_state, row.late_input_update_state, row.attribution_update_state].includes("recalculation_pending")
      || row.cost_update_state === "input_revised") return { reason: "recalculation_pending" };
  if (acquisitionKpiRole(row.metric_name) && (!kpis.has(row.metric_run_id) || kpis.get(row.metric_run_id))) {
    return { reason: kpis.get(row.metric_run_id) ?? "acquisition_set_incomplete_or_incompatible" };
  }
  try {
    const context = parseComparisonContext(row.comparison_context), d = context.definition, meaning = comparisonMeaning(context);
    const activity = isCalendarActivityMetricDefinition(d);
    const validDateGrouping = activity ? !!row.grouping.metric_date && Object.keys(row.grouping).length === 1
      : !!row.grouping.cohort_date && !row.grouping.metric_date;
    if (!meaning || !validDateGrouping
        || row.metric_run_id !== context.metric_run_id || row.input_snapshot_id !== context.input_snapshot_id
        || row.metric_name !== d.metric_name || row.metric_definition_version !== d.metric_definition_version
        || row.rule_bundle_id !== d.rule_bundle_id || row.rule_bundle_hash !== d.rule_bundle_hash
        || row.aggregation_time_zone !== d.aggregation_time_zone || row.grouping_digest !== comparisonDigest(row.grouping)
        || !row.policy_versions.includes(`rule_bundle:${d.rule_bundle_version}`)
        || row.policy_versions.some(policy => policy.startsWith("fx:") && policy !== `fx:${context.fx.policy_version}`)
        || row.value_type !== d.value_type || row.currency !== (d.currency ?? null)
        || row.amount_scale !== (d.amount_scale ?? null) || row.ratio_scale !== (d.ratio_scale ?? null)
        || !/^(?:0|-?[1-9]\d{0,99})$/.test(row.value_unscaled ?? "")) return { reason: "meaning_unverified" };
    if (comparisonMaturity(context, row.grouping, row.input_received_at_watermark).state !== "window_elapsed") {
      return { reason: "window_not_elapsed" };
    }
    return { reason: null, meaning: comparisonDigest({ meaning, definitionVersion: d.metric_definition_version,
      bundle: [d.rule_bundle_id, d.rule_bundle_version, d.rule_bundle_hash], policies: [...row.policy_versions].sort() }) };
  } catch { return { reason: "meaning_unverified" }; }
}

/** Preserve daily alignment; summarize only the explicit complete acquisition operand set. */
export function buildPeriodAnalysis(query: MetricQuery, current: readonly MetricReportRow[], previous: readonly MetricReportRow[]): PeriodAnalysis {
  const prior = previousAnalysisQuery(query), groups = new Map<string, { metric: string; dimensions: Record<string, string>;
    offset: number; current: MetricReportRow[]; previous: MetricReportRow[] }>();
  const kpis = new Map<string, string | null>();
  for (const rows of [current, previous]) {
    for (const set of buildAcquisitionKpiSets(rows, false, query).sets) {
      for (const row of Object.values(set.rows)) kpis.set(row.metric_run_id, set.reason);
    }
  }
  for (const [side, rows, from] of [["current", current, query.dateFrom!], ["previous", previous, prior.dateFrom!]] as const) {
    for (const row of rows) {
      const date = row.grouping.cohort_date ?? row.grouping.metric_date;
      const offset = (Date.parse(date) - Date.parse(from)) / 86_400_000;
      if (!Number.isInteger(offset) || offset < 0) throw new Error("analysis_row_date_invalid");
      const dimensions = acquisitionKpiRole(row.metric_name) ? acquisitionKpiDimensions(row, query)
        : Object.fromEntries(Object.entries(row.grouping).filter(([key]) => !["cohort_date", "metric_date"].includes(key)).sort());
      const key = JSON.stringify([row.metric_name, dimensions, offset]);
      const group = groups.get(key) ?? { metric: row.metric_name, dimensions, offset, current: [], previous: [] };
      group[side].push(row); groups.set(key, group);
    }
  }
  const dateAt = (from: string, offset: number) => new Date(Date.parse(from) + offset * 86_400_000).toISOString().slice(0, 10);
  const rows = [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]): PeriodAnalysisRow => {
    const a = group.current, b = group.previous;
    const left = a.length === 1 ? eligibility(a[0], kpis) : undefined;
    const right = b.length === 1 ? eligibility(b[0], kpis) : undefined;
    const reason = !a.length ? "missing_current" : !b.length ? "missing_previous" : a.length !== 1 || b.length !== 1
      ? "multiple_saved_runs" : left!.reason ?? right!.reason ?? (left!.meaning !== right!.meaning ? "meaning_fx_or_basis_mismatch" : null);
    return { metric_name: group.metric, dimensions: group.dimensions, day_offset: group.offset,
      current_date: dateAt(query.dateFrom!, group.offset), previous_date: dateAt(prior.dateFrom!, group.offset),
      status: reason ? "incomparable" : "compared", reason,
      current: a.map(observation), previous: b.map(observation),
      delta_current_minus_previous: reason ? null : (BigInt(a[0].value_unscaled!) - BigInt(b[0].value_unscaled!)).toString() };
  });
  const { limit: _pageSize, after: _cursor, ...selection } = query;
  return { current_from: query.dateFrom!, current_to: query.dateTo!, previous_from: prior.dateFrom!, previous_to: prior.dateTo!,
    watermark_at_most: query.watermarkAtMost!, acquisition: "complete", source_completeness: "unknown",
    current_count: current.length, previous_count: previous.length,
    selection_digest: comparisonDigest({ query: selection, current, previous }), rows,
    summaries: buildAcquisitionPeriods(query, [query.dateFrom!, query.dateTo!], [prior.dateFrom!, prior.dateTo!], current, previous) };
}

export function acquirePeriodAnalysis(pool: Pool, identity: AppAdminIdentity, query: MetricQuery, options: SelectionOptions = {}) {
  return fixedMetricSelections(pool, identity, [query, previousAnalysisQuery(query)],
    ([current, previous]) => buildPeriodAnalysis(query, current, previous), options);
}
export function visibleAnalysisRows(analysis: PeriodAnalysis, display: "all" | "exceptions") {
  return display === "exceptions" ? analysis.rows.filter(row => row.status !== "compared") : analysis.rows;
}
export function encodePeriodAnalysisCsv(analysis: PeriodAnalysis, display: "all" | "exceptions"): string {
  const rows: Record<string, unknown>[] = visibleAnalysisRows(analysis, display).map(row => ({
    metric_name: row.metric_name, dimensions: row.dimensions, current_date: row.current_date, previous_date: row.previous_date,
    status: row.status, reason: row.reason,
    current_value_unscaled: row.current.length === 1 ? row.current[0].value_unscaled : null,
    previous_value_unscaled: row.previous.length === 1 ? row.previous[0].value_unscaled : null,
    delta_current_minus_previous: row.delta_current_minus_previous,
    current_observations: row.current, previous_observations: row.previous,
    selection_digest: analysis.selection_digest, source_completeness: analysis.source_completeness,
    row_kind: "daily_observation",
  }));
  for (const row of acquisitionPeriodRows(analysis.summaries, display)) {
    const { current, previous, dimensions } = row.summary;
    rows.push({ metric_name: row.metric_name, dimensions, current_date: null, previous_date: null,
      status: row.status, reason: row.reason, current_value_unscaled: row.current?.value_unscaled ?? null,
      previous_value_unscaled: row.previous?.value_unscaled ?? null,
      delta_current_minus_previous: row.delta_current_minus_previous,
      current_observations: current.sources, previous_observations: previous.sources,
      selection_digest: analysis.selection_digest, source_completeness: analysis.source_completeness,
      row_kind: "acquisition_period_summary", current_period_from: current.date_from, current_period_to: current.date_to,
      previous_period_from: previous.date_from, previous_period_to: previous.date_to,
      current_summary: { ...current, sources: undefined, values: row.current },
      previous_summary: { ...previous, sources: undefined, values: row.previous },
    });
  }
  return encodeCsv(rows, ["metric_name", "dimensions", "current_date", "previous_date", "status", "reason",
    "current_value_unscaled", "previous_value_unscaled", "delta_current_minus_previous", "current_observations",
    "previous_observations", "selection_digest", "source_completeness", "row_kind", "current_period_from", "current_period_to",
    "previous_period_from", "previous_period_to", "current_summary", "previous_summary"]);
}
