import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { captureMetricComparisonContext } from "@openmasu/runtime/metric-comparison";
import type { OpenMasuMetricRunV04 } from "@openmasu/contracts/types";
import { buildAcquisitionKpiSets, acquisitionKpiSetKey } from "./acquisition-kpis.js";
import { buildDashboardView } from "./dashboard/view.js";
import { renderDashboard } from "./dashboard/render.js";
import type { MetricReportRow } from "./reporting.js";
type Any = Record<string, any>;
const scope = { tenantId: "tenant-a", appId: "app-a" };
const query = { ...scope, supersession: "latest" as const, limit: 200 };
const input: Any = JSON.parse(readFileSync("fixtures/v0.4/70-saved-acquisition-kpis/input.json", "utf8"));
const golden: OpenMasuMetricRunV04[] = JSON.parse(readFileSync("fixtures/v0.4/70-saved-acquisition-kpis/expected_metric_runs.json", "utf8"));
function rows(): MetricReportRow[] {
  return golden.map(run => ({ ...run, policy_versions: [`rule_bundle:${run.rule_bundle_version}`],
    value_state: run.value_state ?? "present", undefined_reason: run.undefined_reason ?? null,
    currency: run.currency ?? null, amount_scale: run.amount_scale ?? null, ratio_scale: run.ratio_scale ?? null,
    grouping: run.grouping!.dimensions, grouping_digest: run.grouping!.dimension_digest, superseded: false,
    supersedes_metric_run_id: null, cost_update_state: "no_recorded_revision", late_input_update_state: "no_recorded_request",
    attribution_update_state: "no_recorded_request", privacy_update_state: "not_affected",
    comparison_context: captureMetricComparisonContext({ metric_run_id: run.metric_run_id, input_snapshot_id: run.input_snapshot_id }, input.metric_definitions.find((d: Any) => d.metric_name === run.metric_name), input.fx_policy, "before", sha256),
  } as MetricReportRow));
}

it("acquisition_KPI_projection_aligns_eight_saved_roles_and_operand_run_refs_without_dividing", () => {
  const source = rows(), result = buildAcquisitionKpiSets(source, false, scope);
  assert.equal(result.sets.length, 4); assert.equal(result.omittedRows, 0);
  for (const set of result.sets) {
    assert.equal(set.state, "ready");
    assert.equal(new Set(Object.values(set.rows).map(row => acquisitionKpiSetKey(row, scope))).size, 1);
    assert.equal(acquisitionKpiSetKey(set.rows.installs, scope), set.key);
    assert.notEqual(acquisitionKpiSetKey(set.rows.installs, { ...scope, appId: "other-synthetic-app" }), set.key);
    assert.deepEqual(set.operands.cpi, { numerator: set.rows.cost.metric_run_id, denominator: set.rows.installs.metric_run_id });
    assert.deepEqual(set.operands.ad_roas, { numerator: set.rows.ad_revenue.metric_run_id, denominator: set.rows.cost.metric_run_id });
    assert.deepEqual(set.operands.total_roas, { numerator: set.rows.total_net.metric_run_id, denominator: set.rows.cost.metric_run_id });
  }
  const organic = result.sets.find(set => set.grouping.attribution_status === "organic")!;
  assert.equal(organic.rows.cpi.undefined_reason, "no_attributed_cost");
  const costOnly = result.sets.find(set => set.grouping.campaign_id === "kpi70-cost-only")!;
  assert.equal(costOnly.rows.cost.value_unscaled, "2000000"); assert.equal(costOnly.rows.cpi.undefined_reason, "empty_cohort");
  const html = renderDashboard(buildDashboardView({ apps: [], selectedAppId: "app-a", query, metrics: { data: source }, csrfToken: "synthetic" }));
  assert.match(html, /CPI \(USD\/install\)/); assert.match(html, /USD 3\.333333/); assert.match(html, /no_attributed_cost/);
  assert.match(html, /Numerator<\/a> \/ <a/); assert.match(html, /Purchase-net summand/);
  assert.doesNotMatch(html, /<script|javascript:/i);
});

it("acquisition_KPI_projection_refuses_partial_duplicates_mixed_snapshot_FX_cutoff_basis_and_units", () => {
  const source = rows().filter(row => row.metric_run_id.startsWith("kpi70-a:"));
  assert.deepEqual(buildAcquisitionKpiSets(source, true, scope).sets, []);
  assert.deepEqual(buildAcquisitionKpiSets([...source, source[0]], false, scope).sets, []);
  assert.deepEqual(buildAcquisitionKpiSets(source.slice(1), false, scope).sets, []);
  const mutations = [
    (row: Any) => { row.input_snapshot_id = "a".repeat(64); row.comparison_context.input_snapshot_id = row.input_snapshot_id; },
    (row: Any) => { row.comparison_context.fx.rates[0].rate_unscaled = "2"; row.comparison_context.fx_digest = sha256(row.comparison_context.fx); row.fx_conversion_snapshot = { policy: row.comparison_context.fx, snapshot_id: row.comparison_context.fx_digest }; },
    (row: Any) => { row.input_received_at_watermark = "2026-08-17T00:00:00.000Z"; },
    (row: Any) => { row.comparison_context.definition.acquisition_basis = "selected_verified_platform"; row.comparison_context.definition_digest = sha256(row.comparison_context.definition); },
    (row: Any) => { row.currency = "JPY"; },
  ];
  for (const mutate of mutations) {
    const altered = structuredClone(source), cost = altered.find(row => row.metric_name === "acquisition_d7_cost")!;
    mutate(cost); assert.deepEqual(buildAcquisitionKpiSets(altered, false, scope).sets, []);
  }
});

it("acquisition_KPI_projection_blocks_immature_pending_and_privacy_invalidated_sets", () => {
  for (const reason of ["window_not_elapsed", "recalculation_pending", "historical_or_unavailable"] as const) {
    const source = rows().filter(row => row.metric_run_id.startsWith("kpi70-a:"));
    if (reason === "window_not_elapsed") for (const row of source) (row as Any).input_received_at_watermark = "2026-08-14T00:00:00.000Z";
    else if (reason === "recalculation_pending") (source[0] as Any).cost_update_state = "recalculation_pending";
    else Object.assign(source[0], { value_state: "unavailable", reproducibility_status: "redaction_affected", unavailable_reason: "privacy_deletion" });
    const result = buildAcquisitionKpiSets(source, false, scope);
    assert.equal(result.sets.length, 1); assert.equal(result.sets[0].state, "blocked"); assert.equal(result.sets[0].reason, reason);
  }
});
