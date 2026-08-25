import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AdServicesLookupLimiter, normalizeAdServicesResponse } from "./adservices-worker.js";

describe("AdServices server response normalization", () => {
  it("keeps the Apple response a server-derived attribution context", () => {
    assert.deepEqual(
      normalizeAdServicesResponse(Buffer.from(JSON.stringify({
        attribution: true,
        orgId: 10,
        campaignId: "20",
        adGroupId: 30,
        keywordId: 40,
        adId: 50,
        conversionType: "Download",
        claimType: "Click",
        countryOrRegion: "US",
        supplyPlacement: "SearchResults",
      }))),
      {
        status: "attributed",
        attribution: true,
        org_id: "10",
        campaign_id: "20",
        ad_group_id: "30",
        keyword_id: "40",
        ad_id: "50",
        conversion_type: "Download",
        claim_type: "Click",
        country_or_region: "US",
        supply_placement: "SearchResults",
      },
    );
    assert.deepEqual(
      normalizeAdServicesResponse(Buffer.from('{"attribution":false}')),
      { status: "not_attributed", attribution: false },
    );
  });

  it("rejects malformed, oversized, and out-of-vocabulary responses", () => {
    assert.throws(() => normalizeAdServicesResponse(Buffer.from("[]")), /response_invalid/);
    assert.throws(() => normalizeAdServicesResponse(Buffer.from('{"attribution":"true"}')), /attribution_invalid/);
    assert.throws(
      () => normalizeAdServicesResponse(Buffer.from('{"attribution":true,"claimType":"Modeled"}')),
      /claim_type_invalid/,
    );
    assert.throws(() => normalizeAdServicesResponse(Buffer.alloc(65 * 1024)), /response_too_large/);
  });

  it("bounds outbound fan-out per app without retaining network identifiers", () => {
    let now = 0;
    const limiter = new AdServicesLookupLimiter(1, 2, () => now);
    assert.equal(limiter.allow("tenant-a\u0000app-a"), true);
    assert.equal(limiter.allow("tenant-a\u0000app-a"), true);
    assert.equal(limiter.allow("tenant-a\u0000app-a"), false);
    now = 1_000;
    assert.equal(limiter.allow("tenant-a\u0000app-a"), true);
  });
});
