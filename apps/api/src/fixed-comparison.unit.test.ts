import assert from "node:assert/strict";
import { it } from "node:test";
import type { Pool } from "pg";
import { fixedComparisonDownload, comparisonLimits } from "./fixed-comparison.js";
import { parseSnapshot, compareSnapshots } from "./cohort-comparison.js";
import type { MetricQuery } from "./report-query.js";

const identity = { tenantId: "tenant-synthetic", appId: "app-synthetic", keyId: "key:synthetic", role: "read_only" as const };
const query: MetricQuery = { ...identity, metricNames: ["daily_count"], grouping: { attribution_status: "organic" },
  dateFrom: "2026-01-01", dateTo: "2026-01-02", watermarkAtMost: "2026-01-10T00:00:00Z", supersession: "latest", limit: 1 };
function mock(afterPage?: () => Promise<void>, privacyPending = false) {
  const statements: string[] = [];
  let page = 0, releases = 0;
  const row = (country: string) => ({ grouping_digest: (country === "JP" ? "a" : "b").repeat(64), superseded: false,
    comparison_context: null, evidence_unavailable: false, artifact: {
      metric_run_id: `synthetic:${country}`, metric_name: "daily_count", metric_definition_version: "v1",
      input_snapshot_id: "c".repeat(64), input_received_at_watermark: "2026-01-10T00:00:00.000Z",
      aggregation_time_zone: "UTC", grouping: { dimensions: { cohort_date: "2026-01-01", attribution_status: "organic", country } },
      value_type: "count", value_state: "present", value_unscaled: "1", reproducibility_status: "fully_reproducible",
      rule_bundle_id: "synthetic", rule_bundle_hash: "d".repeat(64), rule_bundle_version: "v1",
      data_freshness: "complete", input_ledger_position: "1", computed_at: "2026-01-10T00:00:01.000Z",
    } });
  const pool = { connect: async () => ({ query: async (sql: string) => {
    statements.push(sql);
    if (sql.includes("current_setting('statement_timeout')")) return { rows: [{ value: "0" }] };
    if (sql.includes("privacy_deletion_backlog")) return { rows: [{ pending_count: privacyPending ? "1" : "0" }] };
    if (sql.startsWith("SELECT mr.artifact")) {
      const rows = page++ === 0 ? [row("JP"), row("GB")] : [row("GB")];
      await afterPage?.(); return { rows };
    }
    return { rows: [] };
  }, release: () => { releases++; } }) } as unknown as Pool;
  return { pool, statements, releases: () => releases };
}
it("buffers all pages under a privacy-fenced repeatable read and binds a reproducible completion receipt", async () => {
  const a = mock(), b = mock();
  const body = await fixedComparisonDownload(a.pool, identity, query, { declaredAggregation: "on_day" });
  assert.equal(body, await fixedComparisonDownload(b.pool, identity, query, { declaredAggregation: "on_day" }));
  const snapshot = parseSnapshot(JSON.parse(body));
  assert.equal(snapshot.rows.length, 2); assert.equal(snapshot.acquisition?.row_count, 2);
  assert.equal(snapshot.acquisition?.state, "complete"); assert.equal(snapshot.acquisition?.upstream_completeness, "unknown");
  assert.equal(compareSnapshots(snapshot, snapshot).status, "incomparable", "acquisition must not approve unknown calculation meaning");
  const fence = a.statements.findIndex(sql => sql.includes("pg_advisory_lock_shared"));
  const begin = a.statements.findIndex(sql => sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const firstRead = a.statements.findIndex(sql => sql.startsWith("SELECT mr.artifact"));
  assert.ok(fence < begin && begin < firstRead);
  assert.ok(a.statements.includes("COMMIT")); assert.equal(a.releases(), 1);
  assert.ok(a.statements.some(sql => sql.includes("pg_advisory_unlock_shared")));
  for (const patch of [{ state: "incomplete" }, { row_count: 1 }, { selection_sha256: "e".repeat(64) }]) {
    assert.throws(() => parseSnapshot({ ...snapshot, acquisition: { ...snapshot.acquisition, ...patch } }));
  }
});
it("rejects row/byte bounds and interruption without publishing partial comparison inputs", async () => {
  for (const bounds of [{ ...comparisonLimits, rows: 1 }, { ...comparisonLimits, bytes: 10 }]) {
    const run = mock();
    await assert.rejects(fixedComparisonDownload(run.pool, identity, query, { declaredAggregation: "on_day", bounds }), /comparison_incomplete_or_limit_exceeded/);
    assert.ok(run.statements.includes("ROLLBACK")); assert.equal(run.releases(), 1);
  }
  const abort = new AbortController(), interrupted = mock(async () => abort.abort());
  await assert.rejects(fixedComparisonDownload(interrupted.pool, identity, query,
    { declaredAggregation: "on_day", signal: abort.signal }), /comparison_acquisition_incomplete/);
  assert.ok(interrupted.statements.includes("ROLLBACK")); assert.equal(interrupted.releases(), 1);
});
it("enforces a total acquisition deadline and redacts database failure text", async () => {
  const slow = mock(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
  await assert.rejects(fixedComparisonDownload(slow.pool, identity, query,
    { declaredAggregation: "on_day", bounds: { ...comparisonLimits, milliseconds: 5 } }), /comparison_acquisition_incomplete/);
  assert.equal(slow.releases(), 1);
  const failed = mock(async () => { throw new Error("synthetic-private-input-text"); });
  await assert.rejects(fixedComparisonDownload(failed.pool, identity, query, { declaredAggregation: "on_day" }),
    error => error instanceof Error && error.message === "comparison_acquisition_incomplete");
  assert.equal(failed.releases(), 1);
});
it("refuses missing selection and cross-scope access before obtaining a database client", async () => {
  const run = mock();
  await assert.rejects(fixedComparisonDownload(run.pool, identity, { ...query, watermarkAtMost: undefined }));
  await assert.rejects(fixedComparisonDownload(run.pool, identity, { ...query, tenantId: "other" }), /comparison_scope_mismatch/);
  await assert.rejects(fixedComparisonDownload(run.pool, identity, { ...query, appId: "other" }), /comparison_scope_mismatch/);
  assert.deepEqual(run.statements, []);
});

it("waits for privacy processing without requesting private job-table access", async () => {
  const run = mock(undefined, true);
  await assert.rejects(fixedComparisonDownload(run.pool, identity, query), /comparison_privacy_pending/);
  assert.ok(!run.statements.some(sql => sql.startsWith("SELECT mr.artifact")));
  assert.ok(!run.statements.some(sql => sql.includes("control.privacy_deletion_jobs")));
  assert.ok(run.statements.includes("ROLLBACK")); assert.equal(run.releases(), 1);
});
