import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { compareSnapshots, parseSnapshot } from "./compare-cohorts.js";

it("runs the synthetic CLI and rejects invalid arguments without printing inputs", () => {
  const path = "examples/synthetic/cohort-snapshot.json";
  const run = spawnSync(process.execPath, ["--import", "tsx", "tools/compare-cohorts.ts", path, path], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).rows[0].status, "equal");
  const bad = spawnSync(process.execPath, ["--import", "tsx", "tools/compare-cohorts.ts"], { encoding: "utf8" });
  assert.equal(bad.status, 1); assert.equal(bad.stdout, "");
});

const snapshot = () => ({ source: "synthetic", conditions: { date_from: "2026-01-01", date_to: "2026-01-02", time_zone: "UTC", maturity: "fully_elapsed_d7", aggregation: "cumulative", attribution_scope: "organic", metric_definition: "revenue_d7_v1", source_cutoff: "2026-01-10T00:00:00.000Z" }, rows: [{ key: "total", currency: "USD", scale: 2, state: "present", value: "100" }] });
it("compares equal scaled values and exact large integers", () => {
  const a = snapshot(), b = snapshot(); b.rows[0].scale = 3; b.rows[0].value = "1000";
  assert.equal(compareSnapshots(a, b).rows[0].status, "equal");
  a.rows[0].value = "900719925474099300"; b.rows[0].scale = 2; b.rows[0].value = "900719925474099301";
  assert.equal(compareSnapshots(a, b).rows[0].delta_right_minus_left, "1");
});
it("refuses each incompatible comparison condition", () => {
  for (const [key, value] of Object.entries({ date_from: "2025-12-31", date_to: "2026-01-03", time_zone: "Asia/Tokyo", maturity: "partial", aggregation: "on_day", attribution_scope: "unattributed", metric_definition: "other", source_cutoff: "2026-01-11T00:00:00.000Z" })) {
    const b = snapshot(); Object.assign(b.conditions, { [key]: value });
    assert.equal(compareSnapshots(snapshot(), b).status, "incomparable");
  }
});
it("distinguishes missing undefined zero and currency mismatch", () => {
  const a = snapshot(), b = snapshot(); b.rows = [];
  assert.equal(compareSnapshots(a, b).rows[0].status, "missing_right");
  const undefinedInput = { ...a, rows: [{ key: "total", currency: "USD", scale: 2, state: "undefined", reason: "no_cost" }] };
  assert.equal(compareSnapshots(a, undefinedInput).rows[0].status, "undefined");
  b.rows = [{ ...a.rows[0], value: "0" }];
  assert.equal(compareSnapshots(a, b).rows[0].status, "different");
  b.rows[0].currency = "EUR"; assert.equal(compareSnapshots(a, b).rows[0].status, "currency_mismatch");
});
it("rejects duplicate keys and malformed inputs", () => {
  const a = snapshot(); a.rows.push(a.rows[0]); assert.throws(() => parseSnapshot(a), /duplicate_key/);
  const b = snapshot(); b.rows[0].value = "1.2"; assert.throws(() => parseSnapshot(b));
  const c = snapshot(); c.conditions.date_from = "2026-02-30"; assert.throws(() => parseSnapshot(c));
  assert.throws(() => parseSnapshot({ ...snapshot(), extra: true }));
});
it("is deterministic across row order and repeated evaluation", () => {
  const a = snapshot(); a.rows.push({ ...a.rows[0], key: "another" });
  const b = { ...a, rows: [...a.rows].reverse() };
  assert.deepEqual(compareSnapshots(a, b), compareSnapshots(b, a));
  assert.deepEqual(compareSnapshots(a, b), compareSnapshots(a, b));
});
