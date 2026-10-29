import assert from "node:assert/strict";
import { it } from "node:test";
import type { Pool, PoolClient } from "pg";
import { appendDurableBatch } from "./ingest-batch.js";
import { admitInboxBatch, InboxCapacityError, readInboxAdmissionPolicy, validateInboxAdmissionPolicy, type InboxAdmissionPolicy } from "./inbox-admission.js";
import type { PayloadStore } from "./payload-store.js";

const policy: InboxAdmissionPolicy = { appCount: 2, appBytes: 100, globalCount: 4, globalBytes: 200, resumePercent: 50, retryAfterSeconds: 17 };

it("validates bounded inbox configuration and preserves the disabled default", () => {
  assert.deepEqual(validateInboxAdmissionPolicy(policy), policy);
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    assert.throws(() => validateInboxAdmissionPolicy({ ...policy, appBytes: value }), /configuration_invalid/);
  }
  assert.throws(() => validateInboxAdmissionPolicy({ ...policy, resumePercent: 100 }), /configuration_invalid/);
  assert.throws(() => validateInboxAdmissionPolicy({ ...policy, retryAfterSeconds: 3601 }), /configuration_invalid/);
  const old = process.env.OPENMASU_INBOX_ADMISSION_ENABLED;
  try {
    delete process.env.OPENMASU_INBOX_ADMISSION_ENABLED;
    assert.equal(readInboxAdmissionPolicy(), undefined);
    process.env.OPENMASU_INBOX_ADMISSION_ENABLED = "invalid";
    assert.throws(readInboxAdmissionPolicy, /configuration_invalid/);
  } finally {
    if (old === undefined) delete process.env.OPENMASU_INBOX_ADMISSION_ENABLED;
    else process.env.OPENMASU_INBOX_ADMISSION_ENABLED = old;
  }
});

it("maps closed capacity decisions without exposing measurements", async () => {
  for (const decision of ["accepted", "inbox_app_capacity", "inbox_global_capacity", "inbox_capacity_unknown"]) {
    const client = { query: async (sql: string, parameters: unknown[]) => {
      assert.match(sql, /control.admit_inbox_batch/);
      assert.deepEqual(parameters, ["tenant-synthetic", "app-synthetic", 12, 2, 100, 4, 200, 50]);
      return { rows: [{ decision }] };
    } } as unknown as PoolClient;
    const result = await admitInboxBatch(client, "tenant-synthetic", "app-synthetic", 12, policy);
    if (decision === "accepted") assert.equal(result, undefined);
    else {
      assert.ok(result instanceof InboxCapacityError);
      assert.equal(result.status, decision === "inbox_app_capacity" ? 429 : 503);
      assert.equal(result.retryAfterSeconds, 17);
      assert.equal(result.message, decision);
    }
  }
});

it("commits a capacity refusal latch before throwing, without writing a payload or receipt", async () => {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("admit_inbox_batch")) return { rows: [{ decision: "inbox_app_capacity" }] };
      return { rows: [] };
    },
    release() { statements.push("release"); },
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  const store: PayloadStore = {
    write: async () => { assert.fail("refused body must not be written"); },
    read: async () => Buffer.alloc(0), purge: async () => { assert.fail("no accepted body to purge"); }, scanFor: async () => false,
  };
  await assert.rejects(appendDurableBatch(pool, store, {
    tenantId: "tenant-synthetic", appId: "app-synthetic", producer: "sdk-android",
    body: Buffer.from("{}"), eventCount: 1, receivedAt: "2026-10-29T00:00:00.000Z",
  }, async () => { assert.fail("refusal must not create an acceptance receipt"); }, policy), InboxCapacityError);
  assert.ok(statements.includes("COMMIT"));
  assert.ok(!statements.includes("ROLLBACK"));
  assert.ok(!statements.some((sql) => sql.includes("INSERT INTO ledger.ingest_batches")));
});

it("holds privacy and admission before payload write and purges a later transaction failure", async () => {
  const steps: string[] = [];
  const client = {
    query: async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock_shared")) steps.push("privacy");
      if (sql.includes("admit_inbox_batch")) { steps.push("admission"); return { rows: [{ decision: "accepted" }] }; }
      if (sql.includes("INSERT INTO ledger.ingest_batches")) steps.push("insert");
      if (sql === "ROLLBACK") steps.push("rollback");
      return { rows: [] };
    }, release() {},
  } as unknown as PoolClient;
  const store: PayloadStore = {
    write: async () => { steps.push("write"); return "encrypted:synthetic"; },
    read: async () => Buffer.alloc(0), purge: async () => { steps.push("purge"); }, scanFor: async () => false,
  };
  await assert.rejects(appendDurableBatch({ connect: async () => client } as unknown as Pool, store, {
    tenantId: "tenant-synthetic", appId: "app-synthetic", producer: "sdk-android",
    body: Buffer.from("{}"), eventCount: 1, receivedAt: "2026-10-29T00:00:00.000Z",
  }, async () => { throw new Error("synthetic_receipt_failure"); }, policy), /synthetic_receipt_failure/);
  assert.deepEqual(steps, ["privacy", "admission", "write", "insert", "rollback", "purge"]);
});
