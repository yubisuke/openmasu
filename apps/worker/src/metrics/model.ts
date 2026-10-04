import type { PoolClient } from "pg";
import type { OpenMasuMetricDefinitionV04, OpenMasuMetricRunV04 } from "@openmasu/contracts/types";
import type { ScopedCost } from "@openmasu/attribution-core";
import type { ComparisonFx, RoasOperands, TotalNetRoasOperands, MetricScheduleProvenance, MetricScheduleHandoff } from "@openmasu/runtime";

export type MetricClient = Pick<PoolClient, "query">;
export type MetricScope = { tenant_id: string; app_id: string };
export type MetricDefinition = OpenMasuMetricDefinitionV04;
export type MetricRun = OpenMasuMetricRunV04;
export type MetricGrouping = NonNullable<MetricRun["grouping"]>["dimensions"];
export type MetricFxRate = ComparisonFx["rates"][number] & { source: string; [key: string]: unknown };
export type MetricFxPolicy = Omit<ComparisonFx, "rates"> & {
  rates: MetricFxRate[];
  [key: string]: unknown;
};
export type MetricEvaluation = {
  metric_run_id_prefix: string;
  input_received_at_watermark: string;
  computed_at: string;
  data_freshness: MetricRun["data_freshness"];
  privacy_state: "before" | "after";
  metric_names?: readonly string[];
  grouping?: MetricGrouping;
  supersedes_metric_run_id?: string;
  supersedes_metric_run_id_prefix?: string;
  metric_schedule?: MetricScheduleProvenance;
  schedule_supersessions?: Readonly<Record<string, MetricScheduleHandoff>>;
  [key: string]: unknown;
};

/** Calculation boundary, not proof that a legacy fixture passed a closed schema. */
export type MetricCalculationInput = {
  fx_policy: MetricFxPolicy;
  metric_definitions?: readonly MetricDefinition[];
  metric_evaluations?: readonly MetricEvaluation[];
};
export type PreparedMetricCalculation = {
  fxPolicy: MetricFxPolicy;
  definitions: ReadonlyMap<string, MetricDefinition>;
  evaluations: readonly MetricEvaluation[];
};
export type MetricValue = ({ value_state: "present"; value_unscaled: string } | {
  value_state: "undefined"; undefined_reason: NonNullable<MetricRun["undefined_reason"]>;
}) & { operands?: RoasOperands; revenueAggregates?: RoasOperands; totalNetOperands?: TotalNetRoasOperands };

export type SnapshotRecord = {
  tenant_id: string;
  app_id: string;
  record_id: string;
  received_at: string;
  lifecycle_status: "available" | "redacted" | "purged";
  privacy_request_id: string | null;
};
export type CurrentCost = {
  tenant_id: string;
  app_id: string;
  cost_record_id: string;
  as_of: string;
  report_snapshot_digest: string;
  dimension_digest: string;
};
export type DisjointCost = CurrentCost & ScopedCost & { currency: string; spend_unscaled: string; spend_scale: number };
export type CostSelection = { rows: DisjointCost[]; overlapping: boolean };
export type SnapshotScan = {
  records: SnapshotRecord[];
  append: (row: unknown) => void;
  finish: (costRows: unknown[]) => string;
};
export type MetricReplayArtifact = {
  version: 1;
  source_metric_run_id: string;
  metric_definition: MetricDefinition;
  evaluation: MetricEvaluation;
  fx_policy: MetricFxPolicy;
};

/** Contract order is UTF-16 text order, independent of PostgreSQL collation. */
export function compareMetricText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
