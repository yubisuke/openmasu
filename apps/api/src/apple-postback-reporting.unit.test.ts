import assert from "node:assert/strict";
import { it } from "node:test";
import type { Pool } from "pg";
import { projectApplePostbackObservation } from "@openmasu/runtime";
import { applePostbackReport, appleReportLimits, parseAppleReportQuery, type ApplePostbackReport } from "./apple-postback-reporting.js";
import { renderApplePostbackReport } from "./dashboard/apple-postback-report.js";

const selection = { date_from: "2026-08-22", date_to: "2026-08-23", watermark_at_most: "2026-08-22T23:59:59.999999Z" };
it("requires an explicit bounded UTC receipt selection without identifying or duplicate filters", () => {
  assert.deepEqual(parseAppleReportQuery(new URLSearchParams(selection)), selection);
  for (const patch of [{ date_from: "2026-02-30" }, { date_to: "2026-08-22" }, { date_to: "2028-01-01" },
    { time_zone: "UTC" }, { watermark_at_most: "2026-02-30T00:00:00Z" }, { installation_id: "synthetic" }, { limit: "1" }] as Record<string, string>[]) {
    assert.throws(() => parseAppleReportQuery(new URLSearchParams({ ...selection, ...patch })));
  }
  const duplicate = new URLSearchParams(selection); duplicate.append("date_from", selection.date_from);
  assert.throws(() => parseAppleReportQuery(duplicate), /required_or_duplicate/);
  assert.throws(() => parseAppleReportQuery(new URLSearchParams()), /required_or_duplicate/);
});
it("projects synthetic Apple window and absence cases without retaining identifiers or authenticating unsigned values", () => {
  const base = { event_name: "skan_postback", version: "4.0", postback_sequence_index: 0, source_identifier: "12",
    signature_verified: true, did_win: true, redownload: false, conversion_value: 0,
    extensions: { unsigned_observation_fields: ["conversion-value"], arbitrary: "not-for-report" } };
  assert.deepEqual(projectApplePostbackObservation(base), { version: 1, protocol: "skan_4", sequence: "0", winner: "winner",
    conversion_type: "download", source_state: "digits_2", conversion_value_state: "fine", conversion_value_coverage: "unsigned", verification_reason: "verified" });
  for (const [index, coarse] of ["low", "medium", "high"].entries()) {
    const row = projectApplePostbackObservation({ ...base, postback_sequence_index: index ? 2 : 1, conversion_value: undefined,
      coarse_conversion_value: coarse, source_identifier: "123", redownload: true,
      extensions: { unsigned_observation_fields: ["coarse-conversion-value"] } });
    assert.equal(row.sequence, index ? "2" : "1"); assert.equal(row.conversion_value_state, `coarse_${coarse}`);
    assert.equal(row.conversion_value_coverage, "unsigned"); assert.equal(row.source_state, "digits_3"); assert.equal(row.conversion_type, "redownload");
  }
  assert.deepEqual(projectApplePostbackObservation({ event_name: "skan_postback", version: "3.0", signature_verified: false,
    did_win: false, extensions: { apple_verification_reason: "unknown_key" } }),
  { version: 1, protocol: "skan_3", sequence: "not_provided", winner: "nonwinner", conversion_type: "not_provided",
    source_state: "not_applicable", conversion_value_state: "absent", conversion_value_coverage: "not_applicable", verification_reason: "unknown_key" });
  for (const reason of ["signature_invalid", "development_postback_rejected", "malformed", "untrusted-reason"]) {
    const row = projectApplePostbackObservation({ event_name: "adattributionkit_postback", conversion_type: "re-engagement",
      postback_sequence_index: 2, did_win: true, signature_verified: false, extensions: { apple_verification_reason: reason } });
    assert.equal(row.protocol, "adattributionkit"); assert.equal(row.source_state, "absent"); assert.equal(row.conversion_type, "re-engagement");
    assert.equal(row.verification_reason, reason === "untrusted-reason" ? "not_recorded" : reason);
  }
  assert.equal(projectApplePostbackObservation({ ...base, extensions: {} }).conversion_value_coverage, "not_recorded");
  assert.equal(projectApplePostbackObservation({ ...base, source_identifier: "1234" }).source_state, "digits_4");
});
it("renders separate postback populations and closed metadata without an install total or fabricated suppression diagnosis", () => {
  const report: ApplePostbackReport = { selection: { app_id: "synthetic-app", time_zone: "UTC", ...selection }, privacy: "current",
    conversion_schema: "not_recorded", coverage: "retained_receiver_ledger_only", maximum_source_rows: appleReportLimits.source_rows,
    observations: [{ receipt_date: "2026-08-22", platform: "skadnetwork", verification: "verified", count: "3",
      ...projectApplePostbackObservation({ event_name: "skan_postback", version: "4.0", did_win: false, signature_verified: true, postback_sequence_index: 0 }) }],
    receipts: [{ receipt_date: "2026-08-22", platform: "skadnetwork", state: "processed", count: "5" }], deliveries: [], quota_rejections: [] };
  const html = renderApplePostbackReport("synthetic-app", report);
  assert.match(html, /<td>3<\/td>/); assert.match(html, /<td>5<\/td>/);
  assert.match(html, /not unique installs/); assert.match(html, /not_recorded — no verified postback-to-schema binding/);
  assert.match(html, /may reflect privacy suppression/); assert.match(html, /Verified signatures authenticate only their signed fields/);
  for (const value of Object.values(selection)) assert.ok(html.includes(value));
  assert.doesNotMatch(html, /<script|javascript:|installation_id|record_id|source_identifier/);
  assert.match(renderApplePostbackReport("synthetic-app"), /No counts are calculated/);
  assert.doesNotMatch(renderApplePostbackReport('<img src=x onerror="bad">'), /<img|onerror="/);
  assert.match(renderApplePostbackReport("synthetic-app", undefined, "<synthetic>"), /&lt;synthetic&gt;/);
});
it("refuses each source overflow, pending privacy and query failure without partial counts or private diagnostics", async () => {
  for (const failure of [0, 1, 2, 3, "privacy", "timeout"] as const) {
    let released = false; const statements: string[] = [];
    const client = { query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("privacy_deletion_backlog")) return { rows: [{ pending_count: failure === "privacy" ? "1" : "0" }] };
      if (sql.startsWith("WITH receipt_source")) {
        if (failure === "timeout") throw Object.assign(Error("private-db-detail"), { code: "57014" });
        return { rows: [{ source_counts: [0, 1, 2, 3].map(i => i === failure ? appleReportLimits.source_rows + 1 : 0),
          observations: [], receipts: [], deliveries: [], quota_rejections: [] }] };
      }
      return { rows: [] };
    }, release: () => { released = true; } };
    await assert.rejects(applePostbackReport({ connect: async () => client } as unknown as Pool,
      { tenantId: "synthetic-tenant", appId: "synthetic-app", keyId: "synthetic-key", role: "read_only" }, selection),
    new RegExp(typeof failure === "number" ? "source_limit" : failure === "privacy" ? "privacy_pending" : "report_unavailable"));
    assert.equal(released, true); assert.equal(statements.at(-1), "ROLLBACK"); assert.ok(!statements.includes("COMMIT"));
  }
});
