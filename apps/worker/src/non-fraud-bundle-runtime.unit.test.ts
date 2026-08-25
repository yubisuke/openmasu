import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nonFraudBundleHash } from "@openmasu/contracts";
import { assertNonFraudArtifactBinding } from "./non-fraud-bundle-runtime.js";

describe("WO20 persisted non-fraud provenance", () => {
  const binding = {
    ruleBundleId: "attribution-default" as const,
    ruleBundleVersion: "0.3.0",
    ruleBundleHash: nonFraudBundleHash("attribution-default"),
    definitionDigest: nonFraudBundleHash("attribution-default"),
  };

  it("accepts the exact evaluated bundle triple and rejects a forged revision", () => {
    assert.doesNotThrow(() => assertNonFraudArtifactBinding({
      rule_bundle_id: binding.ruleBundleId,
      rule_bundle_version: binding.ruleBundleVersion,
      rule_bundle_hash: binding.ruleBundleHash,
    }, binding));
    assert.throws(() => assertNonFraudArtifactBinding({
      rule_bundle_id: binding.ruleBundleId,
      rule_bundle_version: binding.ruleBundleVersion,
      rule_bundle_hash: "f".repeat(64),
    }, binding), /non_fraud_rule_bundle_artifact_mismatch/);
  });
});
