import assert from "node:assert/strict";
import { it } from "node:test";
import { capturedCohortPopulations, compareThreshold, parseComparisonThresholdPolicy, type ComparisonThresholdPolicy } from "./recurring-comparison-threshold.js";
import type { Row } from "./comparison-model.js";
import { syntheticComparisonRegistration, syntheticRecurringSnapshot } from "../../../tools/synthetic-recurring-comparison.js";
import { syntheticExternalComparisonCases, syntheticExternalComparisonPair } from "../../../tools/synthetic-external-comparison-cases.js";
import { comparisonDigest } from "./comparison-model.js";
import { parseComparisonRegistration, recurringComparisonResult } from "./recurring-comparison-model.js";

const row = (value: string, scale = 0): Row => ({ key: "synthetic", currency: "none", state: "present", value, scale });
const relative: ComparisonThresholdPolicy = { kind: "relative", baseline: "left", value_unscaled: "2", scale: 1 };

it("legacy absolute definition and stored result retain their pre-policy canonical bytes", () => {
  const parsed = parseComparisonRegistration(syntheticComparisonRegistration());
  assert.equal(parsed.definition.version, 1);
  // Captured from the unchanged v1 implementation before adding threshold policies.
  assert.equal(comparisonDigest(parsed.definition), "faa3d248c966e0214d326495db7b6f7f2195a64353bddd0c0ee227fdc64baadb");
  assert.equal(comparisonDigest(recurringComparisonResult(parsed.definition, parsed.definition.first_date, parsed.left, parsed.right)),
    "8a867a209e4a4ced91ed785766f7bad25f36b34e458bca2c3896d9ac88156614");
});

it("comparison threshold policy is closed and never coerces a relative percentage or population", () => {
  assert.deepEqual(parseComparisonThresholdPolicy(relative), relative);
  for (const invalid of [{ ...relative, baseline: "largest" }, { ...relative, kind: "statistical" },
    { ...relative, value_unscaled: "0.2" }, { ...relative, value_unscaled: "-1" }, { ...relative, scale: 19 },
    { ...relative, minimum_population: "0" }, { ...relative, minimum_population: 50 },
    { ...relative, population_basis: "result_row_count" }]) assert.throws(() => parseComparisonThresholdPolicy(invalid));
});

it("relative threshold uses the selected baseline and exact cross products for boundary and unequal scales", () => {
  // 125-100=25: 25/100=25% exceeds 20%; 25/125=20% is exactly within.
  assert.equal(compareThreshold(relative, row("100"), row("125")).state, "threshold_exceeded");
  assert.equal(compareThreshold({ ...relative, baseline: "right" }, row("100"), row("125")).state, "within_threshold");
  assert.equal(compareThreshold(relative, row("125", 2), row("1500", 3)).state, "within_threshold");
  assert.equal(compareThreshold(relative, row("125", 2), row("1501", 3)).state, "threshold_exceeded");
  // 1/3 is strictly above 0.333333: a rounded display must not decide the boundary.
  assert.equal(compareThreshold({ ...relative, value_unscaled: "333333", scale: 6 }, row("3"), row("4")).state, "threshold_exceeded");
  const base = "1" + "0".repeat(98), exact = "12" + "0".repeat(97);
  assert.equal(compareThreshold(relative, row(base), row(exact)).state, "within_threshold");
  assert.equal(compareThreshold(relative, row(base), row((BigInt(exact) + 1n).toString())).state, "threshold_exceeded");
});

it("absolute preserves negative arithmetic while relative zero negative missing and undefined remain unknown", () => {
  const absolute = { ...relative, kind: "absolute" as const, value_unscaled: "2", scale: 0 };
  assert.equal(compareThreshold(absolute, row("-3"), row("-10", 1)).state, "within_threshold");
  assert.equal(compareThreshold(absolute, row("-3"), row("-9", 1)).state, "threshold_exceeded");
  assert.deepEqual(compareThreshold(relative, row("0"), row("0")), { state: "unknown", reason: "zero_baseline" });
  assert.deepEqual(compareThreshold(relative, row("0"), row("1")), { state: "unknown", reason: "zero_baseline" });
  assert.deepEqual(compareThreshold(relative, row("-1"), row("2")), { state: "unknown", reason: "negative_operand" });
  assert.deepEqual(compareThreshold(relative, row("1"), row("-2")), { state: "unknown", reason: "negative_operand" });
  assert.deepEqual(compareThreshold(relative, null, row("2")), { state: "unknown", reason: "missing_left" });
  assert.deepEqual(compareThreshold(relative, row("2"), { key: "synthetic", currency: "none", scale: 0, state: "undefined", reason: "empty_cohort" }),
    { state: "unknown", reason: "undefined_operand" });
});

it("minimum population is only the captured cohort count and never report rows or an inferred ROAS denominator", () => {
  const entry = syntheticExternalComparisonCases().find(item => item.name === "native-acquisition-installs")!;
  const snapshot = syntheticExternalComparisonPair(entry).saved;
  assert.equal(capturedCohortPopulations(snapshot)?.get(snapshot.rows[0].key), "3");
  assert.equal(capturedCohortPopulations(syntheticRecurringSnapshot()), undefined);
  assert.equal(capturedCohortPopulations({ source: snapshot.source, conditions: snapshot.conditions, rows: snapshot.rows }), undefined);
  const missing = structuredClone(snapshot); missing.rows[0] = { ...missing.rows[0], state: "undefined", reason: "empty_cohort" } as Row;
  assert.equal(capturedCohortPopulations(missing), undefined);
  const immature = structuredClone(snapshot); immature.conditions.source_cutoff = immature.conditions.date_from + "T00:00:00.000000Z";
  assert.equal(capturedCohortPopulations(immature), undefined);
  const policy = { ...relative, minimum_population: "3" };
  assert.deepEqual(compareThreshold(policy, row("2"), row("2")), { state: "unknown", reason: "population_unknown" });
  assert.deepEqual(compareThreshold(policy, row("2"), row("2"), "2"), { state: "unknown", reason: "below_minimum_population" });
  assert.equal(compareThreshold(policy, row("3"), row("3"), "3").state, "within_threshold");
});

it("version two definitions bind policy while declaration maturity and unsupported population cannot become within", () => {
  const registration = { ...syntheticComparisonRegistration(), threshold: relative };
  const parsed = parseComparisonRegistration(registration);
  assert.equal(parsed.definition.version, 2);
  const result = recurringComparisonResult(parsed.definition, parsed.definition.first_date, parsed.left, parsed.right);
  assert.equal(result.format, "scheduled-cohort-comparison-v2"); assert.equal(result.state, "within_threshold");
  assert.ok("threshold_policy" in result); assert.deepEqual(result.threshold_policy, relative);
  const lower = parseComparisonRegistration({ ...registration, threshold: { ...relative, value_unscaled: "1" } });
  assert.notEqual(comparisonDigest(parsed.definition), comparisonDigest(lower.definition));
  assert.equal(recurringComparisonResult(lower.definition, lower.definition.first_date, lower.left, lower.right).state, "threshold_exceeded");
  assert.throws(() => parseComparisonRegistration({ ...registration, threshold: { ...relative, minimum_population: "1" } }), /population_unsupported/);
  const declared = parseComparisonRegistration({ ...registration, mode: "declared_only",
    left_snapshot: { source: parsed.left.source, conditions: parsed.left.conditions, rows: parsed.left.rows },
    right_snapshot: { source: parsed.right.source, conditions: parsed.right.conditions, rows: parsed.right.rows } });
  const unknown = recurringComparisonResult(declared.definition, declared.definition.first_date, declared.left, declared.right);
  assert.equal(unknown.state, "unknown"); assert.ok("thresholds" in unknown);
  assert.deepEqual(unknown.thresholds, [{ key: parsed.left.rows[0].key, state: "unknown", reason: "declared_only" }]);
  const immature = structuredClone(registration); immature.watermark_lag_days = 1;
  for (const snapshot of [immature.left_snapshot, immature.right_snapshot]) snapshot.conditions.source_cutoff = "2026-08-02T00:00:00.000000Z";
  const unelapsed = parseComparisonRegistration(immature);
  const notReady = recurringComparisonResult(unelapsed.definition, unelapsed.definition.first_date, unelapsed.left, unelapsed.right);
  assert.equal(notReady.state, "incomparable"); assert.ok("reason" in notReady); assert.equal(notReady.reason, "maturity_unknown");
  const cohort = syntheticExternalComparisonPair(syntheticExternalComparisonCases().find(item => item.name === "native-acquisition-installs")!).saved;
  const day = cohort.conditions.date_from;
  const counted = parseComparisonRegistration({ ...registration, first_date: day, last_date: day,
    watermark_lag_days: (Date.parse(cohort.conditions.source_cutoff) - Date.parse(day)) / 86400000,
    left_snapshot: cohort, right_snapshot: cohort, threshold: { ...relative, minimum_population: "4" } });
  const small = recurringComparisonResult(counted.definition, day, counted.left, counted.right);
  assert.equal(small.state, "unknown"); assert.ok("thresholds" in small);
  assert.deepEqual(small.thresholds, [{ key: cohort.rows[0].key, state: "unknown", reason: "below_minimum_population" }]);
});
