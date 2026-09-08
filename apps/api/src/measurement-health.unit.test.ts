import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { measurementHealth, measurementNotices, type MeasurementHealth } from "./measurement-health.js";
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
  });

  it("separates pending work, rejection evidence and uncomputed events without inferring an outage", () => {
    const h = empty();
    h.sdk.active_keys = "1";
    h.sdk.batches = h.sdk.pending = "1";
    h.events.logical_events = "2";
    h.rejections = [{ source: "event", reason: "payload_schema_invalid", count: "1" }];
    assert.deepEqual(measurementNotices(h).map((n) => n.state), ["processing_wait", "rejections_observed", "not_computed"]);
    assert.match(measurementNotices(h)[0].next, /does not prove/);
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
  });

  it("uses an app-bound read-only snapshot, bounded SQL and no protected columns", async () => {
    const h = empty();
    const rows = [[h.sdk], [h.imports], [h.events], h.rejections, [h.metrics], [{ observed_at: h.observed_at }]];
    const statements: string[] = [];
    let released = false;
    const pool = { connect: async () => ({
      query: async (sql: string, args?: unknown[]) => {
        statements.push(sql);
        if (/FROM /.test(sql)) assert.deepEqual(args?.slice(0, 2), ["tenant-a", "app-a"]);
        return { rows: sql.startsWith("SELECT ") && !sql.includes("set_config") ? rows.shift() : [] };
      }, release: () => { released = true; },
    }) } as unknown as Pool;
    assert.deepEqual(await measurementHealth(pool, { tenantId: "tenant-a", appId: "app-a", keyId: "synthetic", role: "read_only" }), h);
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
