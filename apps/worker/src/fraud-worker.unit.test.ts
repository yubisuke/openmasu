import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DEFAULT_FRAUD_BUNDLE, fraudBundleHash } from "@openmasu/fraud-rules";
import { loadFraudBundle } from "./fraud-worker.js";

describe("M6 fraud worker policy", () => {
  it("F-A-12 loads the shipped composite and derives its non-zero JCS hash", async () => {
    const bundle = await loadFraudBundle();
    const hash = fraudBundleHash(bundle);
    assert.match(hash, /^[a-f0-9]{64}$/);
    assert.notEqual(hash, "0".repeat(64));
    assert.equal(bundle.id, "fraud-conservative");
    assert.deepEqual(bundle, DEFAULT_FRAUD_BUNDLE);
  });

  it("F-A-16 rejects a policy whose only evidence is device integrity", async () => {
    const bundle = await loadFraudBundle();
    const changed = structuredClone(bundle);
    changed.rules = [{ id: "integrity-only", inputs: ["integrity_verdict"], action: "flag" }];
    assert.throws(() => fraudBundleHash(changed), /integrity_only_rule_forbidden/);
  });
});
