import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { appendDurableBatch, createAppPool, createMigrationPool, createReaderPool, EncryptedFilePayloadStore,
  InboxCapacityError, withTenant, type InboxAdmissionPolicy, type PayloadStore } from "./index.js";

it("durable inbox enforces concurrent count/byte watermarks, hysteresis, rollback and private global decisions", {
  skip: !process.env.OPENMASU_APP_DATABASE_URL || !process.env.OPENMASU_MIGRATION_DATABASE_URL || !process.env.OPENMASU_READER_DATABASE_URL,
}, async () => {
  const pool = createAppPool(), owner = createMigrationPool(), reader = createReaderPool();
  const root = mkdtempSync(join(tmpdir(), "openmasu-inbox-admission-"));
  const files = new EncryptedFilePayloadStore(root, "synthetic-inbox-admission-master-key");
  const suffix = randomUUID(), tenant = `tenant-capacity-${suffix}`, app = `app-capacity-${suffix}`;
  const foreignTenant = `tenant-capacity-other-${suffix}`;
  const accepted: Array<{ id: string; tenant: string; app: string }> = [];
  const written = new Set<string>();
  const store: PayloadStore = {
    write: async (scope, body) => { const reference = await files.write(scope, body); written.add(reference); return reference; },
    read: (reference) => files.read(reference),
    purge: async (reference) => { await files.purge(reference); written.delete(reference); },
    scanFor: (value) => files.scanFor(value),
  };
  const generous = { appCount: 1000000000, appBytes: Number.MAX_SAFE_INTEGER, globalCount: 1000000000,
    globalBytes: Number.MAX_SAFE_INTEGER, resumePercent: 50, retryAfterSeconds: 7 } satisfies InboxAdmissionPolicy;
  const append = async (policy: InboxAdmissionPolicy, bytes = 10, targetTenant = tenant, targetApp = app) => {
    const id = await appendDurableBatch(pool, store, { tenantId: targetTenant, appId: targetApp,
      producer: "redirector", body: Buffer.alloc(bytes, "x"), eventCount: 1, receivedAt: new Date().toISOString(),
    }, undefined, policy);
    accepted.push({ id, tenant: targetTenant, app: targetApp }); return id;
  };
  const state = async (id: string, status = "processed", reason: string | null = null) => {
    const batch = accepted.find((row) => row.id === id)!;
    await withTenant(pool, batch.tenant, (client) => client.query(
      `INSERT INTO ledger.ingest_batch_states (ingest_batch_id,tenant_id,app_id,status,reason_code,changed_at,artifact)
       VALUES ($1,$2,$3,$4,$5,$6,'{}')`, [id, batch.tenant, batch.app, status, reason, new Date().toISOString()],
    ).then(() => undefined));
  };
  const drain = async () => { for (const batch of accepted) await state(batch.id); };
  const refuse = (operation: Promise<unknown>, reason: string) => assert.rejects(operation,
    (error: unknown) => error instanceof InboxCapacityError && error.reason === reason && error.retryAfterSeconds === 7);
  try {
    // No worker runs during the parallel admission burst.
    const countPolicy = { ...generous, appCount: 3, appBytes: 30 };
    const burst = await Promise.allSettled(Array.from({ length: 12 }, () => append(countPolicy)));
    assert.equal(burst.filter((result) => result.status === "fulfilled").length, 3);
    for (const result of burst.filter((result) => result.status === "rejected")) {
      assert.ok(result.reason instanceof InboxCapacityError && result.reason.reason === "inbox_app_capacity");
    }
    assert.equal(written.size, 3, "rejected bodies must never become payload orphans");
    const usage = await withTenant(pool, tenant, (client) => client.query(
      "SELECT count(*)::integer AS count,sum(body_bytes)::integer AS bytes FROM ledger.ingest_batches WHERE app_id=$1", [app],
    ));
    assert.deepEqual(usage.rows[0], { count: 3, bytes: 30 });
    await state(accepted[0].id, "failed", "synthetic_failure");
    await state(accepted[1].id, "processed", "post_processing_pending");
    await state(accepted[2].id);
    await refuse(append(countPolicy), "inbox_app_capacity"); // two remain > 50% low water
    await state(accepted[0].id);
    await append(countPolicy); // one remains: automatically reopens
    await drain();

    const bytesPolicy = { ...generous, appCount: 20, appBytes: 25 };
    const firstByteIndex = accepted.length;
    const byteBurst = await Promise.allSettled(Array.from({ length: 8 }, () => append(bytesPolicy)));
    assert.equal(byteBurst.filter((result) => result.status === "fulfilled").length, 2);
    await state(accepted[firstByteIndex].id);
    const beforeRefusal = written.size;
    await refuse(append(bytesPolicy, 16), "inbox_app_capacity"); // 10 + 16 exceeds 25
    assert.equal(written.size, beforeRefusal);
    await append(bytesPolicy, 15); // 10 + 15 reaches, but never exceeds, the byte limit
    await drain();

    // Cross-tenant aggregate is observed only through the privileged synthetic
    // harness. Production callers receive a closed decision, never this count.
    const baseline = Number((await owner.query(`SELECT count(*)::text AS count FROM ledger.ingest_batches_current AS batch
      WHERE (status IN ('pending','failed') OR (status='processed' AND reason_code='post_processing_pending'))
      AND NOT EXISTS (SELECT 1 FROM control.privacy_payload_purges AS purge
        WHERE purge.tenant_id=batch.tenant_id AND purge.app_id=batch.app_id AND purge.payload_ref=batch.body_ref AND purge.status='purged')`)).rows[0].count);
    const allowance = Math.ceil(baseline / 99) + 3;
    const globalPolicy = { ...generous, globalCount: baseline + allowance, resumePercent: 99 };
    const globalStart = accepted.length;
    const globalBurst = await Promise.allSettled(Array.from({ length: allowance + 4 }, (_, index) =>
      append(globalPolicy, 10, index % 2 ? foreignTenant : tenant, `${app}-${index % 3}`)));
    assert.equal(globalBurst.filter((result) => result.status === "fulfilled").length, allowance);
    for (const result of globalBurst.filter((result) => result.status === "rejected")) {
      assert.ok(result.reason instanceof InboxCapacityError && result.reason.reason === "inbox_global_capacity");
    }
    for (const batch of accepted.slice(globalStart)) await state(batch.id);
    await append(globalPolicy); // drained below 99% of high water
    await drain();
    const baselineBytes = Number((await owner.query(`SELECT coalesce(sum(batch.body_bytes),0)::text AS bytes
      FROM ledger.ingest_batches AS batch JOIN ledger.ingest_batches_current AS current USING (ingest_batch_id,tenant_id,app_id)
      WHERE (current.status IN ('pending','failed') OR (current.status='processed' AND current.reason_code='post_processing_pending'))
      AND NOT EXISTS (SELECT 1 FROM control.privacy_payload_purges AS purge
        WHERE purge.tenant_id=batch.tenant_id AND purge.app_id=batch.app_id AND purge.payload_ref=batch.body_ref AND purge.status='purged')`)).rows[0].bytes);
    const bodySize = Math.max(10, Math.ceil(baselineBytes / 99));
    const globalBytesPolicy = { ...generous, globalBytes: baselineBytes + bodySize * 2, resumePercent: 99 };
    const globalByteStart = accepted.length;
    const globalByteBurst = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
      append(globalBytesPolicy, bodySize, index % 2 ? foreignTenant : tenant, `${app}-bytes-${index % 2}`)));
    assert.equal(globalByteBurst.filter((result) => result.status === "fulfilled").length, 2);
    for (const result of globalByteBurst.filter((result) => result.status === "rejected")) {
      assert.ok(result.reason instanceof InboxCapacityError && result.reason.reason === "inbox_global_capacity");
    }
    for (const batch of accepted.slice(globalByteStart)) await state(batch.id);
    await append(globalBytesPolicy, bodySize);
    await drain();
    await assert.rejects(withTenant(reader, tenant, (client) => client.query("SELECT * FROM control.inbox_admission_states")), /permission denied/);
    await assert.rejects(withTenant(reader, tenant, (client) => client.query(
      "SELECT control.admit_inbox_batch($1,$2,10,10,100,10,100,80)", [tenant, app],
    )), /permission denied/);
    await assert.rejects(withTenant(pool, tenant, (client) => client.query(
      "SELECT control.admit_inbox_batch($1,$2,10,10,100,10,100,80)", [foreignTenant, app],
    )), /inbox_admission_scope_or_policy_invalid/);
    const foreign = await withTenant(reader, tenant, (client) => client.query(
      "SELECT ingest_batch_id FROM ledger.ingest_batches WHERE tenant_id=$1", [foreignTenant],
    ));
    assert.equal(foreign.rowCount, 0);

    // A pre-upgrade unknown size is not silently treated as zero.
    const legacy = randomUUID(); accepted.push({ id: legacy, tenant, app });
    await withTenant(pool, tenant, async (client) => {
      await client.query(`INSERT INTO ledger.ingest_batches
        (ingest_batch_id,tenant_id,app_id,producer,received_at,body_ref,body_digest,event_count,artifact)
        VALUES ($1,$2,$3,'redirector',$4,'encrypted:synthetic-legacy-capacity',$5,1,'{}')`,
      [legacy, tenant, app, new Date().toISOString(), "a".repeat(64)]);
    });
    await state(legacy, "pending");
    await refuse(append(generous), "inbox_capacity_unknown");
    await state(legacy);
    await append(generous);
    const beforeRollback = written.size;
    await assert.rejects(appendDurableBatch(pool, store, { tenantId: tenant, appId: app, producer: "redirector",
      body: Buffer.from("synthetic"), eventCount: 1, receivedAt: new Date().toISOString(),
    }, async () => { throw new Error("synthetic_after_insert_failure"); }, generous), /synthetic_after_insert_failure/);
    assert.equal(written.size, beforeRollback, "a post-write transaction rollback purges its body");
  } finally {
    try { await drain(); } finally {
      await Promise.all([pool.end(), owner.end(), reader.end()]);
      rmSync(root, { recursive: true, force: true });
    }
  }
});
