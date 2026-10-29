import { keys, object, snapshotAssurance, type Row, type Snapshot } from "./comparison-model.js";

/** Runtime policy only; legacy comparison definitions retain their original shape. */
export type ComparisonThresholdPolicy = {
  kind: "absolute" | "relative";
  baseline: "left" | "right";
  value_unscaled: string;
  scale: number;
  /** Minimum distinct installation cohort on the explicitly selected baseline side. */
  minimum_population?: string;
};
export type ThresholdOutcome = { state: "within_threshold" | "threshold_exceeded" }
  | { state: "unknown"; reason: "missing_left" | "missing_right" | "undefined_operand" | "unit_mismatch"
    | "zero_baseline" | "negative_operand" | "population_unknown" | "below_minimum_population" };

export function parseComparisonThresholdPolicy(value: unknown): ComparisonThresholdPolicy {
  object(value);
  keys(value, ["kind", "baseline", "value_unscaled", "scale", ...("minimum_population" in value ? ["minimum_population"] : [])]);
  if (!["absolute", "relative"].includes(String(value.kind)) || !["left", "right"].includes(String(value.baseline))
      || typeof value.value_unscaled !== "string" || !/^(0|[1-9]\d{0,99})$/.test(value.value_unscaled)
      || !Number.isInteger(value.scale) || Number(value.scale) < 0 || Number(value.scale) > 18
      || ("minimum_population" in value && (typeof value.minimum_population !== "string" || !/^[1-9]\d{0,99}$/.test(value.minimum_population)))) {
    throw Error("comparison_threshold_invalid");
  }
  return { kind: value.kind as ComparisonThresholdPolicy["kind"], baseline: value.baseline as ComparisonThresholdPolicy["baseline"],
    value_unscaled: value.value_unscaled, scale: Number(value.scale),
    ...(typeof value.minimum_population === "string" ? { minimum_population: value.minimum_population } : {}) };
}

/** A report's row count is not a population. Only the captured cohort-size operand is supported. */
export function capturedCohortPopulations(snapshot: Snapshot): Map<string, string> | undefined {
  if (snapshot.external_calculation || !snapshot.rows.length || snapshotAssurance(snapshot).assurance.meaning !== "definition_backed") return undefined;
  const contexts = new Map(snapshot.comparison_contexts?.map(item => [item.key, item.context]));
  const populations = new Map<string, string>();
  for (const row of snapshot.rows) {
    const definition = contexts.get(row.key)?.definition;
    if (!definition || definition.anchor_event !== "install" || definition.value_type !== "count"
        || definition.definition.calculation !== "cohort_size" || definition.definition.numerator !== "cohort_size"
        || row.state !== "present" || row.currency !== "none" || row.scale !== 0 || !/^(0|[1-9]\d{0,99})$/.test(row.value)) return undefined;
    populations.set(row.key, row.value);
  }
  return populations;
}

/** All inputs are normalized snapshot rows. No floating point, rounded ratio, or inferred denominator. */
export function compareThreshold(policy: ComparisonThresholdPolicy, left: Row | null, right: Row | null,
  baselinePopulation?: string): ThresholdOutcome {
  if (!left) return { state: "unknown", reason: "missing_left" };
  if (!right) return { state: "unknown", reason: "missing_right" };
  if (left.state !== "present" || right.state !== "present") return { state: "unknown", reason: "undefined_operand" };
  if (left.currency !== right.currency) return { state: "unknown", reason: "unit_mismatch" };
  if (policy.minimum_population !== undefined) {
    if (baselinePopulation === undefined || !/^(0|[1-9]\d{0,99})$/.test(baselinePopulation)) return { state: "unknown", reason: "population_unknown" };
    if (BigInt(baselinePopulation) < BigInt(policy.minimum_population)) return { state: "unknown", reason: "below_minimum_population" };
  }
  const scale = Math.max(left.scale, right.scale);
  const l = BigInt(left.value) * 10n ** BigInt(scale - left.scale);
  const r = BigInt(right.value) * 10n ** BigInt(scale - right.scale);
  const difference = r - l, magnitude = difference < 0n ? -difference : difference;
  let exceeded: boolean;
  if (policy.kind === "relative") {
    if (l < 0n || r < 0n) return { state: "unknown", reason: "negative_operand" };
    const baseline = policy.baseline === "left" ? l : r;
    if (baseline === 0n) return { state: "unknown", reason: "zero_baseline" };
    // Compare |right-left| / baseline to threshold exactly, without dividing.
    exceeded = magnitude * 10n ** BigInt(policy.scale) > baseline * BigInt(policy.value_unscaled);
  } else {
    const aligned = Math.max(scale, policy.scale);
    exceeded = magnitude * 10n ** BigInt(aligned - scale)
      > BigInt(policy.value_unscaled) * 10n ** BigInt(aligned - policy.scale);
  }
  return { state: exceeded ? "threshold_exceeded" : "within_threshold" };
}
