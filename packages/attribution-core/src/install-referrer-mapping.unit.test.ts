import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapInstallReferrer, type InstallReferrerClientResponse } from "./install-referrer-mapping.js";

describe("Install Referrer client response mapping", () => {
  it("maps every documented response and the three OK referrer shapes", () => {
    const clickId = "AbCdEf0123456789_-abcd";
    assert.deepEqual(mapInstallReferrer({ response: "ok", referrer: `omv=1&cid=${clickId}` }), {
      referrer_status: "available", referrer_client_response: "ok", retry: "none",
      requires_window_evaluation: true, click_id: clickId,
    });
    assert.equal(mapInstallReferrer({ response: "ok", referrer: "foreign=value" }).terminal_reason, "unknown_click_id");
    assert.equal(mapInstallReferrer({ response: "ok" }).terminal_reason, "no_referrer");
    const expected: Record<Exclude<InstallReferrerClientResponse, "ok">, [string, string]> = {
      service_unavailable: ["unavailable", "bounded"],
      service_disconnected: ["unavailable", "bounded"],
      feature_not_supported: ["unsupported", "none"],
      developer_error: ["unavailable", "none"],
    };
    for (const [response, [status, retry]] of Object.entries(expected)) {
      const mapped = mapInstallReferrer({ response: response as InstallReferrerClientResponse });
      assert.equal(mapped.referrer_status, status);
      assert.equal(mapped.retry, retry);
    }
    assert.equal(mapInstallReferrer({ response: "developer_error" }).loud_integrator_error, true);
  });
});
