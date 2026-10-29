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
import { acquisitionKpiRole, basisAcquisitionKpiDefinitions, calendarActivityMetricDefinitions } from "@openmasu/contracts/definitions";
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
  assert.deepEqual(result.summaries, []);
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
  assert.deepEqual(analysis.summaries, []);
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

const twoDayQuery = { ...query, dateTo: "2026-08-08" };
type MutableTestRow = { -readonly [K in keyof MetricReportRow]: MetricReportRow[K] } & { grouping: Record<string, string> };
function acquisitionDay(date: string, prefix: string, installs: string, cost: string, revenue: string): MutableTestRow[] {
  return rows(date, prefix).filter(row => row.grouping.campaign_id === "kpi70-a").map(row => {
    // Explicit hand-calculated operands. Daily ratios deliberately differ from
    // the period result and are never the source of period arithmetic.
    const values = { installs, cost, ad_revenue: revenue, purchase_net: "0", total_net: revenue,
      cpi: installs === "1" ? cost : "10000000", ad_roas: installs === "1" ? "1000000" : "2000000",
      total_roas: installs === "1" ? "1000000" : "2000000" };
    const result = structuredClone(row) as MutableTestRow;
    result.value_state = "present"; result.undefined_reason = null;
    result.value_unscaled = values[acquisitionKpiRole(row.metric_name)!];
    result.input_snapshot_id = sha256({ date, prefix });
    result.comparison_context!.input_snapshot_id = result.input_snapshot_id;
    result.input_received_at_watermark = date.endsWith("07") ? "2026-08-19T00:00:00.000Z" : "2026-08-20T00:00:00.000Z";
    return result;
  });
}
function periodOperands() {
  return {
    current: [...acquisitionDay("2026-08-06", "current-one", "1", "100000000", "100000000"),
      ...acquisitionDay("2026-08-07", "current-nine", "9", "90000000", "180000000")],
    previous: [...acquisitionDay("2026-08-04", "previous-one", "1", "100000000", "100000000"),
      ...acquisitionDay("2026-08-05", "previous-nine", "9", "90000000", "180000000")],
  };
}

it("acquisition_period_and_daily_alignment_keep_identical_campaigns_separate_by_basis_and_exact_provider", () => {
  const original=periodOperands();
  const convert=(source:readonly MetricReportRow[],basis:"selected_verified_platform"|"selected_imported_provider",provider?:string)=> {
    const definitions=basisAcquisitionKpiDefinitions(basis,provider);
    return source.map(row=> {
      const d=definitions.find(definition=>acquisitionKpiRole(definition.metric_name)===acquisitionKpiRole(row.metric_name))!;
      const metric_run_id=`${provider ?? "platform"}:${row.metric_run_id}`;
      return {...structuredClone(row),metric_run_id,metric_name:d.metric_name,metric_definition_version:d.metric_definition_version,
        rule_bundle_id:d.rule_bundle_id,rule_bundle_hash:d.rule_bundle_hash,policy_versions:[`rule_bundle:${d.rule_bundle_version}`],
        comparison_context:captureMetricComparisonContext({metric_run_id,input_snapshot_id:row.input_snapshot_id},d,input.fx_policy,"before",sha256)};
    });
  };
  const extend=(source:readonly MetricReportRow[])=>[...source,...convert(source,"selected_verified_platform"),
    ...convert(source,"selected_imported_provider","synthetic-alpha"),...convert(source,"selected_imported_provider","synthetic-beta")];
  const analysis=buildPeriodAnalysis(twoDayQuery,extend(original.current),extend(original.previous));
  assert.equal(analysis.summaries.length,4); assert.equal(analysis.rows.length,64);
  assert.ok(analysis.rows.every(row=>row.current.length===1&&row.previous.length===1&&row.status==="compared"));
  assert.ok(analysis.summaries.every(summary=>summary.current.state==="ready"&&summary.current.values!.installs.value_unscaled==="10"));
  const imported=analysis.summaries.filter(summary=>summary.dimensions.acquisition_basis==="selected_imported_provider");
  assert.deepEqual(imported.map(summary=>summary.dimensions.import_provider).sort(),["synthetic-alpha","synthetic-beta"]);
  assert.notDeepEqual(imported[0].current.sources.flatMap(source=>source.set_keys),imported[1].current.sources.flatMap(source=>source.set_keys));
  assert.ok(analysis.summaries.some(summary=>summary.dimensions.acquisition_basis==="selected_verified_platform"));
  const native=analysis.summaries.find(summary=>!summary.dimensions.acquisition_basis)!;
  assert.deepEqual(native,buildPeriodAnalysis(twoDayQuery,original.current,original.previous).summaries[0],"legacy native summary and identity remain unchanged");
  const saved={view_id:"synthetic-separated",name:"Synthetic basis-separated periods",selection:params.toString(),display:"all" as const,created_at:"2026-08-20T00:00:00.000Z"};
  const html=renderPeriodAnalysis(identity.appId,saved,analysis),csv=encodePeriodAnalysisCsv(analysis,"all");
  for (const text of ["selected_verified_platform","selected_imported_provider","synthetic-alpha","synthetic-beta","imported_acquisition_d7_cost","platform_acquisition_d7_cost"]) {
    assert.ok(html.includes(text),text); assert.ok(csv.includes(text),text);
  }
  assert.equal(csv.split(/\r?\n/).filter(line=>line.includes(",acquisition_period_summary,")).length,32);
});

it("acquisition_period_sums_integer_operands_before_weighted_CPI_ROAS_and_preserves_daily_rows_and_provenance", () => {
  const { current, previous } = periodOperands(), analysis = buildPeriodAnalysis(twoDayQuery, current, previous);
  assert.equal(analysis.rows.length, 16); assert.equal(analysis.summaries.length, 1);
  const summary = analysis.summaries[0], values = summary.current.values!;
  assert.equal(summary.current.state, "ready"); assert.equal(summary.current.observed_days, 2);
  assert.equal(values.installs.value_unscaled, "10"); assert.equal(values.cost.value_unscaled, "190000000");
  assert.equal(values.ad_revenue.value_unscaled, "280000000"); assert.equal(values.total_net.value_unscaled, "280000000");
  assert.equal(values.cpi.value_unscaled, "19000000"); assert.equal(values.cpi.label, "USD 19");
  assert.equal(values.ad_roas.value_unscaled, "1473684"); assert.equal(values.total_roas.label, "1.473684 ×");
  assert.ok(Object.values(summary.comparisons).every(value => value.status === "compared" && value.delta_current_minus_previous === "0"));
  assert.deepEqual(summary.current.sources.flatMap(source => source.runs.map(run => run.run_id)).sort(), current.map(row => row.metric_run_id).sort());
  assert.equal(new Set(summary.current.sources.flatMap(source => source.runs.map(run => run.snapshot_id))).size, 2);
  assert.equal(new Set(summary.current.sources.flatMap(source => source.runs.map(run => run.watermark))).size, 2);
  assert.ok(summary.current.sources.every(source => source.set_keys.length === 1 && source.runs.every(run => /^[a-f0-9]{64}$/.test(run.grouping_digest))));
  assert.equal(analysis.source_completeness, "unknown");
  const saved = { view_id: "synthetic-period", name: "Synthetic weighted period", selection: params.toString(), display: "all" as const,
    created_at: "2026-08-20T00:00:00.000Z" };
  const html = renderPeriodAnalysis(identity.appId, saved, analysis), csv = encodePeriodAnalysisCsv(analysis, "all");
  assert.match(html, /USD 19/); assert.match(html, /1\.473684 ×/); assert.match(html, /data-value-unscaled="1473684"/);
  assert.match(html, new RegExp(summary.current.selection_digest)); assert.match(csv, new RegExp(summary.current.selection_digest));
  assert.match(html, /data-analysis-summary-metric="acquisition_d7_ad_roas"/);
  const header = csv.split(/\r?\n/)[0];
  assert.equal(header.split(",").slice(0, 13).join(","), "metric_name,dimensions,current_date,previous_date,status,reason,current_value_unscaled,previous_value_unscaled,delta_current_minus_previous,current_observations,previous_observations,selection_digest,source_completeness");
  const summaryCsv = csv.split(/\r?\n/).filter(line => line.includes(",acquisition_period_summary,"));
  assert.equal(summaryCsv.length, 8); assert.match(summaryCsv.find(line => line.startsWith("acquisition_d7_ad_roas,"))!, /,1473684,1473684,0,/);
  assert.equal(csv.split(/\r?\n/).filter(line => line.includes(",daily_observation,")).length, 16);
  assert.doesNotMatch(html, /<script|javascript:|\son[a-z]+=/i);
});

it("acquisition_period_recomputes_undefined_daily_ratios_from_present_operands_and_keeps_zero_denominators_undefined", () => {
  const { current, previous } = periodOperands();
  for (const row of current) if (["cpi", "ad_roas", "total_roas"].includes(acquisitionKpiRole(row.metric_name)!)) {
    row.value_state = "undefined"; row.undefined_reason = "no_attributed_cost"; delete row.value_unscaled;
    row.currency = null; row.amount_scale = null;
  }
  const result = buildPeriodAnalysis(twoDayQuery, current, previous);
  assert.equal(result.summaries[0].current.values!.ad_roas.value_unscaled, "1473684");
  assert.equal(result.summaries[0].current.values!.cpi.value_unscaled, "19000000");
  assert.ok(result.rows.filter(row => row.metric_name.endsWith("roas")).every(row => row.status === "incomparable"));
  for (const row of current) if (["cost", "installs"].includes(acquisitionKpiRole(row.metric_name)!)) row.value_unscaled = "0";
  const zero = buildPeriodAnalysis(twoDayQuery, current, previous).summaries[0];
  assert.equal(zero.current.state, "ready"); assert.equal(zero.current.values!.cost.value_unscaled, "0");
  assert.equal(zero.current.values!.cpi.state, "undefined"); assert.equal(zero.current.values!.cpi.reason, "empty_cohort");
  assert.equal(zero.current.values!.ad_roas.value_unscaled, null); assert.equal(zero.current.values!.ad_roas.reason, "no_attributed_cost");
  assert.equal(zero.comparisons.ad_roas.delta_current_minus_previous, null);
  for (const row of current) if (acquisitionKpiRole(row.metric_name) === "cost") {
    row.value_state = "undefined"; row.undefined_reason = "no_attributed_cost"; delete row.value_unscaled;
  }
  const missing = buildPeriodAnalysis(twoDayQuery, current, previous).summaries[0];
  assert.equal(missing.current.reason, "no_attributed_cost"); assert.equal(missing.current.values, null);
});

it("acquisition_period_blocks_missing_duplicate_pending_immature_or_invalid_daily_sets_without_hiding_the_valid_other_side", () => {
  for (const kind of ["missing_day", "missing_role", "duplicate", "pending", "immature", "privacy", "fx_missing"] as const) {
    const { current, previous } = periodOperands();
    if (kind === "missing_day") current.splice(8);
    if (kind === "missing_role") current.splice(0, 1);
    if (kind === "duplicate") current.push(structuredClone(current[0]));
    if (kind === "pending") current[0].cost_update_state = "recalculation_pending";
    if (kind === "immature") for (const row of current) row.input_received_at_watermark = "2026-08-08T00:00:00.000Z";
    if (kind === "privacy") { current[0].value_state = "unavailable"; current[0].unavailable_reason = "privacy_deletion"; delete current[0].value_unscaled; }
    if (kind === "fx_missing") {
      const row = current.find(row => acquisitionKpiRole(row.metric_name) === "cost")!;
      row.value_state = "undefined"; row.undefined_reason = "missing_fx_rate"; delete row.value_unscaled;
    }
    const summary = buildPeriodAnalysis(twoDayQuery, current, previous).summaries[0];
    assert.equal(summary.current.state, "blocked", kind); assert.equal(summary.current.values, null, kind);
    assert.equal(summary.previous.state, "ready", kind); assert.equal(summary.previous.values!.cpi.value_unscaled, "19000000", kind);
    assert.ok(Object.values(summary.comparisons).every(comparison => comparison.status === "incomparable" && comparison.delta_current_minus_previous === null), kind);
    assert.equal(summary.current.reason, { missing_day: "missing_day", missing_role: "acquisition_set_incomplete_or_incompatible",
      duplicate: "multiple_daily_sets", pending: "recalculation_pending", immature: "window_not_elapsed", privacy: "historical_or_unavailable",
      fx_missing: "missing_fx_rate" }[kind]);
  }
});

it("acquisition_period_never_mixes_currency_FX_basis_definition_fraud_privacy_window_or_grain", () => {
  for (const kind of ["currency", "fx", "basis", "definition", "fraud", "privacy", "window", "grain"] as const) {
    const { current, previous } = periodOperands();
    for (const row of current.slice(8) as Any[]) {
      const context = row.comparison_context, d = context.definition;
      if (kind === "currency") { if (d.currency) { d.currency = "EUR"; row.currency = "EUR"; } context.fx.target_currency = "EUR"; }
      if (kind === "fx") context.fx.rates[0].rate_unscaled = "2";
      if (kind === "basis") d.acquisition_basis = "selected_verified_platform";
      if (kind === "definition") { d.metric_definition_version = "0.4.24"; row.metric_definition_version = "0.4.24"; }
      if (kind === "fraud") d.fraud_policy = "exclude_rejected";
      if (kind === "privacy") context.privacy_state = "after";
      if (kind === "window") d.definition.window.day = 8;
      if (kind === "grain") d.grouping_dimensions = d.grouping_dimensions.filter((key: string) => key !== "country");
      context.definition_digest = sha256(d); context.fx_digest = sha256(context.fx);
    }
    const summary = buildPeriodAnalysis(twoDayQuery, current, previous).summaries[0];
    assert.equal(summary.current.state, "blocked", kind); assert.equal(summary.current.values, null, kind);
    assert.equal(summary.previous.state, "ready", kind);
  }
});

it("acquisition_period_keeps_independently_valid_totals_but_suppresses_deltas_across_different_meanings_and_dimensions", () => {
  const { current, previous } = periodOperands();
  for (const row of previous) row.comparison_context!.privacy_state = "after";
  const summary = buildPeriodAnalysis(twoDayQuery, current, previous).summaries[0];
  assert.equal(summary.current.state, "ready"); assert.equal(summary.previous.state, "ready");
  assert.equal(summary.current.values!.ad_roas.value_unscaled, "1473684");
  assert.equal(summary.previous.values!.ad_roas.value_unscaled, "1473684");
  assert.ok(Object.values(summary.comparisons).every(value => value.reason === "meaning_fx_or_basis_mismatch" && value.delta_current_minus_previous === null));
  const another = structuredClone(current);
  for (const row of another) { row.grouping.country = "JP"; row.grouping_digest = sha256(row.grouping); }
  const separated = buildPeriodAnalysis(twoDayQuery, [...current, ...another], previous);
  assert.equal(separated.summaries.length, 2); assert.ok(separated.summaries.every(value => value.current.values!.installs.value_unscaled === "10"));
  assert.notEqual(buildPeriodAnalysis(twoDayQuery, current, []).selection_digest, separated.selection_digest);
});
