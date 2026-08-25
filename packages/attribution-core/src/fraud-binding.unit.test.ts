import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { canonicalize } from "json-canonicalize";
import {
  DEFAULT_FRAUD_BUNDLE,
  fraudBundleHash,
  sha256Jcs,
  type FraudAction,
  type FraudBundle,
} from "@openmasu/fraud-rules";
import { evaluate } from "./evaluator.js";

type Any = Record<string, any>;

function fixture(name: string): Any {
  return JSON.parse(readFileSync(resolve("fixtures", "v0.4", name, "input.json"), "utf8"));
}

function withBundle(input: Any, definition: FraudBundle, fraudEnabled = true): Any {
  const copy = structuredClone(input);
  delete copy.server_context.click_injection_policy;
  copy.server_context = {
    ...copy.server_context,
    fraud_enabled: fraudEnabled,
    fraud_rule_bundle: {
      rule_bundle_revision_id: `revision:${definition.version}`,
      rule_bundle_id: definition.id,
      rule_bundle_version: definition.version,
      rule_bundle_hash: fraudBundleHash(definition),
      definition_digest: sha256Jcs(definition),
      definition,
    },
  };
  return copy;
}

function withActions(action: FraudAction): FraudBundle {
  return {
    ...DEFAULT_FRAUD_BUNDLE,
    version: `1.0.${["allow", "flag", "exclude", "quarantine"].indexOf(action) + 1}`,
    rules: DEFAULT_FRAUD_BUNDLE.rules.map((rule) => ({ ...rule, action })),
  };
}

describe("WO-14R fraud rule-bundle binding", () => {
  it("F-A-12 replays one recorded revision byte-identically and changes hash and decision after a threshold revision", () => {
    const input = withBundle(fixture("41-click-injection-suspected"), DEFAULT_FRAUD_BUNDLE);
    const first = evaluate(input);
    assert.equal(canonicalize(first), canonicalize(evaluate(input)));
    assert.equal(first.fraud_decisions[0]?.rule_bundle_hash, fraudBundleHash(DEFAULT_FRAUD_BUNDLE));

    const changed: FraudBundle = {
      ...DEFAULT_FRAUD_BUNDLE,
      version: "1.0.1",
      layers: { ...DEFAULT_FRAUD_BUNDLE.layers, base: {
        ...DEFAULT_FRAUD_BUNDLE.layers.base,
        ctit_lower_bound_seconds: 1,
      } },
    };
    const second = evaluate(withBundle(fixture("41-click-injection-suspected"), changed));
    assert.notEqual(fraudBundleHash(DEFAULT_FRAUD_BUNDLE), fraudBundleHash(changed));
    assert.notEqual(canonicalize(first.fraud_decisions), canonicalize(second.fraud_decisions));
    assert.equal(second.fraud_decisions.length, 0);
  });

  it("P0-3 binds transport, install, and source fraud to one non-zero composite hash", () => {
    const expected = fraudBundleHash(DEFAULT_FRAUD_BUNDLE);
    const decisions = [
      "19-bot-prefetch",
      "25-replay-suspected",
      "41-click-injection-suspected",
      "48-source-scoped-fraud",
      "51-referrer-server-order",
    ].flatMap((name) => evaluate(withBundle(fixture(name), DEFAULT_FRAUD_BUNDLE)).fraud_decisions);
    assert.ok(decisions.length >= 5);
    assert.notEqual(expected, "0".repeat(64));
    assert.deepEqual([...new Set(decisions.map((decision) => decision.rule_bundle_hash))], [expected]);
    assert.deepEqual([...new Set(decisions.map((decision) => decision.rule_bundle_id))], [DEFAULT_FRAUD_BUNDLE.id]);
  });

  it("F-A-09 keeps every metric run byte-identical when all rules flag versus fraud disabled", () => {
    const input = fixture("50-gross-net-metrics");
    const flagged = evaluate(withBundle(input, withActions("flag")));
    const disabled = evaluate(withBundle(input, DEFAULT_FRAUD_BUNDLE, false));
    assert.equal(canonicalize(flagged.metric_runs), canonicalize(disabled.metric_runs));
  });

  it("F-A-11 keeps ingestion evidence byte-identical for every fraud action", () => {
    const input = fixture("50-gross-net-metrics");
    const disabled = evaluate(withBundle(input, DEFAULT_FRAUD_BUNDLE, false));
    for (const action of ["allow", "flag", "exclude", "quarantine"] as const) {
      const output = evaluate(withBundle(input, withActions(action)));
      for (const key of ["raw_records", "deliveries", "logical_events", "rejections"] as const) {
        assert.equal(canonicalize(output[key]), canonicalize(disabled[key]), `${action}:${key}`);
      }
    }
  });
});
