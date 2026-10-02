import assert from "node:assert/strict";
import { it } from "node:test";
import type { Pool } from "pg";
import { attributionReport, attributionReportLimits, parseAttributionQuery, type AttributionReport } from "./attribution-reporting.js";
import { renderAttributionReport } from "./dashboard/attribution-report.js";

const selection = { date_from: "2026-08-01", date_to: "2026-08-02", time_zone: "UTC", watermark_at_most: "2026-08-03T00:00:00.000001Z" };
it("requires an explicit bounded attribution selection and rejects unknown duplicate and identifying filters", () => {
  assert.deepEqual(parseAttributionQuery(new URLSearchParams(selection)), selection);
  for (const patch of [{ date_from: "2026-02-30" }, { date_to: "2026-08-01" }, { date_to: "2028-01-01" },
    { time_zone: "local" }, { watermark_at_most: "2026-02-30T00:00:00Z" }, { watermark_at_most: "2026-08-03T00:00:00.1234567Z" },
    { installation_id: "private" }, { limit: "1" }] as Record<string, string>[]) assert.throws(() => parseAttributionQuery(new URLSearchParams({ ...selection, ...patch })));
  const duplicate = new URLSearchParams(selection); duplicate.append("date_from", selection.date_from);
  assert.throws(() => parseAttributionQuery(duplicate), /required_or_duplicate/);
  assert.throws(() => parseAttributionQuery(new URLSearchParams()), /required_or_duplicate/);
});
it("renders the same count grain and selection without inferring causes or conflating absent decisions with organic", () => {
  const report: AttributionReport = { selection: { app_id: "synthetic-app", ...parseAttributionQuery(new URLSearchParams(selection)) },
    population: "retained_accepted_installations", privacy: "current", selection_rule: "eligible_as_of_latest_decision",
    maximum_installations: attributionReportLimits.installs, denominator: "3", data: [
      { recording_state: "not_recorded", status: null, method: null, reason_code: null, count: "1" },
      { recording_state: "recorded", status: "organic", method: "none", reason_code: "no_referrer", count: "2" }] };
  const html = renderAttributionReport("synthetic-app", report);
  assert.match(html, /data-attribution-denominator="3"/); assert.match(html, /data-attribution-count="1"/); assert.match(html, /data-attribution-count="2"/);
  for (const value of Object.values(selection)) assert.ok(html.includes(value));
  assert.match(html, /not_recorded, not organic/); assert.match(html, /do not prove fraud/);
  assert.doesNotMatch(html, /<script|javascript:|installation_id|record_id|evidence_refs/);
  assert.match(renderAttributionReport("synthetic-app"), /No counts are calculated/);
  assert.doesNotMatch(renderAttributionReport('<img src=x onerror="bad">'), /<img|onerror="/);
  assert.match(renderAttributionReport("synthetic-app", { ...report, selection: { ...report.selection, app_id: "<synthetic>" } }), /&lt;synthetic&gt;/);
});
it("refuses cohort overflow privacy backlog and query failure without publishing partial counts", async () => {
  for (const failure of ["overflow", "privacy", "timeout"]) {
    let released = false; const statements: string[] = [];
    const client = { query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("privacy_deletion_backlog")) return { rows: [{ pending_count: failure === "privacy" ? "1" : "0" }] };
      if (sql.startsWith("WITH cohort")) {
        if (failure === "timeout") throw Object.assign(Error("private-db-detail"), { code: "57014" });
        return { rows: [{ denominator: String(attributionReportLimits.installs + 1), data: [] }] };
      }
      return { rows: [] };
    }, release: () => { released = true; } };
    await assert.rejects(attributionReport({ connect: async () => client } as unknown as Pool,
      { tenantId: "synthetic-tenant", appId: "synthetic-app", keyId: "synthetic-key", role: "read_only" }, parseAttributionQuery(new URLSearchParams(selection))),
    new RegExp(failure === "overflow" ? "cohort_limit" : failure === "privacy" ? "privacy_pending" : "report_unavailable"));
    assert.equal(released, true); assert.equal(statements.at(-1), "ROLLBACK"); assert.ok(!statements.includes("COMMIT"));
  }
});
