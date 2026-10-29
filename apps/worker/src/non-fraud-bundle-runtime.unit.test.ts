import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nonFraudBundleHash } from "@openmasu/contracts";
import { firstPartyWindowDefinition, firstPartyWindowHash } from "@openmasu/contracts/definitions";
import { assertNonFraudArtifactBinding, firstPartyWindowAtReceipt, type FirstPartyWindowRevision } from "./non-fraud-bundle-runtime.js";

describe("WO20 persisted non-fraud provenance", () => {
  it("selects immutable install-receipt revisions instead of the current activation", () => {
    const revision=(days:1|7|30,activatedAt:string):FirstPartyWindowRevision=>{
      const definition=firstPartyWindowDefinition(days),hash=firstPartyWindowHash(definition);
      return {ruleBundleRevisionId:`window-${days}`,ruleBundleId:definition.id,ruleBundleVersion:definition.version,
        ruleBundleHash:hash,definitionDigest:hash,definition,activatedAt};
    };
    const one=revision(1,"2026-08-01T00:00:00.000Z"),thirty=revision(30,"2026-08-10T00:00:00.000Z");
    assert.equal(firstPartyWindowAtReceipt([thirty,one],"2026-07-31T23:59:59.999Z"),undefined);
    assert.equal(firstPartyWindowAtReceipt([thirty,one],one.activatedAt),one);
    assert.equal(firstPartyWindowAtReceipt([one,thirty],"2026-08-09T23:59:59.999Z"),one);
    assert.equal(firstPartyWindowAtReceipt([one,thirty],thirty.activatedAt),thirty);
    const returned={...revision(1,"2026-08-20T00:00:00.000Z"),ruleBundleRevisionId:"window-one-returned"};
    assert.equal(firstPartyWindowAtReceipt([returned,thirty,one],"2026-08-09T23:59:59.999Z"),one);
    assert.equal(firstPartyWindowAtReceipt([returned,thirty,one],"2026-08-15T00:00:00.000Z"),thirty);
    assert.equal(firstPartyWindowAtReceipt([returned,thirty,one],returned.activatedAt),returned);
    assert.throws(()=>firstPartyWindowAtReceipt([one],"invalid"),/receipt_invalid/);
  });
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
