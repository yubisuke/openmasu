import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { boundedReadiness, createRuntimeReadiness, payloadDirectoryReady } from "./readiness.js";

it("bounds and coalesces unavailable readiness without exposing errors", async () => {
  let calls = 0;
  const check = boundedReadiness(() => { calls++; return new Promise(() => undefined); }, 20);
  const start = Date.now();
  assert.deepEqual(await Promise.all([check(), check(), check()]), [false, false, false]);
  assert.equal(calls, 1);
  assert.ok(Date.now() - start < 1000);
  assert.equal(await boundedReadiness(async () => { throw new Error("private-connection"); })(), false);
});

it("checks existing payload directories without creating or changing objects", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmasu-health-"));
  try {
    await assert.rejects(payloadDirectoryReady(root));
    assert.deepEqual(await readdir(root), []);
    await mkdir(join(root, "objects")); await mkdir(join(root, "keys"));
    assert.equal(await payloadDirectoryReady(root), true);
    assert.deepEqual(await readdir(join(root, "objects")), []);
    assert.deepEqual(await readdir(join(root, "keys")), []);
  } finally { await rm(root, { recursive: true }); }
});

it("fails closed within the deadline when the database cannot connect", async () => {
  const probe = createRuntimeReadiness({ databaseUrl: "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
    tenantId: "tenant-synthetic", payloadDirectory: "unused" });
  try {
    const start = Date.now(); assert.equal(await probe.check(), false);
    assert.ok(Date.now() - start < 2000);
  } finally { await probe.close(); }
});
