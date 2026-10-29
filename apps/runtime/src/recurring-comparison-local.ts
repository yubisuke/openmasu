import type { Pool, PoolClient } from "pg";
import { withTenant } from "./index.js";
import { comparisonDigest, parseSnapshot } from "./cohort-comparison.js";
import { fixedMetricSelections } from "./fixed-comparison.js";
import { comparisonExport, ComparisonExportError } from "./comparison-export.js";
import { projectMetricComparisonDefinition } from "./metric-comparison.js";
import type { OpenMasuMetricDefinitionV04 } from "@openmasu/contracts/types";
import { groupingDimensionAllowlist, validateGrouping, type MetricQuery, type GroupingDimension } from "./report-query-model.js";
import { comparisonWatermark, followingDay, parseLocalComparisonReference,
  type ComparisonDefinition, type LocalComparisonSelection } from "./recurring-comparison-model.js";

type Scope = { tenantId: string; appId: string };
type Schedule = { definition: { metric_definitions: OpenMasuMetricDefinitionV04[];
  evaluations: { metric_names: string[]; date_dimension: "cohort_date" | "metric_date";
    grouping: Record<string, unknown>; campaign_discovery?: { grain?: "ad_group" | "creative" } }[] }; definition_digest: string };

/** Resolve a single unambiguous schedule evaluation; never select a latest metric by name. */
export async function resolveLocalComparisonSelection(client: PoolClient, scope: Scope, input: unknown): Promise<LocalComparisonSelection> {
  const reference = parseLocalComparisonReference(input);
  const schedule = (await client.query<Schedule>(`SELECT definition,definition_digest FROM control.metric_schedules_current
    WHERE tenant_id=$1 AND app_id=$2 AND metric_schedule_id=$3 AND status='active'`,
    [scope.tenantId, scope.appId, reference.metric_schedule_id])).rows[0];
  if (!schedule || comparisonDigest(schedule.definition) !== schedule.definition_digest) throw Error("comparison_local_schedule_unavailable");
  const definitions = schedule.definition.metric_definitions.filter(row => row.metric_name === reference.metric_name);
  const evaluations = schedule.definition.evaluations.filter(row => row.metric_names.includes(reference.metric_name));
  if (definitions.length !== 1 || evaluations.length !== 1) throw Error("comparison_local_selection_ambiguous");
  const evaluation = evaluations[0], grouping: LocalComparisonSelection["grouping"] = {};
  for (const key of Object.keys(evaluation.grouping).sort()) {
    const value = evaluation.grouping[key];
    if (!Object.hasOwn(groupingDimensionAllowlist, key) || ["metric_date", "cohort_date"].includes(key)
        || typeof value !== "string") throw Error("comparison_local_selection_invalid");
    validateGrouping(key as GroupingDimension, value); grouping[key as GroupingDimension] = value;
  }
  return { ...reference, schedule_definition_digest: schedule.definition_digest,
    metric_definition_version: definitions[0].metric_definition_version,
    metric_definition_digest: comparisonDigest(projectMetricComparisonDefinition(definitions[0])), date_dimension: evaluation.date_dimension,
    grouping, grain: evaluation.campaign_discovery?.grain ?? "campaign" };
}

export function localComparisonQuery(scope: Scope, selection: LocalComparisonSelection, definition: ComparisonDefinition, day: string): MetricQuery {
  return { ...scope, metricScheduleId: selection.metric_schedule_id, metricNames: [selection.metric_name],
    metricDefinitionVersion: selection.metric_definition_version, grouping: selection.grouping,
    dateFrom: day, dateTo: followingDay(day), watermarkAtMost: comparisonWatermark(definition, day),
    supersession: "latest", limit: 1000 };
}

export async function captureLocalComparison(pool: Pool, scope: Scope, selection: LocalComparisonSelection, definition: ComparisonDefinition, day: string) {
  const current = await withTenant(pool, scope.tenantId, client => resolveLocalComparisonSelection(client, scope,
    { metric_schedule_id: selection.metric_schedule_id, metric_name: selection.metric_name }));
  if (comparisonDigest(current) !== comparisonDigest(selection)) throw Error("comparison_local_definition_changed");
  const query = localComparisonQuery(scope, selection, definition, day);
  return fixedMetricSelections(pool, scope, [query], ([rows], metadata) => {
    if (!rows.length) throw new ComparisonExportError("comparison_local_missing_runs");
    if (rows.some(row => row.comparison_context?.definition_digest !== selection.metric_definition_digest
        || row.grouping[selection.date_dimension] !== day)) throw new ComparisonExportError("comparison_local_definition_changed");
    const snapshot = parseSnapshot(JSON.parse(comparisonExport({ data: rows }, query, undefined, true)));
    if (snapshot.conditions.maturity !== "window_elapsed") throw new ComparisonExportError("comparison_local_window_not_elapsed");
    return { snapshot, privacyEpoch: metadata.privacyEpoch!, provenance: {
      source: "server_saved_runs" as const, metric_schedule_id: selection.metric_schedule_id,
      schedule_definition_digest: selection.schedule_definition_digest, selection_digest: comparisonDigest(selection),
      query_digest: comparisonDigest(query), privacy_epoch: metadata.privacyEpoch!, upstream_completeness: "unknown" as const,
    } };
  }, { capturePrivacyEpoch: true });
}
