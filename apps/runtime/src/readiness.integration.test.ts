import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { createAppPool, createMigrationPool, EncryptedFilePayloadStore, withTenant } from "./index.js";
import { createRuntimeReadiness } from "./readiness.js";

it("reader readiness requires current scoped heartbeat and storage without writing business rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmasu-ready-db-"));
  const app = createAppPool(), owner = createMigrationPool();
  const tenantId = "tenant-synthetic-readiness";
  new EncryptedFilePayloadStore(root, "synthetic-readiness-master-key-00000000");
  const check = async (tenant = tenantId, path = root) => {
    const probe = createRuntimeReadiness({ databaseUrl: process.env.OPENMASU_READER_DATABASE_URL!, tenantId: tenant, payloadDirectory: path });
    try { return await probe.check(); } finally { await probe.close(); }
  };
  try {
    assert.equal(await check(), false);
    await withTenant(app, tenantId, client => client.query(
      "INSERT INTO control.worker_heartbeats VALUES ($1,clock_timestamp(),clock_timestamp()+interval '1 minute')", [tenantId]));
    const before = (await owner.query("SELECT (SELECT count(*) FROM ledger.raw_records) AS records,(SELECT count(*) FROM ledger.audit_logs) AS audit")).rows;
    assert.equal(await check(), true);
    assert.equal(await check("tenant-synthetic-other"), false);
    assert.equal(await check(tenantId, join(root, "missing")), false);
    await withTenant(app, tenantId, client => client.query(
      "UPDATE control.worker_heartbeats SET observed_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE tenant_id=$1", [tenantId]));
    assert.equal(await check(), false);
    assert.deepEqual((await owner.query("SELECT (SELECT count(*) FROM ledger.raw_records) AS records,(SELECT count(*) FROM ledger.audit_logs) AS audit")).rows, before);
  } finally {
    await owner.query("DELETE FROM control.worker_heartbeats WHERE tenant_id=$1", [tenantId]);
    await Promise.all([app.end(), owner.end()]); await rm(root, { recursive: true });
  }
});
