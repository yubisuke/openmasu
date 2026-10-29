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
import { acquisitionKpiRole, basisAcquisitionKpiDefinitions } from "@openmasu/contracts/definitions";
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
function basisRows(source: readonly MetricReportRow[], basis: "selected_verified_platform" | "selected_imported_provider", provider?: string) {
  const definitions = basisAcquisitionKpiDefinitions(basis, provider);
  return source.map(row => {
    const definition = definitions.find(d => acquisitionKpiRole(d.metric_name) === acquisitionKpiRole(row.metric_name))!;
    const metric_run_id = `${provider ?? "platform"}:${row.metric_run_id}`;
    return { ...structuredClone(row),metric_run_id,metric_name:definition.metric_name,metric_definition_version:definition.metric_definition_version,
      rule_bundle_id:definition.rule_bundle_id,rule_bundle_hash:definition.rule_bundle_hash,policy_versions:[`rule_bundle:${definition.rule_bundle_version}`],
      comparison_context:captureMetricComparisonContext({metric_run_id,input_snapshot_id:row.input_snapshot_id},definition,input.fx_policy,"before",sha256) };
  });
}

it("acquisition_KPI_projection_aligns_eight_saved_roles_and_operand_run_refs_without_dividing", () => {
  const source = rows(), result = buildAcquisitionKpiSets(source, false, scope);
  assert.equal(acquisitionKpiSetKey(source.find(row => row.metric_run_id === "kpi70-a:acquisition_d7_installs")!,scope),
    "4060671b4b293c5547120a29348c52b3198ac0ecaf29d1330da803d4e0b03946","legacy native calculation key stays byte-identical");
  const authorizedIdentity = { ...scope, keyId: "synthetic-kpi70", role: "admin" as const };
  assert.deepEqual(buildAcquisitionKpiSets(source, false, authorizedIdentity), result);
  assert.equal(result.sets.length, 4); assert.equal(result.omittedRows, 0);
  for (const set of result.sets) {
    assert.equal(set.state, "ready");
    assert.equal(new Set(Object.values(set.rows).map(row => acquisitionKpiSetKey(row, scope))).size, 1);
    assert.equal(acquisitionKpiSetKey(set.rows.installs, scope), set.key);
    assert.equal(acquisitionKpiSetKey(set.rows.installs, authorizedIdentity), set.key);
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

it("acquisition_KPI_projection_separates_native_platform_and_exact_import_provider_even_without_population", () => {
  const native=rows().filter(row=>row.metric_run_id.startsWith("kpi70-a:"));
  const platform=basisRows(native,"selected_verified_platform"), providerA=basisRows(native,"selected_imported_provider","synthetic-alpha"),
    providerB=basisRows(native,"selected_imported_provider","synthetic-beta");
  const source=[...native,...platform,...providerA,...providerB], result=buildAcquisitionKpiSets(source,false,scope);
  assert.equal(result.sets.length,4); assert.equal(result.omittedRows,0);
  assert.equal(new Set(result.sets.map(set=>set.key)).size,4);
  assert.deepEqual(result.sets.map(set=>`${set.basis}:${set.importProvider ?? ""}`).sort(),[
    "selected_first_party_click:","selected_imported_provider:synthetic-alpha","selected_imported_provider:synthetic-beta","selected_verified_platform:"].sort());
  assert.ok(result.sets.every(set=>Object.values(set.rows).every(row=>acquisitionKpiSetKey(row,scope)===set.key)));
  assert.equal(buildAcquisitionKpiSets([...providerA.slice(0,4),...providerB.slice(4)],false,scope).sets.length,0);
  const html=renderDashboard(buildDashboardView({apps:[],selectedAppId:"app-a",query,metrics:{data:source},csrfToken:"synthetic"}));
  assert.match(html,/Native first-party click/); assert.match(html,/Verified platform/);
  assert.match(html,/Imported provider: synthetic-alpha/); assert.match(html,/Imported provider: synthetic-beta/);
  assert.match(html,/provider-reported/);
  const empty = native.map(row=>({...row,value_state:"undefined" as const,value_unscaled:undefined,undefined_reason:"empty_cohort",
    input_snapshot_id:sha256([])}));
  const emptyA=basisRows(empty,"selected_imported_provider","synthetic-alpha"),emptyB=basisRows(empty,"selected_imported_provider","synthetic-beta");
  const emptySets=buildAcquisitionKpiSets([...emptyA,...emptyB],false,scope).sets;
  assert.equal(emptySets.length,2); assert.notEqual(emptySets[0].key,emptySets[1].key);
  assert.ok(emptySets.every(set=>set.rows.installs.value_state==="undefined"));
});

it("acquisition_KPI_basis_projection_keeps_missing_roles_cost_refusals_immaturity_and_strict_context_visible", () => {
  const native=rows().filter(row=>row.metric_run_id.startsWith("kpi70-a:"));
  const source=basisRows(native,"selected_imported_provider","synthetic-alpha");
  assert.equal(buildAcquisitionKpiSets(source.slice(1),false,scope).sets.length,0);
  const incomplete=structuredClone(source);
  for (const row of incomplete) if (["cost","cpi","ad_roas","total_roas"].includes(acquisitionKpiRole(row.metric_name)!))
    Object.assign(row,{value_state:"undefined",value_unscaled:undefined,undefined_reason:"overlapping_cost_grains"});
  const projected=buildAcquisitionKpiSets(incomplete,false,scope);
  assert.equal(projected.sets.length,1); assert.equal(projected.sets[0].rows.cost.undefined_reason,"overlapping_cost_grains");
  const immature=source.map(row=>({...row,input_received_at_watermark:"2026-08-14T00:00:00.000Z"}));
  assert.equal(buildAcquisitionKpiSets(immature,false,scope).sets[0].reason,"window_not_elapsed");
  for (const invalid of ["provider", "window", "basis"] as const) {
    const altered=structuredClone(source) as Any[];
    for (const row of altered) {
      const definition=row.comparison_context.definition;
      if (invalid==="provider") delete definition.import_provider;
      if (invalid==="window") definition.definition.window.day=6;
      if (invalid==="basis") definition.acquisition_basis="selected_verified_platform";
      row.comparison_context.definition_digest=sha256(definition);
    }
    assert.equal(buildAcquisitionKpiSets(altered as MetricReportRow[],false,scope).sets.length,0,invalid);
  }
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
