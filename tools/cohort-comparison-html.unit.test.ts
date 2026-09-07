import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { compareSnapshots } from "./compare-cohorts.js";
import { decimal, renderComparison } from "./cohort-comparison-html.js";

const input = () => JSON.parse(readFileSync("examples/synthetic/cohort-snapshot.json", "utf8"));
it("renders exact numbers without scientific notation or rounding", () => {
  assert.equal(decimal("-1", 3), "-0.001");
  assert.equal(decimal("900719925474099301", 2), "9007199254740993.01");
  assert.equal(decimal("0", 0), "0");
  const a = input(), b = input(); b.rows[0].value = "101";
  const html = renderComparison(compareSnapshots(a, b));
  assert.match(html, /0\.01 USD/); assert.match(html, /different/);
});
it("escapes input HTML and uses no scripts or external resources", () => {
  const a = input(); a.source = '<script>alert("x")</script>'; a.rows[0].key = '<img src=x onerror="x">';
  const html = renderComparison(compareSnapshots(a, a));
  assert.ok(html.includes("&lt;script&gt;")); assert.ok(html.includes("&lt;img"));
  assert.doesNotMatch(html, /<script|<img|<link|<style|<iframe/i);
  assert.match(html, /default-src 'none'/);
  assert.equal(html, renderComparison(compareSnapshots(a, a)));
});
it("renders mismatch missing undefined and currency states explicitly", () => {
  const a = input(), b = input(); b.conditions.maturity = "partial";
  assert.match(renderComparison(compareSnapshots(a, b)), /No numerical comparison/);
  b.conditions = a.conditions; b.rows = [];
  assert.match(renderComparison(compareSnapshots(a, b)), /Missing row/);
  b.rows = [{ key: "total", currency: "USD", scale: 2, state: "undefined", reason: "no_cost" }];
  assert.match(renderComparison(compareSnapshots(a, b)), /Undefined: no_cost/);
  b.rows = [{ ...a.rows[0], currency: "EUR" }];
  assert.match(renderComparison(compareSnapshots(a, b)), /currency_mismatch/);
});
it("outputs standalone HTML through the CLI", () => {
  const path = "examples/synthetic/cohort-snapshot.json";
  const run = spawnSync(process.execPath, ["--import", "tsx", "tools/compare-cohorts.ts", "--html", path, path], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr); assert.ok(run.stdout.startsWith("<!doctype html>"));
});
