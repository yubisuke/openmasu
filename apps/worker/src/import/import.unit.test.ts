import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadMapping, mapRow } from "./mapping.js";
import { readRows } from "./source.js";
import { normalizeGoogleAds, normalizeMaxBackfill, normalizeMetaInsights } from "./adapters.js";

describe("runtime import mapping", () => {
  it("applies nested objects, booleans, maps, uppercase, and timestamps", () => {
    const mapping = loadMapping("examples/mappings/synthetic-provider-click.json");
    const [row] = JSON.parse(requireText("examples/synthetic/mmp-raw-events.json"));
    const mapped = mapRow(mapping, row);
    assert.equal(mapped.payload.import_context.provider_attribution_strategy, "click_through");
    assert.equal(mapped.payload.import_context.provider_attributed, true);
    assert.equal(mapped.payload.country, "US");
    assert.equal(mapped.payload.bot_prefetch, false);
    assert.equal(mapped.occurred_at, "2026-08-19T00:00:00.000Z");
  });

  it("parses quoted CSV and enforces row byte limits", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmmp-import-"));
    try {
      const file = join(directory, "synthetic.csv");
      writeFileSync(file, 'network,campaign_id,country,date,cost_micros,currency\n"network, one",campaign-1,us,2026-08-18,1000000,USD\n');
      const mapping = loadMapping("examples/mappings/synthetic-manual-cost.json");
      const loaded = readRows(file, mapping, { maxBytes: 4096, maxRows: 2, maxRowBytes: 1024 });
      assert.equal(loaded.rows[0].network, "network, one");
      assert.throws(() => readRows(file, mapping, { maxBytes: 4096, maxRows: 2, maxRowBytes: 2 }), /exceeds 2 bytes/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("synthetic cost adapters", () => {
  const scope = { tenant_id: "tenant-a", app_id: "app-a", currency: "USD", as_of: "2026-08-19T00:00:00.000Z" };
  const responses = JSON.parse(requireText("examples/synthetic/cost-responses.json"));

  it("normalizes Meta daily country spend to scale-six money", () => {
    const [row] = normalizeMetaInsights(scope, responses.meta);
    assert.equal(row.amount_unscaled, "12345678");
    assert.equal(row.country, "US");
  });

  it("normalizes Google Ads micros and country criterion IDs", () => {
    const [row] = normalizeGoogleAds(scope, responses.google_ads, { "2840": "US" });
    assert.equal(row.amount_unscaled, "23456789");
    assert.equal(row.ad_group_id, "5001");
  });

  it("normalizes MAX reporting backfill as daily aggregate revenue", () => {
    const [row] = normalizeMaxBackfill(scope, responses.max);
    assert.equal(row.amount_unscaled, "1234567");
    assert.equal(row.currency, "USD");
  });
});

function requireText(path: string): string {
  return readFileSync(path, "utf8");
}
