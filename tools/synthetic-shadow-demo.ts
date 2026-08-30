import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, jcs } from "@openmasu/attribution-core";

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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(buildSyntheticShadowDemo(), null, 2));
}
