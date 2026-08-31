import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool, QueryResult } from "pg";
import { googleDeliveryHealth } from "./google-delivery-health.js";

function result<T extends Record<string, unknown>>(rows: readonly T[]): QueryResult<T> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows: [...rows] };
}

describe("Google Data Manager delivery health", () => {
  it("summarizes bounded operational state without selecting secret-bearing columns", async () => {
    const statements: string[] = [];
    let selectIndex = 0;
    const selects = [
      result([{ enabled: true, next_request_at: new Date("2026-08-31T10:00:00.000Z") }]),
      result([
        { state: "queued", total: "2", due_now: "1", scheduled: "1" },
        { state: "failed", total: "1", due_now: "0", scheduled: "0" },
      ]),
      result([{
        delivery_id: "00000000-0000-7000-8000-000000000127",
        state: "queued",
        attempts: 2,
        next_attempt_at: new Date("2026-08-31T10:01:00.000Z"),
        diagnostics_deadline_at: null,
        safe_reason: "rate_limited",
        created_at: "2026-08-31T09:00:00.000Z",
        updated_at: "2026-08-31T09:59:00.000Z",
      }]),
    ];
    const client = {
      async query(text: string) {
        statements.push(text);
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text) || text.startsWith("SELECT set_config")) return result([]);
        return selects[selectIndex++]!;
      },
      release() {},
    };
    const pool = { async connect() { return client; } } as unknown as Pool;
    const health = await googleDeliveryHealth(pool, {
      tenantId: "tenant-synthetic",
      appId: "app-synthetic",
      keyId: "admin-key-synthetic",
      role: "read_only",
    });
    assert.deepEqual(health.summary, {
      total: 3,
      due_now: 1,
      scheduled: 1,
      by_state: {
        queued: 2,
        http_accepted: 0,
        diagnostics_processing: 0,
        succeeded: 0,
        partial_success: 0,
        failed: 1,
        expired: 0,
      },
    });
    assert.equal(health.destination.next_request_at, "2026-08-31T10:00:00.000Z");
    assert.equal(health.deliveries[0]?.next_attempt_at, "2026-08-31T10:01:00.000Z");
    assert.equal(health.deliveries[0]?.safe_reason, "rate_limited");
    const selected = statements.filter((statement) => statement.includes(" FROM ")).join("\n");
    for (const forbidden of [
      "request_ref", "request_digest", "transaction_digest", "provider_request_id",
      "verification_result_id", "verified_record_id", "artifact", "claim_token", "claimed_until",
    ]) assert.equal(selected.includes(forbidden), false, forbidden);
  });

  it("rejects an unbounded row limit before opening a database connection", async () => {
    let connects = 0;
    const pool = { async connect() { connects += 1; throw new Error("unexpected_connect"); } } as unknown as Pool;
    await assert.rejects(
      googleDeliveryHealth(pool, {
        tenantId: "tenant-synthetic",
        appId: "app-synthetic",
        keyId: "admin-key-synthetic",
        role: "read_only",
      }, 101),
      /google_delivery_health_limit_invalid/,
    );
    assert.equal(connects, 0);
  });

  it("treats an immediately available destination as having no cooldown timestamp", async () => {
    let selectIndex = 0;
    const selects = [result([{ enabled: true, next_request_at: null }]), result([]), result([])];
    const client = {
      async query(text: string) {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text) || text.startsWith("SELECT set_config")) return result([]);
        return selects[selectIndex++]!;
      },
      release() {},
    };
    const pool = { async connect() { return client; } } as unknown as Pool;
    const health = await googleDeliveryHealth(pool, {
      tenantId: "tenant-synthetic",
      appId: "app-synthetic",
      keyId: "admin-key-synthetic",
      role: "read_only",
    });
    assert.deepEqual(health.destination, { configured: true, enabled: true, next_request_at: null });
  });
});
