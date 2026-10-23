import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { captureMetricComparisonContext } from "@openmasu/runtime/metric-comparison";
import type { OpenMasuMetricRunV04 } from "@openmasu/contracts/types";
import { analysisQuery, savedAnalysisInput, previousAnalysisQuery, dailyAnalysisMetrics } from "./saved-analysis.js";
import { buildPeriodAnalysis, encodePeriodAnalysisCsv } from "./period-analysis.js";
import { renderPeriodAnalysis } from "./dashboard/saved-analysis.js";
import type { MetricReportRow } from "./reporting.js";
import { calendarActivityMetricDefinitions } from "@openmasu/contracts/definitions";
import { calendarActivityUnit } from "./metric-series.js";
type Any = Record<string, any>;
const identity = { tenantId: "tenant-a", appId: "app-a", keyId: "synthetic-analysis", role: "admin" as const };
const params = new URLSearchParams({ date_from: "2026-08-06", date_to: "2026-08-07", watermark_at_most: "2026-08-20T00:00:00.000Z" });
const query = analysisQuery(identity, params);
const input: Any = JSON.parse(readFileSync("fixtures/v0.4/70-saved-acquisition-kpis/input.json", "utf8"));
const golden: OpenMasuMetricRunV04[] = JSON.parse(readFileSync("fixtures/v0.4/70-saved-acquisition-kpis/expected_metric_runs.json", "utf8"));
function rows(date: string, prefix: string): MetricReportRow[] {
  return golden.map(original => {
    const run = structuredClone(original), grouping = { ...run.grouping!.dimensions, cohort_date: date };
    run.metric_run_id = `${prefix}:${run.metric_run_id}`;
    return { ...run, value_state: run.value_state ?? "present", undefined_reason: run.undefined_reason ?? null,
      policy_versions: [`rule_bundle:${run.rule_bundle_version}`], grouping, grouping_digest: sha256(grouping),
      currency: run.currency ?? null, amount_scale: run.amount_scale ?? null, ratio_scale: run.ratio_scale ?? null,
      superseded: false, supersedes_metric_run_id: null,
      cost_update_state: "no_recorded_revision", privacy_update_state: "not_affected",
      comparison_context: captureMetricComparisonContext(run, input.metric_definitions.find((d: Any) => d.metric_name === run.metric_name), input.fx_policy, "before", sha256),
    } as MetricReportRow;
  });
}

it("saved_analysis_persists_only_canonical_filters_and_display_not_scope_credentials_cursors_or_results", () => {
  const body = { name: "  Synthetic daily view  ", selection: params.toString(), display: "all" };
  const saved = savedAnalysisInput(identity, body);
  assert.equal(saved.name, "Synthetic daily view"); assert.deepEqual(analysisQuery(identity, new URLSearchParams(saved.selection)), query);
  assert.deepEqual(query.metricNames, dailyAnalysisMetrics);
  assert.equal(previousAnalysisQuery(query).dateFrom, "2026-08-05");
  for (const key of ["tenant_id", "app_id", "key", "after", "limit", "value_unscaled", "grouping_installation_id", "grouping_cohort_date", "supersession"]) {
    const invalid = new URLSearchParams(params); invalid.set(key, "synthetic");
    assert.throws(() => savedAnalysisInput(identity, { ...body, selection: invalid.toString() }), /analysis_filter_not_allowed/);
  }
  assert.throws(() => analysisQuery(identity, new URLSearchParams()), /dates_and_cutoff/);
  assert.throws(() => analysisQuery(identity, new URLSearchParams({ ...Object.fromEntries(params), date_from: "2024-01-01" })), /period_limit/);
});

it("period_analysis_aligns_campaigns_and_day_offsets_without_averaging_ratios_or_collapsing_duplicates", () => {
  const current = rows("2026-08-06", "current"), previous = rows("2026-08-05", "previous");
  const result = buildPeriodAnalysis(query, current, previous);
  assert.equal(result.current_count, 32); assert.equal(result.previous_count, 32); assert.equal(result.rows.length, 32);
  const ordinary = result.rows.filter(row => row.dimensions.campaign_id === "kpi70-a");
  assert.equal(ordinary.length, 8); assert.ok(ordinary.every(row => row.status === "compared" && row.delta_current_minus_previous === "0"));
  assert.ok(result.rows.some(row => row.reason === "no_attributed_cost"));
  assert.equal(buildPeriodAnalysis({ ...query, limit: 1 }, current, previous).selection_digest, result.selection_digest);
  const duplicate = buildPeriodAnalysis(query, [...current, current[0]], previous);
  assert.ok(duplicate.rows.some(row => row.reason === "multiple_saved_runs" && row.current.length === 2 && row.delta_current_minus_previous === null));
  assert.ok(buildPeriodAnalysis(query, current, []).rows.every(row => row.reason === "missing_previous"));
});

it("period_analysis_HTML_and_CSV_keep_undefined_immature_different_FX_and_basis_explicitly_incomparable", () => {
  for (const kind of ["undefined", "immature", "fx", "basis", "privacy"] as const) {
    const current = rows("2026-08-06", "current").filter(row => row.grouping.campaign_id === "kpi70-a");
    const previous = rows("2026-08-05", "previous").filter(row => row.grouping.campaign_id === "kpi70-a");
    for (const row of previous as Any[]) {
      const c = row.comparison_context;
      if (kind === "immature") row.input_received_at_watermark = "2026-08-07T00:00:00.000Z";
      if (kind === "fx") { c.fx.rates[0].rate_unscaled = "2"; c.fx_digest = sha256(c.fx); }
      if (kind === "basis") { c.definition.acquisition_basis = "selected_verified_platform"; c.definition_digest = sha256(c.definition); }
      if (kind === "privacy") { row.value_state = "unavailable"; row.unavailable_reason = "privacy_deletion"; delete row.value_unscaled; }
      if (kind === "undefined") { row.value_state = "undefined"; row.undefined_reason = "no_attributed_cost"; delete row.value_unscaled; }
    }
    const result = buildPeriodAnalysis(query, current, previous);
    assert.ok(result.rows.every(row => row.status === "incomparable" && row.delta_current_minus_previous === null), kind);
    const saved = { view_id: "synthetic", name: "Synthetic <analysis>", selection: params.toString(), display: "all" as const, created_at: "2026-08-20T00:00:00.000Z" };
    const html = renderPeriodAnalysis(identity.appId, saved, result), csv = encodePeriodAnalysisCsv(result, "all");
    for (const row of result.rows) { assert.ok(html.includes(row.reason!)); assert.ok(csv.includes(row.reason!)); }
    if (kind === "undefined") assert.ok(result.rows.every(row => row.previous[0].value_unscaled === null));
    assert.match(html, /Synthetic &lt;analysis&gt;/); assert.doesNotMatch(html, /<script|javascript:|\son[a-z]+=/i);
  }
});

it("period_analysis_retention_compares_saved_cohorts_but_never_invents_period_denominators", () => {
  const cohort: Any = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json", "utf8"));
  const definition = cohort.metric_definitions.find((d: Any) => d.metric_name === "retention_d1");
  const adapt = (date: string, id: string, value: string) => {
    const row = structuredClone(rows(date, id)[0]) as Any;
    row.metric_name = definition.metric_name; row.metric_definition_version = definition.metric_definition_version;
    row.rule_bundle_id = definition.rule_bundle_id; row.rule_bundle_hash = definition.rule_bundle_hash;
    row.policy_versions = [`rule_bundle:${definition.rule_bundle_version}`];
    row.value_type = "ratio"; row.ratio_scale = definition.ratio_scale; row.currency = null; row.amount_scale = null;
    row.value_unscaled = value; row.comparison_context = captureMetricComparisonContext({ metric_run_id: row.metric_run_id,
      input_snapshot_id: row.input_snapshot_id }, definition, cohort.fx_policy, "before", sha256);
    return row as MetricReportRow;
  };
  const result = buildPeriodAnalysis(query, [adapt("2026-08-06", "current", "333333")], [adapt("2026-08-05", "previous", "500000")]);
  assert.equal(result.rows[0].status, "compared"); assert.equal(result.rows[0].delta_current_minus_previous, "-166667");
  assert.equal(result.rows[0].current[0].value_unscaled, "333333");
});

it("period_analysis_aligns_daily_activity_without_summing_distinct_installations_into_period_users", () => {
  const definitions = calendarActivityMetricDefinitions();
  const adapt = (date: string, prefix: string): MetricReportRow[] => definitions.map(definition => {
    const row = structuredClone(rows(date, prefix)[0]) as Any;
    row.metric_run_id = `${prefix}:${date}:${definition.metric_name}`;
    row.metric_name = definition.metric_name; row.metric_definition_version = definition.metric_definition_version;
    row.rule_bundle_id = definition.rule_bundle_id; row.rule_bundle_hash = definition.rule_bundle_hash;
    row.policy_versions = [`rule_bundle:${definition.rule_bundle_version}`];
    row.grouping = { metric_date: date }; row.grouping_digest = sha256(row.grouping);
    row.value_type = "count"; row.ratio_scale = null; row.currency = null; row.amount_scale = null;
    row.value_unscaled = "2"; row.activity_unit = calendarActivityUnit(definition); row.activity_date = date;
    row.comparison_context = captureMetricComparisonContext({ metric_run_id: row.metric_run_id,
      input_snapshot_id: row.input_snapshot_id }, definition, input.fx_policy, "after", sha256);
    return row as MetricReportRow;
  });
  const selection = { ...query, dateTo: "2026-08-08", metricNames: definitions.map(definition => definition.metric_name) };
  const current = [...adapt("2026-08-06", "current"), ...adapt("2026-08-07", "current")];
  const previous = [...adapt("2026-08-04", "previous"), ...adapt("2026-08-05", "previous")];
  const analysis = buildPeriodAnalysis(selection, current, previous);
  assert.equal(analysis.rows.length, 6);
  assert.ok(analysis.rows.every(row => row.status === "compared" && row.current[0].value_unscaled === "2"
    && row.delta_current_minus_previous === "0"));
  assert.deepEqual(analysis.rows.filter(row => row.metric_name === "daily_active_installations")
    .map(row => row.current[0].activity_unit), ["distinct_installations", "distinct_installations"]);
  const saved = { view_id: "synthetic-activity", name: "Synthetic daily activity", selection: params.toString(),
    display: "all" as const, created_at: "2026-08-20T00:00:00.000Z" };
  const html = renderPeriodAnalysis(identity.appId, saved, analysis), csv = encodePeriodAnalysisCsv(analysis, "all");
  assert.match(html, /2 distinct installations \(not people\)/); assert.match(html, /activity-date offset/);
  assert.match(html, /never summed into period-unique users/); assert.match(csv, /distinct_installations/);
  assert.match(csv, /2026-08-07/); assert.doesNotMatch(html, /<script|javascript:|\son[a-z]+=/i);
  const wrongDate = structuredClone(current[0]) as Any;
  wrongDate.grouping = { cohort_date: "2026-08-06" }; wrongDate.grouping_digest = sha256(wrongDate.grouping);
  assert.equal(buildPeriodAnalysis(selection, [wrongDate as MetricReportRow], previous).rows.find(row => row.metric_name === wrongDate.metric_name)!.reason, "meaning_unverified");
});
