import { readFileSync } from "node:fs";
import { evaluate, sha256 } from "@openmasu/attribution-core";
import { captureMetricComparisonContext } from "@openmasu/runtime/metric-comparison";
import { syntheticRetentionCases } from "./synthetic-retention-cases.js";
import type { ExternalCohortDeclaration } from "../apps/api/src/external-calculation-declaration.js";
import { reportToSnapshot } from "../apps/api/src/report-snapshot.js";

type Any = Record<string, any>;
const fixture = (name: string): Any => JSON.parse(readFileSync(`fixtures/v0.4/${name}/input.json`, "utf8"));
const axes = ["campaign_id", "network", "country", "cohort_date", "attribution_status"] as const;
const declared = (): ExternalCohortDeclaration => ({
  version: 2, profile: "external-install-cohort-v2", anchor_event: "install", calculation: "revenue_sum",
  numerator: "total_net_revenue", denominator: null, aggregation: "cumulative", time_zone: "UTC",
  window: { type: "elapsed", day: 30, boundary: "half_open" }, population: "accepted_installation_cohort",
  acquisition_basis: "recorded_dimensions", cost_basis: null, cost_selection_policy: "legacy_dimension_digest_latest",
  grouping_dimensions: [...axes], fraud_policy: "gross", privacy_state: "before", value_type: "money",
  currency: "USD", amount_scale: 6, ratio_scale: null, calendar_cohort_policy: null, cohort_date_basis: null,
  cost_reporting_time_zone: null, retention_maturity_policy: null, acquisition_dimension_policy: null,
  refund_policy: "settled_linked_refunds_own_window", refund_reversal_policy: null, conversion_event_key: null,
  activity_events: [], event_names: [], final_rounding: "half_even",
  fx: { target_currency: "USD", target_scale: 6, conversion: "per_event_round_then_sum", rounding_mode: "half_even",
    rates: [{ currency: "USD", rate_unscaled: "1000000", rate_scale: 6, as_of: "2026-08-01T00:00:00.000Z" }] },
});

/** Test-only inputs and hand-derived constants; never use the production semantic projection as an oracle. */
export function syntheticExternalComparisonCases() {
  const cases: { name: string; input: Any; metricName: string; expected: string; declaration: ExternalCohortDeclaration }[] = [];
  const total = fixture("56-d30-d90-total-net-metrics");
  // Three installations: ad 4 + purchase 10 - refund 2 = 12; cost 8; LTV 12/3 = 4.
  total.records.find((r: Any) => r.record_id === "ad-revenue-56-d30").payload.amount_unscaled = "4000000";
  total.cost_records[0].amount_unscaled = "8000000";
  const install = total.records.find((r: Any) => r.event_name === "install");
  for (const n of [2, 3]) total.records.push({ ...structuredClone(install), record_id: `comparison-install-${n}`,
    event_id: `event:comparison-install-${n}`, delivery_id: `delivery:comparison-install-${n}`,
    payload: { ...structuredClone(install.payload), installation_id: `installation:comparison-${n}` } });
  for (const [metricName, expected, patch] of [
    ["cohort_purchase_net_revenue_d30_usd", "8000000", { numerator: "purchase_net_revenue" }],
    ["cohort_total_net_revenue_d30_usd", "12000000", {}],
    ["d30_total_net_roas", "1500000", { calculation: "revenue_over_cost", denominator: "cost", cost_basis: "cohort_acquisition_day_current_snapshot", value_type: "ratio", currency: null, amount_scale: null, ratio_scale: 6 }],
    ["cohort_total_net_ltv_d30_usd", "4000000", { calculation: "revenue_over_cohort", denominator: "cohort_size" }],
  ] as const) cases.push({ name: metricName, input: total, metricName, expected, declaration: { ...declared(), ...patch } });

  const reversal = fixture("62-explicit-refund-reversal");
  // Re-evaluate the same synthetic evidence at a mature watermark, not by relabeling a saved run.
  reversal.metric_evaluations = [{ ...reversal.metric_evaluations[2], input_received_at_watermark: "2026-09-08T00:00:00.000Z", computed_at: "2026-09-08T00:00:00.000Z" }];
  cases.push({ name: "explicit-refund-cancellation", input: reversal, metricName: "cohort_purchase_net_revenue_d30_usd", expected: "10000000",
    declaration: { ...declared(), numerator: "purchase_net_revenue", acquisition_basis: "selected_first_party_click",
      refund_reversal_policy: "cancel_target_refund_at_watermark", fx: { ...declared().fx!, rates: [{ currency: "USD", rate_unscaled: "100000000", rate_scale: 8, as_of: "2026-08-12T00:00:00.000Z" }] } } });

  const retention = syntheticRetentionCases(fixture("58-selected-native-acquisition")).find(c => c.name === "standard-excluded-install-gross-net")!.input;
  // One active installation out of two; repeated sessions count once (gross). Net is a genuine zero.
  cases.push({ name: "retention-distinct-installations", input: retention, metricName: "retention_d3_gross", expected: "500000",
    declaration: { ...declared(), calculation: "active_installations_over_cohort", numerator: "active_installations", denominator: "cohort_size",
      aggregation: "on_day", window: { type: "activity_day", day: 3, boundary: "half_open" }, acquisition_basis: "selected_first_party_click",
      retention_maturity_policy: "complete_activity_window", activity_events: ["session_start"], refund_policy: null,
      value_type: "ratio", currency: null, amount_scale: null, ratio_scale: 6, fx: null } });
  cases.push({ name: "conversion-distinct-installations", input: fixture("61-custom-conversion"), metricName: "cohort_custom_event_conversion_rate_d7", expected: "300000",
    declaration: { ...declared(), calculation: "converted_installations_over_cohort", numerator: "converted_installations", denominator: "cohort_size",
      window: { type: "elapsed", day: 7, boundary: "half_open" }, acquisition_basis: "selected_first_party_click", conversion_event_key: "tutorial_complete",
      refund_policy: null, value_type: "ratio", currency: null, amount_scale: null, ratio_scale: 6, fx: null } });
  const dated = fixture("55-purchase-refund-net-revenue");
  dated.metric_evaluations[0].grouping = { cohort_date: "2026-08-01" };
  for (const definition of dated.metric_definitions) definition.grouping_dimensions = [...axes];
  dated.fx_policy = { policy_version: "0.4.22", target_currency: "USD", target_scale: 6, rounding_mode: "half_even",
    rate_selection: "utc_event_date_and_cost_date", rates: [
      { currency: "EUR", effective_date: "2026-08-01", rate_unscaled: "125", rate_scale: 2, source: "synthetic-day-one", as_of: "2026-08-01T00:00:00.000Z" },
      { currency: "EUR", effective_date: "2026-08-02", rate_unscaled: "15", rate_scale: 1, source: "synthetic-day-two", as_of: "2026-08-02T00:00:00.000Z" },
    ] };
  // EUR 8 * 1.25 - EUR 3.2 * 1.5 = USD 5.2; each money event uses its own UTC date.
  cases.push({ name: "dated-purchase-refund-FX", input: dated, metricName: "cohort_purchase_net_revenue_d1_usd", expected: "5200000",
    declaration: { ...declared(), numerator: "purchase_net_revenue", window: { type: "elapsed", day: 1, boundary: "half_open" },
      fx: { ...declared().fx!, rate_selection: "utc_event_date_and_cost_date", cost_conversion: "per_cost_row_round_then_sum", rates: structuredClone(dated.fx_policy.rates) } } });
  const calendar = fixture("68-calendar-acquisition-cohorts");
  calendar.metric_evaluations = [calendar.metric_evaluations.find((e: Any) => e.metric_run_id_prefix === "calendar68-native-jst")];
  // Tokyo D7 contains 1+2+4+8+16+32 = 63 USD and one installation.
  cases.push({ name: "calendar-Tokyo-LTV", input: calendar, metricName: "calendar_jst_cohort_ltv_d7_usd", expected: "63000000",
    declaration: { ...declared(), numerator: "revenue", calculation: "revenue_over_cohort", denominator: "cohort_size",
      time_zone: "Asia/Tokyo", window: { type: "calendar_day", day: 7, boundary: "half_open" }, acquisition_basis: "selected_first_party_click", privacy_state: "after",
      calendar_cohort_policy: "cumulative_revenue_on_day_activity", cohort_date_basis: "installation_local_date", cost_reporting_time_zone: "same_as_aggregation_time_zone", refund_policy: null,
      fx: { ...declared().fx!, rates: [{ currency: "USD", rate_unscaled: "100000000", rate_scale: 8, as_of: "2026-08-01T00:00:00.000Z" }] } } });
  return cases;
}

export function syntheticExternalComparisonPair(entry: ReturnType<typeof syntheticExternalComparisonCases>[number]) {
  const run = evaluate(entry.input).metric_runs.find(r => r.metric_name === entry.metricName)!;
  const definition = entry.input.metric_definitions.find((d: Any) => d.metric_name === entry.metricName);
  const evaluation = entry.input.metric_evaluations.find((e: Any) => `${e.metric_run_id_prefix}:${entry.metricName}` === run.metric_run_id);
  const context = captureMetricComparisonContext(run, definition, entry.input.fx_policy, evaluation.privacy_state, sha256);
  const grouping = run.grouping!.dimensions, date = grouping.cohort_date!;
  const template = { source: "synthetic-captured-family", conditions: { date_from: date,
    date_to: new Date(Date.parse(date) + 86_400_000).toISOString().slice(0, 10), time_zone: run.aggregation_time_zone, maturity: "not_assumed",
    aggregation: entry.declaration.aggregation, attribution_scope: grouping.attribution_status ?? "all",
    metric_definition: `${run.metric_name}@${run.metric_definition_version}`, source_cutoff: run.input_received_at_watermark }, rows: [] };
  const report = { data: [{ ...run, value_state: run.value_state ?? "present", grouping, superseded: false, comparison_context: context,
    policy_versions: [`rule_bundle:${run.rule_bundle_version}`, `fx:${context.fx.policy_version}`] }] };
  const mapping = { version: 1, source: "synthetic-external-family", conditions: { ...template.conditions },
    grouping: Object.fromEntries(Object.entries(grouping).map(([key, value]) => [key, { constant: value }])),
    value: { column: "value", input: "integer", scale: 6, currency: { constant: entry.declaration.value_type === "money" ? "USD" : "none" },
      undefined: { marker: "", reason: { constant: "empty_cohort" } } }, external_calculation: structuredClone(entry.declaration) };
  return { run, context, template, report, mapping, saved: reportToSnapshot(report, template), csv: `value\n${entry.expected}\n` };
}
