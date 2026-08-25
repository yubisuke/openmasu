import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeGoogleDataManagerDestination } from "./google-data-manager-admin.js";

describe("Google Data Manager destination configuration", () => {
  it("accepts only explicit non-secret numeric destination identifiers", () => {
    assert.deepEqual(normalizeGoogleDataManagerDestination({
      operating_account_id: "1234567890",
      conversion_action_id: "987654321",
      app_audience: "general",
      enabled: true,
    }), {
      operatingAccountId: "1234567890",
      conversionActionId: "987654321",
      appAudience: "general",
      enabled: true,
    });
    assert.throws(() => normalizeGoogleDataManagerDestination({
      operating_account_id: "accounts/123",
      conversion_action_id: "987",
      app_audience: "general",
      enabled: true,
    }), /operating_account_id_invalid/);
    assert.throws(() => normalizeGoogleDataManagerDestination({
      operating_account_id: "123",
      conversion_action_id: "987",
      app_audience: "general",
      enabled: "true",
    }), /enabled_invalid/);
    assert.throws(() => normalizeGoogleDataManagerDestination({
      operating_account_id: "123",
      conversion_action_id: "987",
      app_audience: "child",
      enabled: true,
    }), /app_audience_invalid/);
  });
});
