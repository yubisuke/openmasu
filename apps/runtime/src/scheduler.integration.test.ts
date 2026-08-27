import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Pool } from "pg";
import { createAppPool, withTenant } from "./index.js";
import { PostgresSchedulerStore } from "./scheduler.js";

describe("durable worker scheduler PostgreSQL lease", () => {
  it("admits one worker, persists restart timing, and retries a sanitized failure", async () => {
    const pool = createAppPool();
    const tenantId = `tenant-scheduler-${Date.now()}`;
    const store = new PostgresSchedulerStore(pool);
    const policy = { intervalMs: 5_000, retryMs: 2_000, leaseMs: 60_000 };
    const firstAt = new Date("2026-08-26T00:00:00.000Z");
    let finalClaim: Awaited<ReturnType<typeof store.claim>> = null;
    try {
      const concurrent = await Promise.all([
        store.claim(tenantId, "sdk_inbox", policy, firstAt),
        store.claim(tenantId, "sdk_inbox", policy, firstAt),
      ]);
      const claims = concurrent.filter((value) => value !== null);
      assert.equal(claims.length, 1, "only one worker may own the tenant/job lease");
      assert.equal(await store.complete(claims[0]!, new Date("2026-08-26T00:00:01.000Z")), true);

      assert.equal(
        await store.claim(tenantId, "sdk_inbox", policy, new Date("2026-08-26T00:00:05.999Z")),
        null,
        "a restarted worker must respect persisted next_run_at",
      );
      const retryClaim = await store.claim(
        tenantId,
        "sdk_inbox",
        policy,
        new Date("2026-08-26T00:00:06.000Z"),
      );
      assert.ok(retryClaim);
      assert.equal(await store.fail(retryClaim, new Date("2026-08-26T00:00:07.000Z")), true);
      assert.equal(
        await store.claim(tenantId, "sdk_inbox", policy, new Date("2026-08-26T00:00:08.999Z")),
        null,
      );
      finalClaim = await store.claim(
        tenantId,
        "sdk_inbox",
        policy,
        new Date("2026-08-26T00:00:09.000Z"),
      );
      assert.ok(finalClaim);

      const state = await withTenant(pool, tenantId, (client) => client.query<{
        success_count: string;
        failure_count: string;
        consecutive_failures: number;
        last_outcome: string;
      }>(
        `SELECT success_count::text, failure_count::text, consecutive_failures, last_outcome
           FROM control.worker_job_schedules
          WHERE tenant_id=$1 AND job_name='sdk_inbox'`,
        [tenantId],
      ));
      assert.deepEqual(state.rows[0], {
        success_count: "1",
        failure_count: "1",
        consecutive_failures: 1,
        last_outcome: "failed",
      });
    } finally {
      if (finalClaim) {
        await store.complete(finalClaim, new Date("2026-08-26T00:00:10.000Z"));
      }
      await pool.end();
    }
  });

  it("finalizes a lease with a one-connection scheduler pool", async () => {
    const connectionString = process.env.OPENMASU_APP_DATABASE_URL;
    assert.ok(connectionString, "OPENMASU_APP_DATABASE_URL is required");
    const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 1_000 });
    const tenantId = `tenant-scheduler-budget-${Date.now()}`;
    const store = new PostgresSchedulerStore(pool);
    const policy = { intervalMs: 1_000, retryMs: 1_000, leaseMs: 60_000 };
    let outstanding: Awaited<ReturnType<typeof store.claim>> = null;
    try {
      outstanding = await store.claim(tenantId, "sdk_inbox", policy, new Date("2026-08-26T01:00:00.000Z"));
      assert.ok(outstanding);
      assert.equal(await store.complete(outstanding, new Date("2026-08-26T01:00:00.500Z")), true);
      outstanding = null;

      outstanding = await store.claim(tenantId, "sdk_inbox", policy, new Date("2026-08-26T01:00:01.500Z"));
      assert.ok(outstanding);
      assert.equal(await store.fail(outstanding, new Date("2026-08-26T01:00:02.000Z")), true);
      outstanding = null;
    } finally {
      if (outstanding) await store.fail(outstanding, new Date("2026-08-26T01:00:03.000Z"));
      await pool.end();
    }
  });
});
