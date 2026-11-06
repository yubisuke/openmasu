import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { previewGoogleDestination } from "./google-destination-readiness.js";
import { renderGoogleDestination } from "./dashboard/google-destination.js";

describe("Google Data Manager destination configuration", () => {
  it("requires scoped direct-write review and rejects unsupported or unknown readiness without provider calls", () => {
    const body = { operating_account_id: "1234567890", conversion_action_id: "987654321", app_audience: "general", enabled: true,
      readiness: { source: "operator_review", action_type: "UPLOAD_CLICKS", action_status: "ENABLED",
        action_owner_account_id: "1234567890", conversion_action_id: "987654321", access_model: "direct", permission: "granted", purpose: "click_import" } };
    const preview = previewGoogleDestination(body);
    assert.equal(preview.ready, true);
    assert.equal(preview.live_access_verified, false);
    assert.deepEqual(previewGoogleDestination(body), preview);
    for (const changed of [
      { action_type: "GOOGLE_PLAY_IN_APP_PURCHASE" }, { action_type: "UNKNOWN" }, { permission: "denied" },
      { permission: "unknown" }, { action_status: "DISABLED" }, { source: "unknown" },
      { action_owner_account_id: "9999999999" }, { conversion_action_id: "111" },
      { access_model: "manager" }, { access_model: "partner" }, { purpose: "app_campaign_optimization" },
    ]) assert.equal(previewGoogleDestination({ ...body, readiness: { ...body.readiness, ...changed } }).ready, false);
    assert.equal(previewGoogleDestination({ ...body, readiness: {} }).ready, false);
    assert.equal(previewGoogleDestination({ ...body, app_audience: "child_directed" }).ready, false);
    for (const change of [{ operating_account_id: "123" }, { enabled: "true" }, { app_audience: "child" }, { secret: "forbidden" }]) {
      assert.throws(() => previewGoogleDestination({ ...body, ...change }), /invalid/);
    }
    const html = renderGoogleDestination("app-synthetic", "synthetic-csrf", [], preview);
    assert.match(html, /Activate reviewed revision/);
    assert.match(html, /Live access verified: false/);
    assert.doesNotMatch(html, /<script|javascript:|\sonclick=/i);
    const blocked = previewGoogleDestination({ ...body, readiness: {} });
    assert.doesNotMatch(renderGoogleDestination("app-synthetic", "synthetic-csrf", [], blocked), /Activate reviewed revision/);
  });
});
