import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertFraudBundle,
  clickInjectionPolicyDigest,
  evaluateInstallRules,
  evaluateSourceDay,
  fraudBundleHash,
  publicBundleProvenance,
  type ClickInjectionPolicy,
  type FraudBundle,
} from "./index.js";

const policy = (seconds = 2): ClickInjectionPolicy => {
  const value = { threshold_seconds: seconds, authority: "server" as const, policy_version: "synthetic-v1" };
  return { ...value, policy_digest: clickInjectionPolicyDigest(value) };
};

describe("M6 deterministic fraud rules", () => {
  it("F-A-01 uses the configured CTIT threshold", () => {
    const base = { redirectorClickAt: "2026-08-21T00:00:00.000Z", policy: policy(2) };
    assert.equal(evaluateInstallRules({ ...base, installBeginAtServer: "2026-08-21T00:00:03.000Z" }).length, 0);
    assert.equal(evaluateInstallRules({ ...base, installBeginAtServer: "2026-08-21T00:00:01.000Z" })[0].reasonCode, "click_injection_suspected");
  });

  it("F-A-02 rejects a mismatched policy digest", () => {
    assert.throws(() => evaluateInstallRules({ policy: { ...policy(), policy_digest: "0".repeat(64) } }), /click_injection_policy\.policy_digest/);
  });

  it("F-A-03 and F-A-04 use Play server ordering independently of redirector time", () => {
    const input = {
      installBeginAtServer: "2026-08-21T01:00:00.000Z",
      referrerClickAtServer: "2026-08-21T01:00:01.000Z",
      referrerClickAtServerStatus: "available" as const,
      policy: policy(),
    };
    const before = evaluateInstallRules({ ...input, redirectorClickAt: "2026-08-20T23:00:00.000Z" })[0];
    const after = evaluateInstallRules({ ...input, redirectorClickAt: "2026-08-21T02:00:00.000Z" })[0];
    assert.deepEqual(before, after);
    assert.equal(before.decision, "confirmed");
    assert.equal(evaluateInstallRules({ ...input, referrerClickAtServer: input.installBeginAtServer }).some((hit) => hit.ruleId === "referrer-server-order-v1"), false);
    assert.equal(evaluateInstallRules({ ...input, referrerClickAtServerStatus: "missing", referrerClickAtServer: undefined }).length, 0);
  });

  it("F-A-05 treats negative CTIT as a non-fraud diagnostic", () => {
    assert.deepEqual(evaluateInstallRules({
      redirectorClickAt: "2026-08-21T01:00:01.000Z",
      installBeginAtServer: "2026-08-21T01:00:00.000Z",
      policy: policy(),
    }), [{
      ruleId: "ctit-clock-anomaly-v1",
      decision: "clear",
      action: "allow",
      reasonCode: "ctit_clock_anomaly",
      evidenceType: "ctit_clock_diagnostic",
    }]);
  });

  it("F-A-06 requires all four source-day flooding terms", () => {
    const full = { clicks: 1_000, installs: 1, medianCvr: 0.01, ctitP50Ms: 86_400_000, ctitP95Ms: 172_800_000 };
    assert.equal(evaluateSourceDay(full)?.reasonCode, "click_flooding_suspected");
    for (const mutation of [
      { clicks: 999 }, { installs: 3 }, { ctitP50Ms: 86_399_999 }, { ctitP95Ms: 259_200_001 },
    ]) assert.equal(evaluateSourceDay({ ...full, ...mutation }), undefined);
  });

  it("F-A-12 and F-A-13 bind the composite while exposing only the private digest", () => {
    const bundle: FraudBundle = {
      id: "fraud-conservative", version: "1.0.0",
      layers: { base: { threshold: 2 }, private: { digest: "7".repeat(64) } },
      rules: [{ id: "combined", inputs: ["integrity_verdict", "ctit"], action: "flag" }],
    };
    const publicValue = publicBundleProvenance(bundle);
    assert.notEqual(publicValue.hash, "0".repeat(64));
    assert.equal(publicValue.private_layer_digest, "7".repeat(64));
    assert.notEqual(fraudBundleHash(bundle), fraudBundleHash({ ...bundle, layers: { ...bundle.layers, base: { threshold: 3 } } }));
  });

  it("F-A-13 rejects private layer contents instead of a digest-only reference", () => {
    assert.throws(() => fraudBundleHash({
      id: "fraud-private", version: "1", layers: { base: {}, private: { threshold: 7 } },
      rules: [{ id: "combined-rule", inputs: ["integrity_verdict", "ctit"], action: "flag" }],
    }), /private_layer_must_be_digest_only/);
  });

  it("F-A-16 rejects integrity-only rules at load time", () => {
    assert.throws(() => assertFraudBundle({
      id: "invalid", version: "1", layers: { base: {} },
      rules: [{ id: "integrity-only", inputs: ["integrity_verdict"], action: "flag" }],
    }), /integrity_only_rule_forbidden/);
  });
});
