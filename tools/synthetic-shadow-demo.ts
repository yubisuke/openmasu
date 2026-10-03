import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jcs } from "@openmasu/attribution-core/canonical";
import { evaluate } from "@openmasu/attribution-core";
import { aggregateCsvToSnapshot } from "./report-to-snapshot.js";
import { compareSnapshots } from "./compare-cohorts.js";
import { renderComparison } from "./cohort-comparison-html.js";

type JsonObject = Record<string, any>;

type RuntimeBoundary = {
  status: "not_run";
  db_table: string;
  api_route: string | null;
  note?: string;
};

export type ShadowComparison = {
  fixture: string;
  domain: "reconciliation" | "attribution";
  source: "synthetic_fixture_evaluator";
  golden_check: "passed";
  reason_code: string;
  explanation: JsonObject;
  runtime_boundary: RuntimeBoundary;
};

export type SyntheticShadowDemo = {
  format: "openmasu-synthetic-shadow-demo-v1";
  contract_version: "0.4.0";
  mode: "offline_evaluator";
  environment: {
    real_data: false;
    external_provider: false;
    physical_device: false;
    production_deployment: false;
  };
  comparisons: ShadowComparison[];
  stored_runtime_claim: "not_run";
};

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fixturePath(root: string, fixture: string, file: string): string {
  return resolve(root, "fixtures", "v0.4", fixture, file);
}

function assertGolden(actual: unknown, expected: unknown, fixture: string): void {
  assert.equal(jcs(actual), jcs(expected), `${fixture} evaluator output differs from its reviewed golden`);
}

function exactlyOneByReason(artifacts: JsonObject[], field: string, reason: string, fixture: string): JsonObject {
  const selected = artifacts.filter((artifact) => artifact[field] === reason);
  assert.equal(selected.length, 1, `${fixture} must contain exactly one ${reason} artifact`);
  return selected[0];
}

export function summarizeReconciliation(
  actual: JsonObject[],
  expected: JsonObject[],
  fixture: string,
  reason: string,
): ShadowComparison {
  assertGolden(actual, expected, fixture);
  const artifact = exactlyOneByReason(actual, "difference_reason_code", reason, fixture);
  return {
    fixture,
    domain: "reconciliation",
    source: "synthetic_fixture_evaluator",
    golden_check: "passed",
    reason_code: reason,
    explanation: {
      input_snapshot_id: artifact.input_snapshot_id,
      external_snapshot_id: artifact.external_snapshot_id,
      candidates: artifact.candidates,
      exclusions: artifact.exclusions,
      windows: artifact.windows,
      joins: artifact.joins,
      freshness: artifact.freshness,
    },
    runtime_boundary: {
      status: "not_run",
      db_table: "ledger.reconciliation_results",
      api_route: "/v1/audit/differences",
    },
  };
}

export function summarizeAttribution(
  actual: JsonObject[],
  expected: JsonObject[],
  fixture: string,
  reason: string,
): ShadowComparison {
  assertGolden(actual, expected, fixture);
  const artifact = exactlyOneByReason(actual, "reason_code", reason, fixture);
  return {
    fixture,
    domain: "attribution",
    source: "synthetic_fixture_evaluator",
    golden_check: "passed",
    reason_code: reason,
    explanation: {
      attribution_id: artifact.attribution_id,
      status: artifact.status,
      method: artifact.method,
      model: artifact.model,
      subject_ref: artifact.subject_ref,
    },
    runtime_boundary: {
      status: "not_run",
      db_table: "ledger.attribution_results",
      api_route: null,
      note: "No public attribution report route; this row is offline evaluator evidence.",
    },
  };
}

function evaluateFixture(root: string, fixture: string): JsonObject {
  return evaluate(readJson(fixturePath(root, fixture, "input.json"))) as JsonObject;
}

export function buildSyntheticShadowDemo(root = process.cwd()): SyntheticShadowDemo {
  const windowFixture = "21-reconciliation-window-mismatch";
  const modeledFixture = "38-provider-modeled-reconciliation";
  const crowdFixture = "34-stage-c-apple-meta-attribution";
  const windowOutput = evaluateFixture(root, windowFixture);
  const modeledOutput = evaluateFixture(root, modeledFixture);
  const crowdOutput = evaluateFixture(root, crowdFixture);

  const result: SyntheticShadowDemo = {
    format: "openmasu-synthetic-shadow-demo-v1",
    contract_version: "0.4.0",
    mode: "offline_evaluator",
    environment: {
      real_data: false,
      external_provider: false,
      physical_device: false,
      production_deployment: false,
    },
    comparisons: [
      summarizeReconciliation(
        windowOutput.reconciliation,
        readJson(fixturePath(root, windowFixture, "expected_reconciliation.json")),
        windowFixture,
        "window_mismatch",
      ),
      summarizeReconciliation(
        modeledOutput.reconciliation,
        readJson(fixturePath(root, modeledFixture, "expected_reconciliation.json")),
        modeledFixture,
        "provider_modeled_conversion",
      ),
      summarizeAttribution(
        crowdOutput.attributions,
        readJson(fixturePath(root, crowdFixture, "expected_attributions.json")),
        crowdFixture,
        "crowd_anonymity_suppressed",
      ),
    ],
    stored_runtime_claim: "not_run",
  };
  assertSyntheticShadowDemo(result);
  return result;
}

export function assertSyntheticShadowDemo(value: SyntheticShadowDemo): void {
  assert.equal(value.comparisons.length, 3);
  assert.deepEqual(value.comparisons.map((entry) => entry.reason_code), [
    "window_mismatch",
    "provider_modeled_conversion",
    "crowd_anonymity_suppressed",
  ]);
  assert.ok(value.comparisons.every((entry) => entry.golden_check === "passed"));
  assert.ok(value.comparisons.every((entry) => entry.runtime_boundary.status === "not_run"));
  assert.deepEqual(value.environment, {
    real_data: false,
    external_provider: false,
    physical_device: false,
    production_deployment: false,
  });
  assert.equal(value.stored_runtime_claim, "not_run");
}

/** Reuse the reference evaluator and CSV/HTML tools; never claim stored runtime evidence. */
export function buildSyntheticCohortWalkthrough(root = process.cwd()) {
  const fixture = "33-stage-b-cohort-metrics";
  const original = readJson(fixturePath(root, fixture, "input.json"));
  const output = evaluate(original) as JsonObject;
  assertGolden(output.metric_runs, readJson(fixturePath(root, fixture, "expected_metric_runs.json")), fixture);
  const corrected = structuredClone(original);
  const cost = corrected.cost_records.find((row: JsonObject) => row.cost_record_id === "cost-33");
  assert.ok(cost, "synthetic current cost must exist");
  cost.amount_unscaled = "200000000";
  const shorter = structuredClone(original);
  shorter.metric_definitions.find((definition: JsonObject) => definition.metric_name === "d7_roas").definition.window.day = 3;
  const select = (input: JsonObject) => {
    const runs = (evaluate(input) as JsonObject).metric_runs.filter((run: JsonObject) => run.metric_name === "d7_roas");
    assert.equal(runs.length, 1); assert.equal(runs[0].value_type, "ratio");
    return runs[0] as JsonObject;
  };
  const baseline = select(original);
  const dimensions = Object.keys(baseline.grouping.dimensions).sort();
  const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const sample = (name: string, input: JsonObject) => {
    const run = select(input);
    const definition = input.metric_definitions.find((value: JsonObject) => value.metric_name === run.metric_name);
    const mapping = {
      version: 1, source: `synthetic-evaluator-${name}`,
      conditions: { date_from: run.grouping.dimensions.cohort_date, date_to: "2026-08-02", time_zone: run.aggregation_time_zone,
        maturity: `synthetic_declared_elapsed_day_${definition.definition.window.day}`, aggregation: "cumulative",
        attribution_scope: run.grouping.dimensions.attribution_status,
        metric_definition: `${run.metric_name}@${run.metric_definition_version}`, source_cutoff: run.input_received_at_watermark },
      grouping: Object.fromEntries(dimensions.map(key => [key, { column: key }])),
      value: { column: "value_unscaled", input: "integer", scale: run.ratio_scale, currency: { constant: "none" } },
    };
    const csv = `${[...dimensions, "value_unscaled"].map(quoted).join(",")}\n${[...dimensions.map(key => run.grouping.dimensions[key]), run.value_unscaled].map(quoted).join(",")}\n`;
    // Use the exact canonical file shape so the CLI and generated HTML share key order.
    const snapshot: ReturnType<typeof aggregateCsvToSnapshot> = JSON.parse(jcs(aggregateCsvToSnapshot(Buffer.from(csv, "utf8"), mapping)));
    return { csv, mapping, snapshot };
  };
  const samples = { baseline: sample("baseline", original), equal: sample("equal", original),
    different: sample("cost-correction", corrected), incomparable: sample("shorter-window", shorter) };
  const comparisons = {
    equal: compareSnapshots(samples.baseline.snapshot, samples.equal.snapshot, { declaredOnly: true }),
    different: compareSnapshots(samples.baseline.snapshot, samples.different.snapshot, { declaredOnly: true }),
    incomparable: compareSnapshots(samples.baseline.snapshot, samples.incomparable.snapshot, { declaredOnly: true }),
    unknown: compareSnapshots(samples.baseline.snapshot, samples.equal.snapshot),
  };
  assert.equal(comparisons.equal.rows[0].status, "equal");
  assert.equal(comparisons.different.rows[0].delta_right_minus_left, "-750000");
  assert.equal(comparisons.incomparable.status, "incomparable");
  assert.equal(comparisons.unknown.status, "incomparable");
  return { fixture, source: "synthetic_fixture_evaluator", baseline_golden_check: "passed",
    runtime_boundary: "not_run", comparison_basis: "operator_declared", samples, comparisons } as const;
}

export function writeSyntheticCohortWalkthrough(directory: string, root = process.cwd()) {
  // An explicit fresh directory only: never overwrite a user's saved report.
  const walkthrough = buildSyntheticCohortWalkthrough(root);
  const destination = resolve(directory);
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(destination, { recursive: false });
  const files: string[] = [];
  const save = (name: string, value: string) => { writeFileSync(resolve(destination, name), value, { flag: "wx" }); files.push(name); };
  for (const [name, sample] of Object.entries(walkthrough.samples)) {
    save(`${name}.csv`, sample.csv); save(`${name}-mapping.json`, `${jcs(sample.mapping)}\n`);
    save(`${name}.json`, `${jcs(sample.snapshot)}\n`);
  }
  for (const [name, comparison] of Object.entries(walkthrough.comparisons)) {
    save(`${name}-comparison.json`, `${jcs(comparison)}\n`); save(`${name}.html`, renderComparison(comparison));
  }
  return { fixture: walkthrough.fixture, baseline_golden_check: walkthrough.baseline_golden_check,
    runtime_boundary: walkthrough.runtime_boundary, comparison_basis: walkthrough.comparison_basis, files,
    scenarios: Object.fromEntries(Object.entries(walkthrough.comparisons).map(([name, comparison]) => [name, {
      status: comparison.status, row_status: comparison.rows[0]?.status ?? null, mismatches: comparison.mismatches,
    }])) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length && !args[0].startsWith("--comparison-dir="))) throw Error("invalid_arguments");
    const directory = args[0]?.slice("--comparison-dir=".length);
    if (args.length && !directory) throw Error("invalid_directory");
    const demo = buildSyntheticShadowDemo();
    console.log(JSON.stringify(directory ? { ...demo, cohort_walkthrough: writeSyntheticCohortWalkthrough(directory) } : demo, null, 2));
  } catch {
    console.error("Synthetic demo failed: use a fresh comparison directory and valid arguments; no inputs or paths were printed.");
    process.exitCode = 1;
  }
}
