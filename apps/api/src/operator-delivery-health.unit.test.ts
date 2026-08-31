import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool, QueryResult } from "pg";
import { operatorDeliveryHealth } from "./operator-delivery-health.js";

function result<T extends Record<string, unknown>>(rows: readonly T[]): QueryResult<T> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows: [...rows] };
}

describe("operator delivery health", () => {
  it("summarizes bounded webhook and bulk-export state without selecting secret-bearing columns", async () => {
    const statements: string[] = [];
    let selectIndex = 0;
    const selects = [
      result([
        { state: "retry", total: "2", due_now: "1", scheduled: "1" },
        { state: "failed", total: "1", due_now: "0", scheduled: "0" },
      ]),
      result([{
        delivery_id: "00000000-0000-7000-8000-000000000129",
        destination_id: "webhook:synthetic",
        event_name: "custom_event",
        state: "retry",
        attempts: 2,
        next_attempt_at: new Date("2026-08-31T11:00:00.000Z"),
        last_http_status: 503,
        safe_reason: "transport_error",
        created_at: "2026-08-31T10:00:00.000Z",
        updated_at: "2026-08-31T10:30:00.000Z",
      }]),
      result([{ state: "succeeded", total: "1", due_now: "0", scheduled: "0" }]),
      result([{
        batch_id: "00000000-0000-7000-8000-000000000130",
        destination_id: "bulk:synthetic",
        row_count: 25,
        state: "succeeded",
        attempts: 1,
        next_attempt_at: new Date("2026-08-31T11:00:00.000Z"),
        last_http_status: 200,
        safe_reason: null,
        created_at: "2026-08-31T10:00:00.000Z",
        updated_at: "2026-08-31T10:31:00.000Z",
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
    const health = await operatorDeliveryHealth(pool, {
      tenantId: "tenant-synthetic",
      appId: "app-synthetic",
      keyId: "admin-key-synthetic",
      role: "read_only",
    });
    assert.deepEqual(health.webhooks.summary, {
      total: 3,
      due_now: 1,
      scheduled: 1,
      by_state: { queued: 0, retry: 2, succeeded: 0, failed: 1, suppressed: 0 },
    });
    assert.deepEqual(health.bulk_exports.summary, {
      total: 1,
      due_now: 0,
      scheduled: 0,
      by_state: { queued: 0, retry: 0, succeeded: 1, failed: 0, suppressed: 0 },
    });
    assert.equal(health.webhooks.deliveries[0]?.next_attempt_at, "2026-08-31T11:00:00.000Z");
    assert.equal(health.bulk_exports.batches[0]?.row_count, 25);
    const selected = statements.filter((statement) => statement.includes(" FROM ")).join("\n");
    for (const forbidden of [
      "logical_event_id", "record_id", "request_ref", "request_digest", "object_key", "object_ref",
      "object_digest", "credential_ref", "credential_digest", "reference_secret_ref", "secret_ref", "artifact",
    ]) assert.equal(selected.includes(forbidden), false, forbidden);
  });

  it("rejects an unbounded row limit before opening a database connection", async () => {
    let connects = 0;
    const pool = { async connect() { connects += 1; throw new Error("unexpected_connect"); } } as unknown as Pool;
    await assert.rejects(
      operatorDeliveryHealth(pool, {
        tenantId: "tenant-synthetic",
        appId: "app-synthetic",
        keyId: "admin-key-synthetic",
        role: "read_only",
      }, 101),
      /operator_delivery_health_limit_invalid/,
    );
    assert.equal(connects, 0);
  });
});
