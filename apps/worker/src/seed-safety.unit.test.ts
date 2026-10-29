import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { resetLedger } from "./test-support/fixture-ingestion.js";
import { retryDeadlockOnce, withSyntheticSeedLock } from "./test-support/seed-safety.js";

describe("synthetic seed deployment-purpose fence", () => {
  for (const [name, rows] of [
    ["persistent", [{ purpose: "persistent" }]],
    ["missing", []],
    ["ambiguous", [{ purpose: "synthetic_disposable" }, { purpose: "synthetic_disposable" }]],
  ] as const) {
    it(`rejects ${name} purpose before the seed callback or ledger reset can mutate data`, async () => {
      const queries: string[] = [];
      let releases = 0;
      let callbackEntered = false;
      const client = {
        async query(sql: string) {
          queries.push(sql);
          if (sql.includes("FROM control.deployment_purpose")) return { rows, rowCount: rows.length };
          if (/^(BEGIN|ROLLBACK|COMMIT)$/.test(sql) || sql.includes("pg_advisory_")) return { rows: [], rowCount: 0 };
          throw new Error(`unexpected_query_before_seed_refusal: ${sql}`);
        },
        release() { releases += 1; },
      };
      const pool = { async connect() { return client; } } as unknown as Pool;
      await assert.rejects(withSyntheticSeedLock(pool, async () => {
        callbackEntered = true;
      }), /synthetic_seed_requires_disposable/);
      await assert.rejects(resetLedger(pool), /synthetic_seed_requires_disposable/);
      assert.equal(callbackEntered, false);
      assert.equal(queries.filter(sql => sql.includes("FROM control.deployment_purpose")).length, 2);
      assert.equal(queries.some(sql => /\b(DELETE|TRUNCATE|INSERT|UPDATE)\b/i.test(sql)), false);
      assert.equal(queries.some(sql => sql.includes("information_schema.tables")), false);
      assert.equal(queries.filter(sql => sql.includes("pg_advisory_unlock")).length, 1);
      assert.equal(releases, 2);
    });
  }
});

describe("WO13 synthetic seed deadlock handling", () => {
  it("retries one PostgreSQL 40P01 failure and returns the second result", async () => {
    let attempts = 0;
    const result = await retryDeadlockOnce(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("synthetic deadlock"), { code: "40P01" });
      return "recovered";
    });
    assert.equal(result, "recovered");
    assert.equal(attempts, 2);
  });

  it("does not retry a non-deadlock database failure", async () => {
    let attempts = 0;
    await assert.rejects(retryDeadlockOnce(async () => {
      attempts += 1;
      throw Object.assign(new Error("synthetic constraint failure"), { code: "23505" });
    }), /synthetic constraint failure/);
    assert.equal(attempts, 1);
  });

  it("stops after one retry when PostgreSQL reports a second 40P01", async () => {
    let attempts = 0;
    await assert.rejects(retryDeadlockOnce(async () => {
      attempts += 1;
      throw Object.assign(new Error(`synthetic deadlock ${attempts}`), { code: "40P01" });
    }), /synthetic deadlock 2/);
    assert.equal(attempts, 2);
  });
});
