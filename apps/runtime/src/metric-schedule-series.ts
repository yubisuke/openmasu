import { sha256 } from "@openmasu/attribution-core/canonical";
import type { OpenMasuMetricRunV04 as MetricRun } from "@openmasu/contracts/types";
import type { MetricComparisonContext } from "./metric-comparison.js";

/** Runtime provenance, not a new field in the public metric-run contract. */
export type MetricScheduleProvenance = Readonly<{
  metric_schedule_id: string;
  target_date: string;
  evaluation: number;
  definition_digest: string;
}>;

export type MetricScheduleHandoff = MetricScheduleProvenance & Readonly<{
  source_metric_run_id: string;
  calculation_key_digest: string;
  metric_name: string;
  grouping: Readonly<Record<string, string>>;
}>;

export type MetricScheduleReplacement = Readonly<{
  source_metric_schedule_id: string;
  mode: "same_meaning" | "new_series";
  request_digest: string;
  preview_digest: string;
  in_flight_policy: "wait_for_claimed_date";
  supersessions: readonly MetricScheduleHandoff[];
}>;

/** Preserve the original scheduled run identity, including discovery targets. */
export function scheduledMetricPrefix(input: Readonly<{
  metric_schedule_id: string;
  target_date: string;
  watermark: string;
  definition_digest: string;
  evaluation: number;
  target?: unknown;
  target_digest?: string;
}>): string {
  return `scheduled:${sha256(input).slice(0, 48)}`;
}

/** Full saved calculation keys, never a metric-name/latest heuristic. */
export function metricScheduleCalculationKey(
  scope: Readonly<{ tenant_id: string; app_id: string }>,
  run: MetricRun,
  context: MetricComparisonContext | null,
) {
  if (!context || context.metric_run_id !== run.metric_run_id
      || context.input_snapshot_id !== run.input_snapshot_id
      || sha256(context.definition) !== context.definition_digest
      || sha256(context.fx) !== context.fx_digest
      || context.definition.metric_name !== run.metric_name
      || context.definition.metric_definition_version !== run.metric_definition_version
      || context.definition.rule_bundle_hash !== run.rule_bundle_hash) {
    throw new Error("metric_schedule_source_key_unavailable");
  }
  return {
    ...scope, source_metric_run_id: run.metric_run_id, metric_name: run.metric_name,
    metric_definition_version: run.metric_definition_version,
    definition: context.definition, definition_digest: context.definition_digest,
    grouping: run.grouping?.dimensions ?? {}, grouping_digest: sha256(run.grouping?.dimensions ?? {}),
    input_snapshot_id: run.input_snapshot_id, input_received_at_watermark: run.input_received_at_watermark,
    rule_bundle_id: run.rule_bundle_id, rule_bundle_version: run.rule_bundle_version,
    rule_bundle_hash: run.rule_bundle_hash, aggregation_time_zone: run.aggregation_time_zone,
    value_type: run.value_type, fx: context.fx, fx_digest: context.fx_digest,
    privacy_state: context.privacy_state,
  };
}
