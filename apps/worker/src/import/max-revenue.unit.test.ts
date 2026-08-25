import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import {
  maxAggregateRevenueArtifact,
  normalizeMaxAggregateRevenue,
  persistMaxAggregateRevenue,
} from "./max-revenue.js";

const scope = {
  tenant_id: "synthetic-tenant",
  app_id: "synthetic-app",
  as_of: "2026-08-24T00:00:00.000Z",
};

function response(amount = "1.234567"): { results: Record<string, unknown>[] } {
  return { results: [{
    day: "2026-08-23",
    country: "us",
    max_ad_unit_id: "synthetic-unit",
    network: "synthetic-network",
    estimated_revenue: amount,
  }] };
}

function memoryPool(): Pool {
  const snapshotKeys = new Set<string>();
  const currentDimensions = new Set<string>();
  const client = {
    async query(text: string, values: unknown[] = []) {
      if (text.includes("INSERT INTO ledger.aggregate_revenue_snapshots")) {
        const key = `${values[1]}:${values[2]}:${values[13]}:${values[14]}`;
        const inserted = snapshotKeys.has(key) ? 0 : 1;
        snapshotKeys.add(key);
        currentDimensions.add(`${values[1]}:${values[2]}:${values[14]}`);
        return { rowCount: inserted, rows: [] };
      }
      if (text.includes("ledger.aggregate_revenue_snapshots_current")) {
        return { rowCount: 1, rows: [{ count: currentDimensions.size }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  return { connect: async () => client } as unknown as Pool;
}

describe("MAX aggregate-revenue snapshots", () => {
  it("normalizes the official MAX columns into a separate aggregate-revenue series", () => {
    const [row] = normalizeMaxAggregateRevenue(scope, response());
    assert.deepEqual(row, {
      ...scope,
      provider: "applovin-max",
      source_series: "provider_reported_aggregate",
      date: "2026-08-23",
      max_ad_unit_id: "synthetic-unit",
      network: "synthetic-network",
      country: "US",
      amount_unscaled: "1234567",
      amount_scale: 6,
      currency: "USD",
    });
    const artifact = maxAggregateRevenueArtifact(row, "a".repeat(64));
    const serialized = JSON.stringify(artifact);
    assert.doesNotMatch(serialized, /installation_id|cost_record|spend_/);
    assert.equal(artifact.source_series, "provider_reported_aggregate");
  });

  it("accepts the legacy synthetic ad_unit_id alias without retaining the old name", () => {
    const [row] = normalizeMaxAggregateRevenue(scope, [{
      day: "2026-08-23", country: "", ad_unit_id: "synthetic-legacy-unit",
      network: "synthetic-network", estimated_revenue: "0",
    }]);
    assert.equal(row.max_ad_unit_id, "synthetic-legacy-unit");
    assert.equal(row.country, null);
    assert.equal(row.amount_unscaled, "0");
  });

  it("rejects malformed money, dates, countries, duplicates, and oversized responses", () => {
    assert.throws(() => normalizeMaxAggregateRevenue(scope, response("1.2345678")), /exceeds scale/);
    assert.throws(() => normalizeMaxAggregateRevenue(scope, response("-1")), /non-negative decimal/);
    assert.throws(() => normalizeMaxAggregateRevenue(scope, response("1e3")), /without exponent/);
    assert.throws(() => normalizeMaxAggregateRevenue(scope, {
      results: [{ ...response().results[0], day: "2026-02-30" }],
    }), /valid YYYY-MM-DD/);
    assert.throws(() => normalizeMaxAggregateRevenue(scope, {
      results: [{ ...response().results[0], country: "USA" }],
    }), /no longer than 2/);
    assert.throws(() => normalizeMaxAggregateRevenue(scope, {
      results: [response().results[0], response().results[0]],
    }), /duplicate retained dimension/);
    assert.throws(() => normalizeMaxAggregateRevenue(scope, response(), { maxRows: 0 }), /positive safe integer/);
    assert.throws(() => normalizeMaxAggregateRevenue(scope, response(), { maxRows: 0.5 }), /positive safe integer/);
    assert.doesNotThrow(() => normalizeMaxAggregateRevenue(scope, response(), { maxRows: 1 }));
    assert.throws(() => normalizeMaxAggregateRevenue(scope, {
      results: [response().results[0], { ...response().results[0], country: "JP" }],
    }, { maxRows: 1 }), /row limit/);
  });

  it("is idempotent for one report and retains restatements while keeping one current row", async () => {
    const pool = memoryPool();
    const firstRows = normalizeMaxAggregateRevenue(scope, response("1.000000"));
    const first = await persistMaxAggregateRevenue(pool, firstRows);
    const replay = await persistMaxAggregateRevenue(pool, normalizeMaxAggregateRevenue(
      { ...scope, as_of: "2026-08-24T00:30:00.000Z" }, response("1.000000"),
    ));
    const restatedRows = normalizeMaxAggregateRevenue(
      { ...scope, as_of: "2026-08-24T01:00:00.000Z" }, response("2.000000"),
    );
    const restated = await persistMaxAggregateRevenue(pool, restatedRows);
    assert.equal(first.inserted, 1);
    assert.equal(replay.inserted, 0);
    assert.equal(first.report_snapshot_digest, replay.report_snapshot_digest);
    assert.equal(restated.inserted, 1);
    assert.equal(restated.current, 1);
    assert.notEqual(first.report_snapshot_digest, restated.report_snapshot_digest);
  });
});
