import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SCHEDULED_WORKER_JOBS,
  runScheduledJob,
  validateSchedulePolicy,
  type ScheduledJobClaim,
  type SchedulerStore,
} from "./scheduler.js";

const policy = { intervalMs: 5_000, retryMs: 5_000, leaseMs: 300_000 };

class FakeStore implements SchedulerStore {
  claimValue: ScheduledJobClaim | null = {
    tenantId: "tenant-synthetic",
    job: "sdk_inbox",
    leaseToken: "018f0000-0000-7000-8000-000000000001",
    scheduledAt: new Date("2026-08-26T00:00:00.000Z"),
  };
  completed = 0;
  failed = 0;
  renewed = 0;

  async claim(): Promise<ScheduledJobClaim | null> { return this.claimValue; }
  async renew(): Promise<boolean> { this.renewed += 1; return true; }
  async complete(): Promise<boolean> { this.completed += 1; return true; }
  async fail(): Promise<boolean> { this.failed += 1; return true; }
}

describe("durable worker scheduler", () => {
  it("keeps the worker job vocabulary closed and the policy bounded", () => {
    assert.deepEqual(SCHEDULED_WORKER_JOBS, [
      "max_inbox", "sdk_inbox", "adservices_lookup", "integrity_verification",
      "google_play_verification", "commerce_readback", "google_conversion_delivery",
      "operator_webhook_delivery",
      "operator_bulk_export",
      "metric_run",
      "fraud_maintenance", "dashboard_session_sweep",
    ]);
    assert.doesNotThrow(() => validateSchedulePolicy(policy));
    assert.throws(() => validateSchedulePolicy({ ...policy, leaseMs: 999 }), /schedule lease/);
  });

  it("does not run a task when another worker owns the durable lease", async () => {
    const store = new FakeStore();
    store.claimValue = null;
    let ran = false;
    assert.equal(await runScheduledJob({
      store, tenantId: "tenant-synthetic", job: "sdk_inbox", policy,
      task: async () => { ran = true; },
    }), "not_due");
    assert.equal(ran, false);
    assert.equal(store.completed, 0);
    assert.equal(store.failed, 0);
    assert.equal(store.renewed, 0);
  });

  it("renews a long-running lease without exposing task details", async () => {
    const store = new FakeStore();
    assert.equal(await runScheduledJob({
      store,
      tenantId: "tenant-synthetic",
      job: "sdk_inbox",
      policy: { intervalMs: 1_000, retryMs: 1_000, leaseMs: 1_000 },
      task: async () => new Promise((resolve) => setTimeout(resolve, 400)),
    }), "succeeded");
    assert.equal(store.renewed, 1);
    assert.equal(store.completed, 1);
    assert.equal(store.failed, 0);
  });

  it("records failure when a long-running task loses its durable lease", async () => {
    const store = new FakeStore();
    store.renew = async () => { store.renewed += 1; return false; };
    assert.equal(await runScheduledJob({
      store,
      tenantId: "tenant-synthetic",
      job: "sdk_inbox",
      policy: { intervalMs: 1_000, retryMs: 1_000, leaseMs: 1_000 },
      task: async () => new Promise((resolve) => setTimeout(resolve, 400)),
    }), "failed");
    assert.equal(store.renewed, 1);
    assert.equal(store.completed, 0);
    assert.equal(store.failed, 1);
  });

  it("persists one success after the leased task completes", async () => {
    const store = new FakeStore();
    assert.equal(await runScheduledJob({
      store, tenantId: "tenant-synthetic", job: "sdk_inbox", policy,
      task: async () => undefined,
    }), "succeeded");
    assert.equal(store.completed, 1);
    assert.equal(store.failed, 0);
  });

  it("persists a sanitized failure and lets the caller continue", async () => {
    const store = new FakeStore();
    assert.equal(await runScheduledJob({
      store, tenantId: "tenant-synthetic", job: "sdk_inbox", policy,
      task: async () => { throw new Error("synthetic private provider detail"); },
    }), "failed");
    assert.equal(store.completed, 0);
    assert.equal(store.failed, 1);
  });
});
