import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { encodeFraudAudit, parseFraudAuditQuery, type FraudAuditRow } from "./fraud-reporting.js";

const row: FraudAuditRow = {
  metric_date: "2026-08-21",
  campaign_id: "synthetic-campaign",
  network: "synthetic-network",
  site_id: "synthetic-site",
  remote_click_refs: ["remote-synthetic-a"],
  clicks: "1200",
  installs: "12",
  suspected: "1",
  confirmed: "0",
  excluded: "0",
  quarantined: "0",
};

describe("M6 fraud audit report", () => {
  it("F-A-20 parses a closed query and rejects unknown filters", () => {
    assert.deepEqual(parseFraudAuditQuery(new URLSearchParams({
      app_id: "app-local", from: "2026-08-01", to: "2026-09-01", format: "csv",
    })), { appId: "app-local", from: "2026-08-01", to: "2026-09-01", format: "csv" });
    assert.throws(() => parseFraudAuditQuery(new URLSearchParams({
      app_id: "app-local", from: "2026-08-01", to: "2026-09-01", click_id: "forbidden",
    })), /unknown_filter/);
    assert.equal(parseFraudAuditQuery(new URLSearchParams({
      app_id: "App.Mixed:1", from: "2026-08-01", to: "2026-09-01",
    })).appId, "App.Mixed:1");
    assert.throws(() => parseFraudAuditQuery(new URLSearchParams({
      app_id: "app-local", from: "2026-02-30", to: "2026-03-02",
    })), /date_range_invalid/);
  });

  it("F-A-20 keeps JSON and CSV row-equivalent without identifying fields", () => {
    const json = encodeFraudAudit([row], "json").body;
    const csv = encodeFraudAudit([row], "csv").body;
    for (const forbidden of ["installation_id", "click_id", "record_id", "payload_ref", "user-agent", "ip_address"]) {
      assert.equal(json.toLowerCase().includes(forbidden), false);
      assert.equal(csv.toLowerCase().includes(forbidden), false);
    }
    assert.match(json, /remote-synthetic-a/);
    assert.match(csv, /remote-synthetic-a/);
    assert.equal(csv.trimEnd().split("\r\n").length, 2);
  });
});
