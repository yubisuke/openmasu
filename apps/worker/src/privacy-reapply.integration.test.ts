import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { sha256 } from "@openmasu/attribution-core";
import {
  createAppPool,
  createSeedPool,
  EncryptedFilePayloadStore,
  processPrivacyDeletionJobs,
  uuidV7,
  withTenant,
} from "@openmasu/runtime";
import { executePrivacyRequest, privacySubjectDigest } from "../../api/src/privacy.js";
import { encodeMetricReport, metricReport } from "../../api/src/reporting.js";
import { parseMetricQuery } from "../../api/src/report-query.js";
import { ingestFixture } from "./ingestion.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { reapplyCompletedPrivacyRequests } from "./privacy-reapply.js";

type Any = Record<string, any>;
const fixtureName = "33-stage-b-cohort-metrics";
const fixtureDirectory = join(process.cwd(), "fixtures", "v0.4", fixtureName);
const input: Any = JSON.parse(readFileSync(join(fixtureDirectory, "input.json"), "utf8"));

function runPostgresTool(tool: "pg_dump" | "pg_restore", args: readonly string[], dumpPath: string): void {
  if (process.env.OPENMASU_M5_PG_TOOLS !== "docker") {
    execFileSync(tool, [...args], { stdio: "pipe" });
    return;
  }
  const mountedDump = `/backup/${basename(dumpPath)}`;
  execFileSync("docker", [
    "run", "--rm", "--network", "host",
    "--volume", `${dirname(dumpPath)}:/backup`,
    "postgres:17",
    tool,
    ...args.map((argument) => argument === dumpPath ? mountedDump : argument),
  ], { stdio: "pipe" });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function databaseConnectionCount(admin: Client, databaseName: string): Promise<number> {
  const result = await admin.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
    [databaseName],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function waitForDatabaseConnectionsToClose(
  admin: Client,
  databaseName: string,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (await databaseConnectionCount(admin, databaseName) > 0) {
    if (Date.now() >= deadline) throw new Error("restored database connections did not close before removal");
    await delay(50);
  }
}

async function endRestoredPool(pool: Pool, admin: Client, databaseName: string): Promise<void> {
  const ending = pool.end();
  const result = await Promise.race([
    ending.then(() => "closed" as const),
    delay(5_000).then(() => "timeout" as const),
  ]);
  if (result === "timeout") {
    const remaining = await databaseConnectionCount(admin, databaseName);
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
      [databaseName],
    );
    const settledAfterTermination = await Promise.race([
      ending.then(() => true, () => true),
      delay(5_000).then(() => false),
    ]);
    if (!settledAfterTermination) {
      throw new Error("restored pool did not settle after terminating leaked database connections");
    }
    throw new Error(`restored pool shutdown exceeded 5000 ms with ${remaining} database connection(s)`);
  }
  assert.equal(pool.totalCount, 0, "restored pool must close every client before database removal");
  assert.equal(pool.idleCount, 0, "restored pool must not retain idle clients");
  assert.equal(pool.waitingCount, 0, "restored pool must not retain waiting requests");
  await waitForDatabaseConnectionsToClose(admin, databaseName);
}

describe("M5 privacy reapply and deletion reporting", { concurrency: false }, () => {
  let appPool: Pool;
  let seedPool: Pool;
  let root: string;
  let snapshot: string;
  let payloadStore: EncryptedFilePayloadStore;
  let payloadReference: string;
  let integrityEvidenceReference: string;
  let integrityPendingReference: string;
  let privacyRequestId: string;

  before(async () => {
    appPool = createAppPool();
    seedPool = createSeedPool();
    root = mkdtempSync(join(tmpdir(), "openmasu-m5-privacy-live-"));
    snapshot = mkdtempSync(join(tmpdir(), "openmasu-m5-privacy-snapshot-"));
    payloadStore = new EncryptedFilePayloadStore(
      root,
      "synthetic-m5-privacy-master-key-000000000000000",
    );
    await ingestFixture(fixtureName, input, appPool, seedPool);
    const baseline = await computeSqlMetricRuns(appPool, input, true);
    assert.equal(baseline.find((run) => run.metric_name === "cohort_install_count")?.value_unscaled, "1");

    payloadReference = await payloadStore.write(
      { tenantId: "tenant-a", appId: "app-a", objectId: "synthetic-restored-inbox" },
      Buffer.from("synthetic payload only", "utf8"),
    );
    integrityEvidenceReference = await payloadStore.write(
      { tenantId: "tenant-a", appId: "app-a", objectId: "synthetic-restored-integrity-result" },
      Buffer.from("synthetic integrity evidence only", "utf8"),
    );
    integrityPendingReference = await payloadStore.write(
      { tenantId: "tenant-a", appId: "app-a", objectId: "synthetic-restored-integrity-token" },
      Buffer.from("synthetic integrity pending token only", "utf8"),
    );
    await withTenant(appPool, "tenant-a", async (client) => {
      await client.query(
        `INSERT INTO ledger.ingest_inbox (
          inbox_id, tenant_id, app_id, producer, event_id, token_mode,
          received_at, raw_query_ref, raw_query_digest, artifact
        ) VALUES ($1,'tenant-a','app-a','import:synthetic-provider','event:install-33','all',
          '2026-08-01T00:00:01.000Z',$2,$3,$4::jsonb)`,
        [uuidV7(), payloadReference, sha256("synthetic payload only"), JSON.stringify({ synthetic: true })],
      );
      const recordId = (await client.query<{ record_id: string }>(
        `SELECT record_id FROM ledger.raw_records
          WHERE tenant_id='tenant-a' AND app_id='app-a' AND event_id='event:install-33'`,
      )).rows[0].record_id;
      const resultId = uuidV7();
      const resultDigest = sha256("synthetic restored integrity result binding");
      await client.query(
        `INSERT INTO ledger.integrity_verification_results (
          verification_result_id,tenant_id,app_id,subject_record_id,provider,
          verdict,evidence_ref,response_digest,binding_digest,decided_at,artifact
        ) VALUES ($1,'tenant-a','app-a',$2,'play_integrity','verified',$3,$4,$5,
          '2026-08-19T00:00:00.000Z',$6::jsonb)`,
        [resultId, recordId, integrityEvidenceReference, sha256("synthetic integrity evidence only"),
          resultDigest, JSON.stringify({ verification_result_id: resultId, synthetic: true })],
      );
      await client.query(
        `INSERT INTO ephemeral.integrity_verifications (
          verification_id,tenant_id,app_id,provider,token_ref,subject_record_id,
          attempts,next_attempt_at,challenge_digest
        ) VALUES ($1,'tenant-a','app-a','play_integrity',$2,$3,0,
          '2026-08-19T00:00:00.000Z',$4)`,
        [uuidV7(), integrityPendingReference, recordId,
          sha256("synthetic restored integrity pending binding")],
      );
    });
    cpSync(root, join(snapshot, "payloads"), { recursive: true });

    const privacy = await executePrivacyRequest(
      appPool,
      {
        keyId: "key:synthetic-m5", tenantId: "tenant-a", appId: "app-a", role: "admin",
        deletionSubjectDigest: privacySubjectDigest("synthetic-private-digest-key", {
          tenant_id: "tenant-a", app_id: "app-a", deletion_scope: "app", deletion_subject_ref: "app-a",
        }),
      },
      {
        tenant_id: "tenant-a",
        app_id: "app-a",
        requested_via: "tenant_admin_api",
        deletion_scope: "app",
        deletion_subject_ref: "app-a",
      },
      payloadStore,
      new Date("2026-08-20T02:00:00.000Z"),
    );
    privacyRequestId = privacy.privacy_request_id;
    await assert.rejects(payloadStore.read(payloadReference));
    await assert.rejects(payloadStore.read(integrityEvidenceReference));
    await assert.rejects(payloadStore.read(integrityPendingReference));

    // Simulate an object-store snapshot restored after the database already recorded deletion.
    cpSync(join(snapshot, "payloads"), root, { recursive: true, force: true });
    assert.equal((await payloadStore.read(payloadReference)).toString("utf8"), "synthetic payload only");
    assert.equal((await payloadStore.read(integrityEvidenceReference)).toString("utf8"),
      "synthetic integrity evidence only");
    assert.equal((await payloadStore.read(integrityPendingReference)).toString("utf8"),
      "synthetic integrity pending token only");
    const restoredRecordId = await withTenant(appPool, "tenant-a", async (client) => (await client.query<{
      record_id: string;
    }>(
      `SELECT record_id FROM ledger.raw_records
        WHERE tenant_id='tenant-a' AND app_id='app-a' AND event_id='event:install-33'`,
    )).rows[0].record_id);
    await withTenant(appPool, "tenant-a", (client) => client.query(
      `INSERT INTO ephemeral.integrity_verifications (
        verification_id,tenant_id,app_id,provider,token_ref,subject_record_id,
        attempts,next_attempt_at,challenge_digest
      ) VALUES ($1,'tenant-a','app-a','play_integrity',$2,$3,0,
        '2026-08-19T00:00:00.000Z',$4)`,
      [uuidV7(), integrityPendingReference, restoredRecordId,
        sha256("synthetic restored integrity replay binding")],
    ));
  });

  after(async () => {
    await appPool?.end();
    await seedPool?.end();
    if (root) rmSync(root, { recursive: true, force: true });
    if (snapshot) rmSync(snapshot, { recursive: true, force: true });
  });

  it("purges restored payloads, recalculates metrics, and is idempotent", async () => {
    const first = await reapplyCompletedPrivacyRequests({
      pool: appPool,
      payloadStore,
      tenantId: "tenant-a",
    });
    assert.equal(first.privacy_requests, 1);
    assert.ok(first.payloads_purged >= 1);
    assert.equal(first.metrics_recalculated, 8);
    assert.equal(first.unsupported_metric_runs, 0);
    await assert.rejects(payloadStore.read(payloadReference));
    await assert.rejects(payloadStore.read(integrityEvidenceReference));
    await assert.rejects(payloadStore.read(integrityPendingReference));
    assert.equal(await withTenant(appPool, "tenant-a", async (client) => Number((await client.query<{
      count: string;
    }>(
      "SELECT count(*)::text AS count FROM ephemeral.integrity_verifications WHERE tenant_id=$1 AND app_id=$2",
      ["tenant-a", "app-a"],
    )).rows[0].count)), 0);

    const beforeSecond = await withTenant(appPool, "tenant-a", async (client) => ({
      metrics: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.metric_runs WHERE metric_run_id LIKE 'privacy-reapply:%'",
      )).rows[0].count),
      audits: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.audit_logs WHERE action='privacy_reapply' AND target_ref=$1",
        [privacyRequestId],
      )).rows[0].count),
    }));
    const second = await reapplyCompletedPrivacyRequests({
      pool: appPool,
      payloadStore,
      tenantId: "tenant-a",
    });
    assert.equal(second.metrics_recalculated, first.metrics_recalculated);
    const afterSecond = await withTenant(appPool, "tenant-a", async (client) => ({
      metrics: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.metric_runs WHERE metric_run_id LIKE 'privacy-reapply:%'",
      )).rows[0].count),
      audits: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.audit_logs WHERE action='privacy_reapply' AND target_ref=$1",
        [privacyRequestId],
      )).rows[0].count),
    }));
    assert.deepEqual(afterSecond, beforeSecond);
  });

  it("restores a pg_dump and reapplies completed privacy requests before serving data", {
    skip: process.env.OPENMASU_M5_BACKUP_RESTORE !== "1",
  }, async () => {
    const migrationUrl = process.env.OPENMASU_MIGRATION_DATABASE_URL;
    const appUrl = process.env.OPENMASU_APP_DATABASE_URL;
    assert.ok(migrationUrl && appUrl);
    const databaseName = `openmasu_restore_${Date.now()}`;
    const dumpPath = join(snapshot, `${databaseName}.dump`);
    const restoredPayloadRoot = mkdtempSync(join(tmpdir(), "openmasu-m5-restored-payload-"));
    cpSync(join(snapshot, "payloads"), restoredPayloadRoot, { recursive: true, force: true });
    const processingRequestId = `privacy:${uuidV7()}`;
    const processingRequestedAt = "2026-08-20T02:05:00.000Z";
    const processingReference = await payloadStore.write(
      { tenantId: "tenant-a", appId: "app-a", objectId: "synthetic-processing-restore" },
      Buffer.from("synthetic processing payload only", "utf8"),
    );
    await withTenant(appPool, "tenant-a", async (client) => {
      const template = {
        contract_version: "0.4.0",
        tenant_id: "tenant-a",
        app_id: "app-a",
        privacy_request_id: processingRequestId,
        deletion_subject_digest: sha256("synthetic-processing-subject"),
        deletion_scope: "app",
        requested_via: "tenant_admin_api",
        requester_auth_ref: "admin_key:synthetic-restore",
        requested_at: processingRequestedAt,
        reason_code: "privacy_deletion",
        policy_version: "privacy-v0.3",
        affected_records: [],
      };
      await client.query(
        `INSERT INTO control.privacy_deletion_jobs (
          privacy_request_id,tenant_id,app_id,status,requested_at,artifact_template,
          actor_type,actor_ref,request_digest,updated_at
        ) VALUES ($1,'tenant-a','app-a','processing',$2,$3::jsonb,'admin_key',
          'admin_key:synthetic-restore',$4,$2)`,
        [processingRequestId, processingRequestedAt, JSON.stringify(template), sha256(template)],
      );
      await client.query(
        `INSERT INTO control.privacy_payload_purges (
          privacy_request_id,tenant_id,app_id,reference_digest,payload_ref,status,updated_at
        ) VALUES ($1,'tenant-a','app-a',$2,$3,'queued',$4)`,
        [processingRequestId, sha256(processingReference), processingReference, processingRequestedAt],
      );
    });
    cpSync(root, restoredPayloadRoot, { recursive: true, force: true });
    const admin = new Client({ connectionString: migrationUrl });
    await admin.connect();
    let restoredPool: Pool | undefined;
    const restoredPoolErrors: Error[] = [];
    let testError: unknown;
    try {
      runPostgresTool("pg_dump", ["--format=custom", "--no-owner", "--file", dumpPath, migrationUrl], dumpPath);
      const liveDrain = await processPrivacyDeletionJobs({
        pool: appPool,
        payloadStore,
        tenantId: "tenant-a",
      });
      assert.equal(liveDrain.completed, 1);
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const restoredAdminUrl = new URL(migrationUrl);
      restoredAdminUrl.pathname = `/${databaseName}`;
      runPostgresTool("pg_restore", [
        "--exit-on-error", "--no-owner", "--dbname", restoredAdminUrl.toString(), dumpPath,
      ], dumpPath);

      const restoredAppUrl = new URL(appUrl);
      restoredAppUrl.pathname = `/${databaseName}`;
      restoredPool = new Pool({ connectionString: restoredAppUrl.toString() });
      restoredPool.on("error", (error) => {
        restoredPoolErrors.push(error);
      });
      const restoredPayloadStore = new EncryptedFilePayloadStore(
        restoredPayloadRoot,
        "synthetic-m5-privacy-master-key-000000000000000",
      );
      assert.equal((await restoredPayloadStore.read(payloadReference)).toString("utf8"), "synthetic payload only");
      assert.equal((await restoredPayloadStore.read(processingReference)).toString("utf8"), "synthetic processing payload only");
      const drained = await processPrivacyDeletionJobs({
        pool: restoredPool,
        payloadStore: restoredPayloadStore,
        tenantId: "tenant-a",
      });
      assert.equal(drained.completed, 1);
      await assert.rejects(restoredPayloadStore.read(processingReference));
      const result = await reapplyCompletedPrivacyRequests({
        pool: restoredPool,
        payloadStore: restoredPayloadStore,
        tenantId: "tenant-a",
      });
      assert.equal(result.privacy_requests, 2);
      assert.equal(result.metrics_recalculated, 8);
      await assert.rejects(restoredPayloadStore.read(payloadReference));
      const auditCount = await withTenant(restoredPool, "tenant-a", async (client) => Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.audit_logs WHERE action='privacy_reapply' AND target_ref=$1",
        [privacyRequestId],
      )).rows[0].count));
      assert.equal(auditCount, 1);
      assert.equal(await withTenant(restoredPool, "tenant-a", async (client) => Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM control.privacy_deletion_jobs WHERE status='processing'",
      )).rows[0].count)), 0);
    } catch (error) {
      testError = error;
    }

    const cleanupErrors: unknown[] = [];
    if (restoredPool) {
      try {
        await endRestoredPool(restoredPool, admin, databaseName);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (restoredPoolErrors.length > 0) {
      cleanupErrors.push(new AggregateError(restoredPoolErrors, "restored pool emitted background errors"));
    }
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await admin.end();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      rmSync(restoredPayloadRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (testError && cleanupErrors.length > 0) {
      throw new AggregateError(
        [testError, ...cleanupErrors],
        "backup/restore verification and cleanup both failed",
      );
    }
    if (testError) throw testError;
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "backup/restore cleanup failed");
  });

  it("exports only the recalculated latest metric and never exposes redacted evidence", async () => {
    const parsed = parseMetricQuery({
      tenantId: "tenant-a",
      appId: "app-a",
      searchParams: new URLSearchParams({ metric_name: "cohort_install_count", limit: "20" }),
    });
    const identity = { keyId: "key:synthetic-m5", tenantId: "tenant-a", appId: "app-a", role: "admin" } as const;
    const page = await metricReport(appPool, identity, parsed.query);
    assert.equal(page.data.length, 1);
    assert.equal(page.data[0].value_unscaled, "0");
    assert.equal(page.data[0].reproducibility_status, "redaction_affected");
    assert.match(String(page.data[0].metric_run_id), /^privacy-reapply:/);

    const json = encodeMetricReport(page, "json").body;
    const csv = encodeMetricReport(page, "csv").body;
    for (const body of [json, csv]) {
      assert.equal(body.includes("installation:install-33"), false);
      assert.equal(body.includes("record_id"), false);
      assert.equal(body.includes("evidence_refs"), false);
    }
  });
});
