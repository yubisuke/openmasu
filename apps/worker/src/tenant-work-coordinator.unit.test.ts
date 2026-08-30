import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_WORKER_CONCURRENCY,
  DEFAULT_WORKER_INBOX_BATCH_LIMIT,
  DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS,
  MAX_WORKER_CONCURRENCY,
  MAX_WORKER_INBOX_BATCH_LIMIT,
  MAX_WORKER_SHUTDOWN_TIMEOUT_MS,
  TenantWorkCoordinator,
  parseWorkerConcurrency,
  parseWorkerInboxBatchLimit,
  parseWorkerShutdownTimeout,
  waitForWorkerDrain,
  workerPoolSizes,
} from "./tenant-work-coordinator.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("bounded tenant work coordinator", () => {
  it("uses a bounded default and rejects invalid worker concurrency", () => {
    assert.equal(parseWorkerConcurrency(undefined), DEFAULT_WORKER_CONCURRENCY);
    assert.equal(parseWorkerConcurrency("1"), 1);
    assert.equal(parseWorkerConcurrency(String(MAX_WORKER_CONCURRENCY)), MAX_WORKER_CONCURRENCY);
    for (const value of ["0", "17", "1.5", "NaN", ""]) {
      assert.throws(() => parseWorkerConcurrency(value), /OPENMASU_WORKER_CONCURRENCY/);
    }
    assert.deepEqual(workerPoolSizes(1), { jobs: 2, scheduler: 1 });
    assert.deepEqual(workerPoolSizes(DEFAULT_WORKER_CONCURRENCY), { jobs: 8, scheduler: 4 });
    assert.equal(parseWorkerShutdownTimeout(undefined), DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS);
    assert.equal(parseWorkerShutdownTimeout("1000"), 1_000);
    assert.equal(
      parseWorkerShutdownTimeout(String(MAX_WORKER_SHUTDOWN_TIMEOUT_MS)),
      MAX_WORKER_SHUTDOWN_TIMEOUT_MS,
    );
    for (const value of ["999", "300001", "1.5", "NaN", ""]) {
      assert.throws(() => parseWorkerShutdownTimeout(value), /OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS/);
    }
    assert.equal(
      parseWorkerInboxBatchLimit("OPENMASU_SDK_INBOX_BATCH_LIMIT", undefined),
      DEFAULT_WORKER_INBOX_BATCH_LIMIT,
    );
    assert.equal(
      parseWorkerInboxBatchLimit(
        "OPENMASU_MAX_INBOX_BATCH_LIMIT",
        String(MAX_WORKER_INBOX_BATCH_LIMIT),
      ),
      MAX_WORKER_INBOX_BATCH_LIMIT,
    );
    for (const value of ["0", "1001", "1.5", "NaN", ""]) {
      assert.throws(
        () => parseWorkerInboxBatchLimit("OPENMASU_SDK_INBOX_BATCH_LIMIT", value),
        /OPENMASU_SDK_INBOX_BATCH_LIMIT/,
      );
    }
  });

  it("lets later tenants pass a blocked tenant without exceeding the limit", async () => {
    const releaseFirst = deferred();
    const thirdStarted = deferred();
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const coordinator = new TenantWorkCoordinator({
      concurrency: 2,
      onFailure: (error) => { throw error; },
    });
    const submit = (tenantId: string, blocked = false): void => {
      assert.equal(coordinator.submit(tenantId, async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        events.push(`${tenantId}:start`);
        if (tenantId === "tenant-c") thirdStarted.resolve();
        if (blocked) await releaseFirst.promise;
        events.push(`${tenantId}:end`);
        active -= 1;
      }), true);
    };

    submit("tenant-a", true);
    submit("tenant-b");
    submit("tenant-c");
    await thirdStarted.promise;
    await Promise.resolve();

    assert.deepEqual(events, [
      "tenant-a:start",
      "tenant-b:start",
      "tenant-b:end",
      "tenant-c:start",
      "tenant-c:end",
    ]);
    assert.equal(maximumActive, 2);
    assert.equal(coordinator.active, 1);
    releaseFirst.resolve();
    await coordinator.waitForIdle();
    assert.equal(events.at(-1), "tenant-a:end");
  });

  it("deduplicates a tenant while queued or active and permits a later cycle", async () => {
    const release = deferred();
    const coordinator = new TenantWorkCoordinator({ concurrency: 1, onFailure: () => undefined });
    assert.equal(coordinator.submit("tenant-a", async () => release.promise), true);
    assert.equal(coordinator.submit("tenant-a", async () => undefined), false);
    release.resolve();
    await coordinator.waitForIdle();
    assert.equal(coordinator.submit("tenant-a", async () => undefined), true);
    await coordinator.waitForIdle();
  });

  it("isolates one tenant failure and continues the FIFO queue", async () => {
    const failures: unknown[] = [];
    const completed: string[] = [];
    const coordinator = new TenantWorkCoordinator({
      concurrency: 1,
      onFailure: (error) => failures.push(error),
    });
    coordinator.submit("tenant-a", async () => { throw new Error("synthetic tenant failure"); });
    coordinator.submit("tenant-b", async () => { completed.push("tenant-b"); });
    await coordinator.waitForIdle();
    assert.equal(failures.length, 1);
    assert.deepEqual(completed, ["tenant-b"]);
  });

  it("stops accepting new work while draining tasks already submitted", async () => {
    const release = deferred();
    const coordinator = new TenantWorkCoordinator({ concurrency: 1, onFailure: () => undefined });
    coordinator.submit("tenant-a", async () => release.promise);
    coordinator.submit("tenant-b", async () => undefined);
    coordinator.close();
    assert.equal(coordinator.submit("tenant-c", async () => undefined), false);
    release.resolve();
    await coordinator.waitForIdle();
    assert.equal(coordinator.active, 0);
    assert.equal(coordinator.queued, 0);
  });

  it("reports whether shutdown drained before an explicit deadline", async () => {
    const release = deferred();
    const coordinator = new TenantWorkCoordinator({ concurrency: 1, onFailure: () => undefined });
    coordinator.submit("tenant-a", async () => release.promise);
    coordinator.close();

    const expired = new AbortController();
    const timedOutDrain = waitForWorkerDrain(coordinator, undefined, expired.signal);
    expired.abort();
    assert.equal(await timedOutDrain, false);

    release.resolve();
    assert.equal(await waitForWorkerDrain(coordinator, undefined, new AbortController().signal), true);
  });
});
