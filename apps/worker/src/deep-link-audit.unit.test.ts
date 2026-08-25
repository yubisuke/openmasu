import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDeepLinkAuditEvidence } from "./deep-link-audit.js";

describe("WO20 forgeable deep-link evidence", () => {
  it("labels direct opens as unverified device claims without inventing a redirect click", () => {
    const result = buildDeepLinkAuditEvidence({
      openSource: "android_app_link", resolutionStatus: "active",
    });
    assert.deepEqual(result.evidence, {
      evidence_class: "device_reported_unverified",
      open_source: "android_app_link",
      resolution_status: "active",
      observed_redirect_click: false,
      install_click_reused: false,
      installation_attribution_mutated: false,
    });
    assert.equal(result.reasonCode, "device_claim_observed");
    assert.match(result.digest, /^[a-f0-9]{64}$/);
  });

  it("records deferred click reuse as audit evidence without changing install attribution", () => {
    const result = buildDeepLinkAuditEvidence({
      openSource: "android_deferred_referrer", resolutionStatus: "active",
      claimedClickId: "Click_synthetic", installAttributionClickId: "Click_synthetic",
    });
    assert.equal(result.reasonCode, "deep_link_install_click_reused");
    assert.equal(result.evidence.observed_redirect_click, true);
    assert.equal(result.evidence.installation_attribution_mutated, false);
    assert.doesNotMatch(JSON.stringify(result), /Click_synthetic/);
  });
});
