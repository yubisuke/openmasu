import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { lintMappings, loadMapping, mapRow, rowMatches } from "./mapping.js";
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
    const directory = mkdtempSync(join(tmpdir(), "openmasu-import-"));
    try {
      const file = join(directory, "synthetic.csv");
      writeFileSync(file, 'network,campaign_id,country,date,cost_micros,currency\n"network, one",campaign-1,us,2026-08-18,1000000,USD\n');
      const mapping = loadMapping("examples/mappings/synthetic-manual-cost.json");
      const loaded = readRows(file, mapping, { maxBytes: 4096, maxRows: 2, maxRowBytes: 1024 });
      assert.equal(loaded.rows[0].network, "network, one");
      assert.throws(() => readRows(file, mapping, { maxBytes: 4096, maxRows: 2, maxRowBytes: 2 }), /exceeds 2 bytes/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("WO11 warns when event routes reuse one producer-scoped ID source without namespaces", () => {
    const click = loadMapping("examples/mappings/synthetic-shared-id-click.json");
    const install = loadMapping("examples/mappings/synthetic-shared-id-install.json");
    assert.deepEqual(lintMappings([click, install]), []);
    const unprefixed = [click, install].map((mapping) => ({
      ...mapping,
      rules: mapping.rules.map((rule) => rule.target === "event_id"
        ? { ...rule, expression: { source: "shared_id" } }
        : rule),
    }));
    assert.deepEqual(lintMappings(unprefixed), [{
      code: "event_id_source_reused_across_routes",
      provider: "synthetic-shared-provider",
      source: "shared_id",
      source_ids: ["synthetic-shared-clicks", "synthetic-shared-installs"],
      message: "event_id is producer-scoped across event names; add distinct prefixes or otherwise namespace the shared source column",
    }]);
  });

  it("WO11 evaluates every clause in an AND row filter", () => {
    const mapping = loadMapping("examples/mappings/synthetic-and-filter-click.json");
    assert.equal(rowMatches(mapping, { event_type: "click", row_status: "accepted" }), true);
    assert.equal(rowMatches(mapping, { event_type: "click", row_status: "rejected" }), false);
    assert.equal(rowMatches(mapping, { event_type: "install", row_status: "accepted" }), false);
  });

  it("WO11 uses a declared fallback column only when the primary column is empty", () => {
    const mapping = loadMapping("examples/mappings/synthetic-fallback-install.json");
    const base = {
      occurred_at: "2026-08-20T00:00:00", installation_id: "synthetic-fallback-installation",
      primary_event_id: "", legacy_event_id: "synthetic-legacy-event",
    };
    assert.equal(mapRow(mapping, base).event_id, "synthetic-legacy-event");
    assert.equal(mapRow(mapping, { ...base, primary_event_id: "synthetic-primary-event" }).event_id, "synthetic-primary-event");
  });

  it("WO11 converts an integer money column with explicit scale without losing precision", () => {
    const mapping = loadMapping("examples/mappings/synthetic-integer-cost.json");
    const base = {
      network: "synthetic-network", campaign_id: "synthetic-campaign", country: "jp",
      date: "2026-08-20", cost_micros: "123456789012345678", currency: "USD",
      as_of: "2026-08-20T12:00:00.000Z",
    };
    assert.deepEqual(mapRow(mapping, base).money, {
      amount_unscaled: "123456789012345678", amount_scale: 6, currency: "USD",
    });
    assert.throws(() => mapRow(mapping, { ...base, cost_micros: "-1" }), /non-negative base-10 integer/);
    assert.throws(() => mapRow(mapping, { ...base, cost_micros: Number.MAX_SAFE_INTEGER + 1 }), /non-negative base-10 integer/);
  });

  it("WO12 converts an exact decimal money source at the declared scale", () => {
    const mapping = loadMapping("examples/mappings/synthetic-decimal-cost.json");
    const mapped = mapRow(mapping, {
      network: "synthetic-decimal-network", campaign_id: "synthetic-decimal-campaign", country: "us",
      date: "2026-08-20", cost_decimal: "1.23", currency: "USD",
      as_of: "2026-08-20T12:00:00.000Z",
    });
    assert.deepEqual(mapped.money, {
      amount_unscaled: "1230000", amount_scale: 6, currency: "USD",
    });
  });

  it("WO12 rejects decimal precision beyond the declared scale without rounding", () => {
    const mapping = loadMapping("examples/mappings/synthetic-decimal-cost.json");
    const row = {
      network: "synthetic-decimal-network", campaign_id: "synthetic-decimal-campaign", country: "us",
      date: "2026-08-20", cost_decimal: "1.2345678", currency: "USD",
      as_of: "2026-08-20T12:00:00.000Z",
    };
    assert.throws(() => mapRow(mapping, row), /exceeds the declared scale; rounding is not permitted/);
  });

  it("WO12 rejects non-decimal and negative decimal money sources", () => {
    const mapping = loadMapping("examples/mappings/synthetic-decimal-cost.json");
    const base = {
      network: "synthetic-decimal-network", campaign_id: "synthetic-decimal-campaign", country: "us",
      date: "2026-08-20", currency: "USD", as_of: "2026-08-20T12:00:00.000Z",
    };
    assert.throws(() => mapRow(mapping, { ...base, cost_decimal: "not-a-number" }), /non-negative base-10 decimal string/);
    assert.throws(() => mapRow(mapping, { ...base, cost_decimal: "-1.23" }), /non-negative base-10 decimal string/);
    assert.throws(() => mapRow(mapping, { ...base, cost_decimal: 1.23 }), /non-negative base-10 decimal string/);
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
