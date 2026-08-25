import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NON_FRAUD_RULE_BUNDLES,
  nonFraudBundleHash,
  validateNonFraudBundleDefinition,
} from "./rule-bundle-provenance.js";

describe("WO20 non-fraud rule-bundle provenance", () => {
  it("derives a non-placeholder JCS digest for every checked-in definition", () => {
    for (const [id, definition] of Object.entries(NON_FRAUD_RULE_BUNDLES)) {
      assert.equal(validateNonFraudBundleDefinition(structuredClone(definition)), definition);
      assert.match(nonFraudBundleHash(id as keyof typeof NON_FRAUD_RULE_BUNDLES), /^[a-f0-9]{64}$/);
      assert.notEqual(new Set(nonFraudBundleHash(id as keyof typeof NON_FRAUD_RULE_BUNDLES)).size, 1);
    }
  });

  it("rejects a forged rule while preserving the registered identity", () => {
    assert.throws(() => validateNonFraudBundleDefinition({
      ...NON_FRAUD_RULE_BUNDLES["attribution-default"], rules: ["accept-everything"],
    }), /non_fraud_rule_bundle_definition_unsupported/);
  });
});
