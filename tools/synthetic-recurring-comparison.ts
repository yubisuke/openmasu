import { readFileSync } from "node:fs";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { captureMetricComparisonContext } from "@openmasu/runtime/metric-comparison";
import { reportToSnapshot } from "../apps/api/src/report-snapshot.js";

/** Aggregate-only operator-upload examples, based on reviewed fixture33's definition, not new event evidence. */
export function syntheticRecurringSnapshot(day = "2026-08-01", value = "1500000") {
  const fixture = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json", "utf8"));
  const original = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/expected_metric_runs.json", "utf8")).find((row: any) => row.metric_run_id === "run-33:d7_roas");
  const cutoff = new Date(Date.parse(day) + 9 * 86400000).toISOString();
  const run = { ...original, metric_run_id: `synthetic-comparison:${day}:${value}`, value_unscaled: value,
    input_received_at_watermark: cutoff, input_snapshot_id: sha256(["synthetic-aggregate", day, value]),
    grouping: { ...original.grouping.dimensions, cohort_date: day } };
  const context = captureMetricComparisonContext(run, fixture.metric_definitions.find((d: any) => d.metric_name === "d7_roas"), fixture.fx_policy, "before", sha256);
  return reportToSnapshot({ data: [{ ...run, value_state: "present", superseded: false, comparison_context: context,
    policy_versions: [`rule_bundle:${run.rule_bundle_version}`, `fx:${context.fx.policy_version}`] }] }, {
    source: "synthetic-operator-aggregate", conditions: { date_from: day, date_to: new Date(Date.parse(day) + 86400000).toISOString().slice(0,10),
      time_zone: "UTC", maturity: "unknown", aggregation: "cumulative", attribution_scope: "non_organic",
      metric_definition: `${run.metric_name}@${run.metric_definition_version}`, source_cutoff: cutoff }, rows: [] });
}
export function syntheticComparisonRegistration() {
  return { name: "Synthetic daily comparison", first_date: "2026-08-01", last_date: "2026-08-03", watermark_lag_days: 9,
    retention_days: 30, mode: "captured", threshold: { value_unscaled: "300000", scale: 6 }, supersedes_id: null,
    left_snapshot: syntheticRecurringSnapshot(), right_snapshot: syntheticRecurringSnapshot("2026-08-01", "1750000") };
}
