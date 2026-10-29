import { jcs } from "@openmasu/attribution-core/canonical";
import { compareSnapshots, parseSnapshot, comparisonDigest, canonicalComparisonCutoff } from "./cohort-comparison.js";
import { date, keys, object, type Snapshot } from "./comparison-model.js";
import { groupingDimensionAllowlist, validateGrouping, type GroupingDimension } from "./report-query-model.js";
import { capturedCohortPopulations, compareThreshold, parseComparisonThresholdPolicy, type ComparisonThresholdPolicy } from "./recurring-comparison-threshold.js";

export const recurringComparisonLimits = Object.freeze({ bytes: 4 * 1024 * 1024, rows: 10000, plans: 20, days: 366, retentionDays: 90, appBytes: 64 * 1024 * 1024 });
export type LocalComparisonReference = { metric_schedule_id: string; metric_name: string };
export type LocalComparisonSelection = LocalComparisonReference & {
  schedule_definition_digest: string; metric_definition_version: string; metric_definition_digest: string;
  date_dimension: "cohort_date" | "metric_date"; grouping: Partial<Record<GroupingDimension, string>>;
  grain: "campaign" | "ad_group" | "creative";
};
export function parseLocalComparisonReference(value: unknown): LocalComparisonReference {
  object(value); keys(value, ["metric_schedule_id", "metric_name"]);
  if (typeof value.metric_schedule_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.metric_schedule_id)
      || typeof value.metric_name !== "string" || !/^[a-z][a-z0-9_]{2,127}$/.test(value.metric_name)) throw Error("comparison_local_selection_invalid");
  return { metric_schedule_id: value.metric_schedule_id, metric_name: value.metric_name };
}
export type ComparisonDefinition = {
  first_date: string; last_date: string; watermark_lag_days: number; retention_days: number;
  mode: "captured" | "external_declared" | "declared_only";
  left_definition_digest: string; right_definition_digest: string;
  local_selection?: LocalComparisonSelection;
} & ({ version: 1; threshold: { value_unscaled: string; scale: number } }
  | { version: 2; threshold: ComparisonThresholdPolicy });
export function boundedComparisonSnapshot(value: unknown): Snapshot {
  if (Buffer.byteLength(jcs(value), "utf8") > recurringComparisonLimits.bytes) throw Error("comparison_snapshot_limit");
  const snapshot = parseSnapshot(value);
  for (const row of snapshot.rows) {
    let group: unknown; try { group = JSON.parse(row.key); } catch { throw Error("comparison_aggregate_grouping_required"); }
    object(group);
    if (!Object.keys(group).length || jcs(group) !== row.key) throw Error("comparison_aggregate_grouping_required");
    for (const [key, item] of Object.entries(group)) {
      if (!Object.hasOwn(groupingDimensionAllowlist, key) || typeof item !== "string") throw Error("comparison_identifying_grouping_forbidden");
      validateGrouping(key as GroupingDimension, item);
    }
  }
  return snapshot;
}
/** Execution/meaning identity, independent of the date's observed values and run IDs. */
export function snapshotDefinitionDigest(snapshot: Snapshot): string {
  return comparisonDigest({ metric_definition: snapshot.conditions.metric_definition,
    time_zone: snapshot.conditions.time_zone, aggregation: snapshot.conditions.aggregation,
    attribution_scope: snapshot.conditions.attribution_scope,
    definitions: [...new Set((snapshot.comparison_contexts ?? []).map(row => row.context.definition_digest))].sort(),
    external: snapshot.external_calculation?.declaration_sha256 ?? null });
}
export const followingDay = (day: string, days = 1) => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86400000).toISOString().slice(0, 10);
export const comparisonWatermark = (definition: ComparisonDefinition, day: string) => canonicalComparisonCutoff(`${followingDay(day, definition.watermark_lag_days)}T00:00:00Z`);
export function parseComparisonRegistration(value: unknown, local?: { selection: LocalComparisonSelection; snapshot: Snapshot }) {
  object(value); keys(value, ["name", "first_date", "last_date", "watermark_lag_days", "retention_days", "mode", "threshold", "right_snapshot", "supersedes_id",
    value.local_selection === undefined ? "left_snapshot" : "local_selection",
    ...(value.expected_left_snapshot_digest === undefined ? [] : ["expected_left_snapshot_digest"])]);
  if (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80 || /[\x00-\x1f\x7f]/.test(value.name)) throw Error("comparison_name_invalid");
  if (typeof value.first_date !== "string" || typeof value.last_date !== "string") throw Error("comparison_date_invalid");
  date(value.first_date); date(value.last_date);
  if (value.last_date < value.first_date || (Date.parse(value.last_date) - Date.parse(value.first_date)) / 86400000 >= recurringComparisonLimits.days) throw Error("comparison_period_limit");
  for (const key of ["watermark_lag_days", "retention_days"] as const) {
    if (!Number.isInteger(value[key]) || Number(value[key]) < 1 || Number(value[key]) > (key === "retention_days" ? 90 : 366)) throw Error("comparison_settings_invalid");
  }
  if (!["captured", "external_declared", "declared_only"].includes(String(value.mode))) throw Error("comparison_mode_invalid");
  object(value.threshold);
  const policy = "kind" in value.threshold ? parseComparisonThresholdPolicy(value.threshold) : undefined;
  if (!policy) {
    keys(value.threshold, ["value_unscaled", "scale"]);
    if (typeof value.threshold.value_unscaled !== "string" || !/^(0|[1-9]\d{0,99})$/.test(value.threshold.value_unscaled)
        || !Number.isInteger(value.threshold.scale) || Number(value.threshold.scale) < 0 || Number(value.threshold.scale) > 18) throw Error("comparison_threshold_invalid");
  }
  if (value.supersedes_id !== null && (typeof value.supersedes_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.supersedes_id))) throw Error("comparison_revision_invalid");
  if (value.local_selection !== undefined) {
    const reference = parseLocalComparisonReference(value.local_selection);
    if (value.left_snapshot !== undefined || !local || reference.metric_schedule_id !== local.selection.metric_schedule_id
        || reference.metric_name !== local.selection.metric_name) throw Error("comparison_local_capture_required");
  } else if (local || value.expected_left_snapshot_digest !== undefined) throw Error("comparison_local_selection_invalid");
  const left = boundedComparisonSnapshot(local?.snapshot ?? value.left_snapshot), right = boundedComparisonSnapshot(value.right_snapshot);
  if (policy?.minimum_population !== undefined && (value.mode === "declared_only"
      || !capturedCohortPopulations(policy.baseline === "left" ? left : right))) throw Error("comparison_population_unsupported");
  if (value.expected_left_snapshot_digest !== undefined && value.expected_left_snapshot_digest !== comparisonDigest(left)) throw Error("comparison_local_preview_changed");
  const definition: ComparisonDefinition = { first_date: value.first_date, last_date: value.last_date,
    watermark_lag_days: Number(value.watermark_lag_days), retention_days: Number(value.retention_days),
    mode: value.mode as ComparisonDefinition["mode"],
    ...(policy ? { version: 2 as const, threshold: policy }
      : { version: 1 as const, threshold: value.threshold as { value_unscaled: string; scale: number } }),
    left_definition_digest: snapshotDefinitionDigest(left), right_definition_digest: snapshotDefinitionDigest(right),
    ...(local ? { local_selection: local.selection } : {}) };
  for (const snapshot of [left, right]) assertSnapshotPeriod(definition, definition.first_date, snapshot);
  return { name: value.name.trim(), supersedes_id: value.supersedes_id as string | null, definition, left, right };
}
export function assertSnapshotPeriod(definition: ComparisonDefinition, day: string, snapshot: Snapshot): void {
  date(day);
  if (day < definition.first_date || day > definition.last_date || snapshot.conditions.date_from !== day
      || snapshot.conditions.date_to !== followingDay(day) || snapshot.conditions.source_cutoff !== comparisonWatermark(definition, day)) throw Error("comparison_snapshot_period_mismatch");
}
export function recurringComparisonResult(definition: ComparisonDefinition, day: string, left: Snapshot | null, right: Snapshot | null) {
  const base = { format: definition.version === 1 ? "scheduled-cohort-comparison-v1" : "scheduled-cohort-comparison-v2",
    ...(definition.version === 2 ? { threshold_policy: definition.threshold } : {}), target_date: day, watermark: comparisonWatermark(definition, day),
    definition_digest: comparisonDigest(definition), left_snapshot_digest: left ? comparisonDigest(left) : null,
    right_snapshot_digest: right ? comparisonDigest(right) : null };
  if (!left || !right) return { ...base, state: "missing_input", missing: [!left ? "left" : null, !right ? "right" : null].filter(Boolean) };
  if (snapshotDefinitionDigest(left) !== definition.left_definition_digest || snapshotDefinitionDigest(right) !== definition.right_definition_digest) {
    return { ...base, state: "incomparable", reason: "definition_changed" };
  }
  const result = compareSnapshots(left, right, { ...(definition.mode === "declared_only" ? { declaredOnly: true } : {}),
    ...(definition.mode === "external_declared" ? { allowExternalDeclaration: true } : {}) });
  if (result.status === "incomparable") return { ...base, state: "incomparable", comparison: result,
    ...(definition.version === 2 ? { reason: [result.assurance.left, result.assurance.right].some(side => side.missing.includes("window_maturity"))
      ? "maturity_unknown" : "meaning_incomparable" } : {}) };
  const populations = definition.version === 2 && definition.threshold.minimum_population !== undefined
    ? capturedCohortPopulations(definition.threshold.baseline === "left" ? left : right) : undefined;
  const rowStates = result.rows.map(row => {
    if (definition.version === 2) return { key: row.key, ...(result.status === "declared_comparison"
      ? { state: "unknown", reason: "declared_only" }
      : compareThreshold(definition.threshold, row.left, row.right, populations?.get(row.key))) };
    if (result.status === "declared_comparison" || row.delta_right_minus_left === undefined || row.scale === undefined) return { key: row.key, state: "unknown" };
    const scale = Math.max(row.scale, definition.threshold.scale);
    const delta = BigInt(row.delta_right_minus_left) * 10n ** BigInt(scale - row.scale);
    const absolute = delta < 0n ? -delta : delta;
    return { key: row.key, state: absolute > BigInt(definition.threshold.value_unscaled) * 10n ** BigInt(scale - definition.threshold.scale) ? "threshold_exceeded" : "within_threshold" };
  });
  const state = rowStates.some(row => row.state === "threshold_exceeded") ? "threshold_exceeded"
    : !rowStates.length || rowStates.some(row => row.state === "unknown") ? "unknown" : "within_threshold";
  return { ...base, state, thresholds: rowStates, comparison: result };
}
