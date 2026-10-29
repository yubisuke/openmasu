import assert from "node:assert/strict";
import { it } from "node:test";
import { jcs } from "@openmasu/attribution-core/canonical";
import { comparisonDigest, compareSnapshots } from "./cohort-comparison.js";
import { parseComparisonRegistration, recurringComparisonResult, boundedComparisonSnapshot, assertSnapshotPeriod } from "./recurring-comparison-model.js";
import { syntheticComparisonRegistration, syntheticRecurringSnapshot } from "../../../tools/synthetic-recurring-comparison.js";
import { syntheticExternalComparisonCases, syntheticExternalComparisonPair } from "../../../tools/synthetic-external-comparison-cases.js";
import { aggregateCsvToSnapshot } from "../../api/src/aggregate-csv-snapshot.js";

it("recurring_comparison_reuses_exact_delta_and_separates_unknown_missing_definition_and_threshold", () => {
  const { definition, left, right } = parseComparisonRegistration(syntheticComparisonRegistration());
  const result = recurringComparisonResult(definition, "2026-08-01", left, right);
  assert.equal(result.state, "within_threshold");
  assert.ok("comparison" in result); assert.equal(result.comparison.rows[0].delta_right_minus_left, "250000");
  assert.equal(jcs(result), jcs(recurringComparisonResult(definition, "2026-08-01", left, right)));
  const next = recurringComparisonResult(definition, "2026-08-02", syntheticRecurringSnapshot("2026-08-02","1800000"), syntheticRecurringSnapshot("2026-08-02","2200000"));
  assert.equal(next.state,"threshold_exceeded"); assert.ok("comparison" in next); assert.equal(next.comparison.rows[0].delta_right_minus_left,"400000");
  assert.equal(recurringComparisonResult(definition,"2026-08-01",left,null).state,"missing_input");
  const changed = structuredClone(right); changed.conditions.metric_definition = "d7_roas@synthetic-next-version"; delete changed.comparison_contexts; delete changed.provenance;
  assert.equal(recurringComparisonResult(definition,"2026-08-01",left,changed).state,"incomparable");
  const unknown = parseComparisonRegistration({ ...syntheticComparisonRegistration(), mode:"declared_only", left_snapshot: { source:left.source, conditions:left.conditions, rows:left.rows }, right_snapshot: { source:right.source, conditions:right.conditions, rows:right.rows } });
  assert.equal(recurringComparisonResult(unknown.definition,"2026-08-01",unknown.left,unknown.right).state,"unknown");
});
it("recurring_comparison_rejects_identifying_rows_wrong_cutoffs_unbounded_storage_and_invalid_retention", () => {
  const input = syntheticComparisonRegistration(), parsed = parseComparisonRegistration(input);
  const identifying = { source:parsed.left.source,conditions:parsed.left.conditions,rows:structuredClone(parsed.left.rows) }; identifying.rows[0].key = jcs({ installation_id:"synthetic-installation" });
  assert.throws(()=>boundedComparisonSnapshot(identifying),/forbidden/);
  assert.throws(()=>assertSnapshotPeriod(parsed.definition,"2026-08-02",parsed.left),/period_mismatch/);
  assert.throws(()=>parseComparisonRegistration({ ...input,retention_days:91 }),/settings_invalid/);
  assert.throws(()=>parseComparisonRegistration({ ...input,last_date:"2028-01-01" }),/period_limit/);
  assert.throws(()=>boundedComparisonSnapshot({ ...parsed.left,source:"x".repeat(4*1024*1024) }),/snapshot_limit/);
  assert.equal(parsed.definition.left_definition_digest.length,64);
  assert.notEqual(comparisonDigest(parsed.definition),comparisonDigest({ ...parsed.definition,threshold:{ value_unscaled:"1",scale:6 } }));
});
it("recurring_external_installs_cost_and_CPI_preserve_the_offline_comparator_bytes_and_operator_assurance", () => {
  for (const entry of syntheticExternalComparisonCases().filter(item => item.name.startsWith("native-acquisition-"))) {
    const pair = syntheticExternalComparisonPair(entry), right = aggregateCsvToSnapshot(Buffer.from(pair.csv), pair.mapping);
    const day = pair.saved.conditions.date_from;
    const registration = parseComparisonRegistration({ name: `Synthetic ${entry.name}`, first_date: day, last_date: day,
      watermark_lag_days: (Date.parse(pair.saved.conditions.source_cutoff) - Date.parse(day)) / 86400000,
      retention_days: 30, mode: "external_declared", threshold: { value_unscaled: "0", scale: right.rows[0].scale },
      left_snapshot: pair.saved, right_snapshot: right, supersedes_id: null });
    const result = recurringComparisonResult(registration.definition, day, registration.left, registration.right);
    assert.equal(result.state, "within_threshold", entry.name); assert.ok("comparison" in result);
    assert.equal(jcs(result.comparison), jcs(compareSnapshots(pair.saved, right, { allowExternalDeclaration: true })), entry.name);
    assert.equal(result.comparison.status, "external_declared_comparison");
    assert.equal(result.comparison.assurance.right.acquisition.upstream_completeness, "unknown");
    assert.deepEqual(result.comparison.assurance.right.execution, []);
  }
});
