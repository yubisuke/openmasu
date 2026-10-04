import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { measurementHealth, measurementNotices, parseMeasurementWindow, type MeasurementHealth } from "./measurement-health.js";
import { recentMeasurementNotices, type ReceiptCounts } from "./measurement-notices.js";
import { batchDiagnosticGroups, measurementClasses, MEASUREMENT_SDK_VERSIONS, MEASUREMENT_EVENTS, measurementGroupLimit } from "@openmasu/runtime";
import { readFileSync } from "node:fs";
import { buildDashboardView } from "./dashboard/view.js";
import { renderDashboard } from "./dashboard/render.js";
import { matchRoute } from "./routes.js";

function empty(): MeasurementHealth {
  return {
    observed_at: "2026-09-08T00:00:00.000Z", scope: "retained_history",
    sdk: { active_keys: "0", batches: "0", pending: "0", failed: "0", latest_received_at: null, oldest_pending_at: null },
    imports: { runs: "0", running: "0", failed: "0", latest_started_at: null, latest_completed_at: null },
    events: { logical_events: "0", latest_received_at: null }, rejections: [],
    metrics: { runs: "0", active_schedules: "0", pending_schedules: "0", latest_computed_at: null, latest_watermark: null, latest_cohort_date: null },
  };
}

describe("measurement health", () => {
  it("distinguishes missing configuration and observations from numeric zero", () => {
    const h = empty();
    assert.deepEqual(measurementNotices(h).map((n) => n.state), ["sdk_not_configured", "no_observations"]);
    h.sdk.active_keys = "1";
    assert.deepEqual(measurementNotices(h).map((n) => n.state), ["no_observations"]);
    assert.equal(parseMeasurementWindow(new URLSearchParams()), 24);
    for (const hours of [1,24,168]) assert.equal(parseMeasurementWindow(new URLSearchParams(`window_hours=${hours}`)), hours);
    for (const query of ["window_hours=0", "window_hours=25", "window_hours=24&window_hours=1", "installation_id=synthetic", "date_from=2026-09-08"])
      assert.throws(() => parseMeasurementWindow(new URLSearchParams(query)));
    const unknown = { producer: "synthetic-private-value", producer_version: "synthetic-private-value", event_name: "synthetic-private-value" };
    assert.deepEqual(measurementClasses(unknown), { producer: "other", producer_version: "other", event_name: "other" });
    const headers = [unknown, { producer_version: "0.3.0-rc.1", event_name: "install" }];
    assert.deepEqual(batchDiagnosticGroups("sdk-ios", Buffer.from(JSON.stringify({ records: headers })), 2), [
      { producer: "sdk-ios", event_name: "install", producer_version: "0.3.0-rc.1", event_count: 1 },
      { producer: "sdk-ios", event_name: "other", producer_version: "other", event_count: 1 },
    ]);
    assert.equal(batchDiagnosticGroups("sdk-ios", Buffer.from("not JSON"), 2)[0].event_count, 2);
    assert.deepEqual(MEASUREMENT_EVENTS.filter(value => value !== "other"), JSON.parse(readFileSync("registries/event-names-v0.4.json", "utf8")).event_names);
    const currentVersion = readFileSync("sdk/android/build.gradle.kts", "utf8").match(/^version = "([^"]+)"$/m)![1];
    assert.ok(MEASUREMENT_SDK_VERSIONS.some(version => version === currentVersion));
  });

  it("separates pending work, rejection evidence and uncomputed events without inferring an outage", () => {
    const h = empty();
    h.sdk.active_keys = "1";
    h.sdk.batches = h.sdk.pending = "1";
    h.events.logical_events = "2";
    h.rejections = [{ source: "event", reason: "payload_schema_invalid", count: "1" }];
    assert.deepEqual(measurementNotices(h).map((n) => n.state), ["processing_wait", "rejections_observed", "not_computed"]);
    assert.match(measurementNotices(h)[0].next, /does not prove/);
    const zero = (): ReceiptCounts => ({ accepted: "0", rejected: "0", duplicate: "0", late: "0", metadata_not_recorded: "0", latest_received_at: null });
    h.recent = { scope: "server_receipt_windows", window_hours: 24, unit: "delivery_attempts", received_from: h.observed_at,
      received_to: h.observed_at, previous_from: h.observed_at, pending_unit: "submitted_events", pending_groups: [],
      client_diagnostics: "on_device_only_not_received", groups: [
        { producer: "sdk-android", producer_version: "0.2.0", event_name: "install", current: zero(), previous: { ...zero(), accepted: "8" } },
        { producer: "sdk-android", producer_version: "0.3.0-rc.1", event_name: "install", current: { ...zero(), rejected: "2", late: "1" }, previous: zero() },
      ] };
    assert.deepEqual(recentMeasurementNotices(h.recent).map(notice => notice.state), ["group_no_recent_receipts", "group_rejections_increased", "low_observed_volume"]);
    assert.ok(recentMeasurementNotices(h.recent).every(notice => notice.state !== "rejections_observed"));
    const html = renderDashboard(buildDashboardView({ apps: [], csrfToken: "synthetic", measurementHealth: h }));
    assert.match(html, /Background history/);
    assert.match(html, /SDK queue diagnostics stay on the device/);
    assert.doesNotMatch(html, /<script|javascript:/i);
  });

  it("renders recorded results and pending schedules without claiming completeness or mixing units", () => {
    const h = empty();
    h.sdk.active_keys = h.sdk.batches = h.events.logical_events = h.metrics.runs = h.metrics.pending_schedules = "1";
    h.metrics.latest_computed_at = h.observed_at;
    const html = renderDashboard(buildDashboardView({ apps: [], csrfToken: "synthetic", measurementHealth: h }));
    assert.match(html, /data-measurement-state="results_observed"/);
    assert.match(html, /data-measurement-state="calculation_wait"/);
    assert.match(html, /not the report filter/);
    assert.match(html, /not funnel conversion rates/);
    assert.match(html, /Not observed/);
    assert.doesNotMatch(html, /<script|javascript:/i);
    assert.equal(matchRoute("GET", "/v1/admin/apps/app-a/measurement-health")?.mutates, false);
    assert.equal(matchRoute("POST", "/v1/admin/apps/app-a/measurement-health"), undefined);
    assert.equal(matchRoute("GET", "/dashboard/apps/app-a/measurement-health")?.mutates, false);
  });

  it("uses an app-bound read-only snapshot, bounded SQL and no protected columns", async () => {
    const h = empty();
    const bounds = { observed_at: h.observed_at, received_from: "2026-09-07T00:00:00.000Z", previous_from: "2026-09-06T00:00:00.000Z" };
    const rows = [[h.sdk], [h.imports], [h.events], h.rejections, [h.metrics], [], [], [bounds]];
    const statements: string[] = [];
    let released = false;
    const pool = { connect: async () => ({
      query: async (sql: string, args?: unknown[]) => {
        statements.push(sql);
        if (/FROM /.test(sql)) assert.deepEqual(args?.slice(0, 2), ["tenant-a", "app-a"]);
        if (sql.startsWith("WITH classified")) {
          assert.deepEqual(args?.slice(2,6), [24, [...MEASUREMENT_EVENTS], ["sdk-android", "sdk-ios", "other"], [...MEASUREMENT_SDK_VERSIONS]]);
          assert.match(sql, new RegExp(`LIMIT ${measurementGroupLimit}`));
          assert.match(sql, /transaction_timestamp/);
        }
        return { rows: /^(SELECT |WITH classified)/.test(sql) && !sql.includes("set_config") ? rows.shift() : [] };
      }, release: () => { released = true; },
    }) } as unknown as Pool;
    const result = await measurementHealth(pool, { tenantId: "tenant-a", appId: "app-a", keyId: "synthetic", role: "read_only" });
    assert.deepEqual(result, { ...h, recent: { scope: "server_receipt_windows", window_hours: 24, unit: "delivery_attempts",
      groups: [], pending_groups: [], received_from: bounds.received_from, received_to: bounds.observed_at,
      previous_from: bounds.previous_from, pending_unit: "submitted_events", client_diagnostics: "on_device_only_not_received" } });
    assert.match(statements[0], /REPEATABLE READ READ ONLY/);
    assert.ok(statements.some((s) => s.includes("statement_timeout")));
    assert.doesNotMatch(statements.join("\n"), /body_ref|secret_ref|artifact|installation_id|raw_payload_ref/);
    assert.equal(statements.at(-1), "COMMIT");
    assert.equal(released, true);
  });

  it("rolls back and releases the reader connection on query failure", async () => {
    const commands: string[] = [];
    let released = false;
    const pool = { connect: async () => ({ query: async (sql: string) => {
      commands.push(sql);
      if (sql.includes("FROM control.sdk_keys_current")) throw new Error("synthetic timeout");
      return { rows: [] };
    }, release: () => { released = true; } }) } as unknown as Pool;
    await assert.rejects(measurementHealth(pool, { tenantId: "tenant-a", appId: "app-a", keyId: "synthetic", role: "read_only" }), /synthetic timeout/);
    assert.equal(commands.at(-1), "ROLLBACK");
    assert.equal(released, true);
  });
});
