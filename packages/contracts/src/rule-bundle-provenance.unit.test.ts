import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NON_FRAUD_RULE_BUNDLES,
  nonFraudBundleHash,
  validateNonFraudBundleDefinition,
  firstPartyWindowDefinition, firstPartyWindowHash, validateFirstPartyWindowDefinition,
} from "./rule-bundle-provenance.js";

describe("WO20 non-fraud rule-bundle provenance", () => {
  it("keeps the historical default and binds each closed opt-in window independently", () => {
    assert.equal(nonFraudBundleHash("attribution-default"), "2a6acdf35b3c649dc1e56d14cbc7436065118e4bb0ed1e7bd7b4604e834dce50");
    const hashes = [1,7,30].map(days => firstPartyWindowHash(firstPartyWindowDefinition(days as 1|7|30)));
    assert.equal(new Set(hashes).size, 3);
    for (const value of [0,2,31,"7",null]) assert.throws(() => validateFirstPartyWindowDefinition({ ...firstPartyWindowDefinition(7), lookback_days:value }));
    assert.throws(() => validateFirstPartyWindowDefinition({ ...firstPartyWindowDefinition(7), provider_window:true }));
  });
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
