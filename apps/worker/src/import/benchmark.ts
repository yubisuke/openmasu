import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createAppPool, withTenant } from "@openmasu/runtime";
import { runMmpImport } from "./runner.js";

const rows = 100_000;
const maximumSeconds = 300;
const directory = mkdtempSync(join(tmpdir(), "openmasu-import-benchmark-"));
const pool = createAppPool();
try {
  const suffix = `${Date.now()}`;
  const mappingPath = join(directory, "mapping.json");
  const filePath = join(directory, "rows.csv");
  writeFileSync(mappingPath, JSON.stringify({
    version: "1.0.0", kind: "mmp_raw", source_id: `synthetic-benchmark-${suffix}`,
    tenant_id: `tenant-benchmark-${suffix}`, app_id: "app-benchmark",
    provider: "synthetic-benchmark-provider", format: "csv",
    rules: [
      { target: "event_name", expression: { const: "click" } },
      { target: "event_id", expression: { source: "event_id" } },
      { target: "occurred_at", expression: { source: "occurred_at", timestamp: { default_timezone: "UTC", truncate_to_milliseconds: true } } },
      { target: "payload", expression: { object: {
        click_id: { source: "click_id" }, tracking_link_id: { const: "synthetic-benchmark-link" },
        campaign_id: { const: "synthetic-benchmark-campaign" }, redirector_time_status: { const: "missing" },
      } } },
    ],
  }));
  const lines = new Array<string>(rows + 1);
  lines[0] = "event_id,occurred_at,click_id";
  for (let index = 0; index < rows; index += 1) {
    lines[index + 1] = `synthetic-event-${suffix}-${index},2026-08-21T00:00:00,synthetic-click-${suffix}-${index}`;
  }
  writeFileSync(filePath, `${lines.join("\n")}\n`);
  const started = performance.now();
  const summary = await runMmpImport({
    pool, mappingPath, filePath, now: new Date("2026-08-21T12:00:00.000Z"),
  });
  const elapsedSeconds = (performance.now() - started) / 1_000;
  assert.equal(summary.accepted, rows);
  assert.equal(summary.rejected, 0);
  assert.equal(summary.logical_events, rows);
  const retry = await runMmpImport({
    pool, mappingPath, filePath, now: new Date("2026-08-21T12:01:00.000Z"),
  });
  assert.equal(retry.status, "skipped");
  assert.equal(retry.accepted, 0);
  const counts = await withTenant(pool, `tenant-benchmark-${suffix}`, async (client) =>
    (await client.query<{ raw: number; deliveries: number; logical: number; facts: number }>(`SELECT
      (SELECT count(*)::int FROM ledger.raw_records)::int AS raw,
      (SELECT count(*)::int FROM ledger.event_deliveries)::int AS deliveries,
      (SELECT count(*)::int FROM ledger.logical_events)::int AS logical,
      (SELECT count(*)::int FROM ledger.click_facts)::int AS facts`)).rows[0]);
  assert.deepEqual(counts, { raw: rows, deliveries: rows, logical: rows, facts: rows });
  assert.ok(elapsedSeconds <= maximumSeconds, `synthetic ${rows}-row import took ${elapsedSeconds.toFixed(3)}s`);
  console.log(JSON.stringify({ benchmark: "wo16_mmp_raw_import", rows, elapsed_seconds: Number(elapsedSeconds.toFixed(3)), maximum_seconds: maximumSeconds }));
} finally {
  await pool.end();
  rmSync(directory, { recursive: true, force: true });
}
