import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { ingestFixture } from "./test-support/fixture-ingestion.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { reapplyCompletedPrivacyRequests } from "./privacy-reapply.js";
import { migrateDatabase, readMigrations } from "../../runtime/src/migration-engine.js";
import { fileDigest, migrationDigest, UPGRADE_SOURCE, upgradePreflight, validateUpgradeBackup, verifyBackupFiles } from "../../runtime/src/upgrade.js";

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
  let googlePlayEvidenceReference: string;
  let googlePlayPendingReference: string;
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
    googlePlayEvidenceReference = await payloadStore.write(
      { tenantId: "tenant-a", appId: "app-a", objectId: "synthetic-restored-google-play-result" },
      Buffer.from("synthetic Google Play evidence only", "utf8"),
    );
    googlePlayPendingReference = await payloadStore.write(
      { tenantId: "tenant-a", appId: "app-a", objectId: "synthetic-restored-google-play-token" },
      Buffer.from("synthetic Google Play pending token only", "utf8"),
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
      const googleResultId = uuidV7();
      const googleVerificationId = uuidV7();
      const googleResultDigest = sha256("synthetic restored Google Play result token");
      await client.query(
        `INSERT INTO ledger.google_play_purchase_verification_results (
          verification_result_id,verification_id,tenant_id,app_id,subject_record_id,
          verified_record_id,token_digest,verdict,provider_purchase_state,
          product_matched,evidence_ref,response_digest,decided_at,artifact,purchase_kind
        ) VALUES ($1,$2,'tenant-a','app-a',$3,NULL,$4,'failed','CANCELED',false,
          $5,$6,'2026-08-19T00:00:00.000Z',$7::jsonb,'one_time_product')`,
        [googleResultId, googleVerificationId, recordId, googleResultDigest,
          googlePlayEvidenceReference, sha256("synthetic Google Play evidence only"),
          JSON.stringify({ verification_result_id: googleResultId, synthetic: true })],
      );
      await client.query(
        `INSERT INTO ephemeral.google_play_product_verifications (
          verification_id,tenant_id,app_id,subject_record_id,token_ref,token_digest,
          product_id,purchase_kind,verified_record_id,attempts,next_attempt_at,requested_at
        ) VALUES ($1,'tenant-a','app-a',$2,$3,$4,'product.synthetic.restore',
          'one_time_product',$5,0,'2026-08-19T00:00:00.000Z','2026-08-19T00:00:00.000Z')`,
        [uuidV7(), recordId, googlePlayPendingReference,
          sha256("synthetic restored Google Play pending token"), `record:google-play:${uuidV7()}`],
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
    await assert.rejects(payloadStore.read(googlePlayEvidenceReference));
    await assert.rejects(payloadStore.read(googlePlayPendingReference));

    // Simulate an object-store snapshot restored after the database already recorded deletion.
    cpSync(join(snapshot, "payloads"), root, { recursive: true, force: true });
    assert.equal((await payloadStore.read(payloadReference)).toString("utf8"), "synthetic payload only");
    assert.equal((await payloadStore.read(integrityEvidenceReference)).toString("utf8"),
      "synthetic integrity evidence only");
    assert.equal((await payloadStore.read(integrityPendingReference)).toString("utf8"),
      "synthetic integrity pending token only");
    assert.equal((await payloadStore.read(googlePlayEvidenceReference)).toString("utf8"),
      "synthetic Google Play evidence only");
    assert.equal((await payloadStore.read(googlePlayPendingReference)).toString("utf8"),
      "synthetic Google Play pending token only");
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
    await withTenant(appPool, "tenant-a", (client) => client.query(
      `INSERT INTO ephemeral.google_play_product_verifications (
        verification_id,tenant_id,app_id,subject_record_id,token_ref,token_digest,
        product_id,purchase_kind,verified_record_id,attempts,next_attempt_at,requested_at
      ) VALUES ($1,'tenant-a','app-a',$2,$3,$4,'product.synthetic.restore-replay',
        'one_time_product',$5,0,'2026-08-19T00:00:00.000Z','2026-08-19T00:00:00.000Z')`,
      [uuidV7(), restoredRecordId, googlePlayPendingReference,
        sha256("synthetic restored Google Play replay token"), `record:google-play:${uuidV7()}`],
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
    await assert.rejects(payloadStore.read(googlePlayEvidenceReference));
    await assert.rejects(payloadStore.read(googlePlayPendingReference));
    assert.equal(await withTenant(appPool, "tenant-a", async (client) => Number((await client.query<{
      count: string;
    }>(
      "SELECT count(*)::text AS count FROM ephemeral.integrity_verifications WHERE tenant_id=$1 AND app_id=$2",
      ["tenant-a", "app-a"],
    )).rows[0].count)), 0);
    assert.equal(await withTenant(appPool, "tenant-a", async (client) => Number((await client.query<{
      count: string;
    }>(
      "SELECT count(*)::text AS count FROM ephemeral.google_play_product_verifications WHERE tenant_id=$1 AND app_id=$2",
      ["tenant-a", "app-a"],
    )).rows[0].count)), 0);

    const beforeSecond = await withTenant(appPool, "tenant-a", async (client) => ({
      metrics: Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.metric_runs WHERE metric_run_id LIKE 'privacy-recalc:%'",
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
        "SELECT count(*)::text AS count FROM ledger.metric_runs WHERE metric_run_id LIKE 'privacy-recalc:%'",
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
    assert.match(String(page.data[0].metric_run_id), /^privacy-recalc:/);

    const json = encodeMetricReport(page, "json").body;
    const csv = encodeMetricReport(page, "csv").body;
    for (const body of [json, csv]) {
      assert.equal(body.includes("installation:install-33"), false);
      assert.equal(body.includes("record_id"), false);
      assert.equal(body.includes("evidence_refs"), false);
    }
  });
});

it("upgrades the frozen v0.2.0 backup, resumes a failed migration, retains ledger and metrics, and reapplies privacy", {
  skip: process.env.OPENMASU_M5_BACKUP_RESTORE !== "1", timeout: 120_000,
}, async () => {
  const migrationUrl = process.env.OPENMASU_MIGRATION_DATABASE_URL;
  const appUrl = process.env.OPENMASU_APP_DATABASE_URL;
  assert.ok(migrationUrl && appUrl);
  const started = performance.now();
  const admin = new Client({ connectionString: migrationUrl });
  await admin.connect();
  const names = [`openmasu_upgrade_source_${Date.now()}`, `openmasu_upgrade_target_${Date.now()}`];
  const root = mkdtempSync(join(tmpdir(), "openmasu-upgrade-"));
  const source = new URL(migrationUrl); source.pathname = `/${names[0]}`;
  const target = new URL(migrationUrl); target.pathname = `/${names[1]}`;
  let sourceClient: Client | undefined;
  let targetClient: Client | undefined;
  let targetPool: Pool | undefined;
  try {
    for (const name of names) {
      await admin.query(`CREATE DATABASE "${name}" OWNER openmasu_owner`);
      await admin.query(`GRANT CONNECT,CREATE ON DATABASE "${name}" TO openmasu_owner`);
    }
    sourceClient = new Client({ connectionString: source.toString() }); await sourceClient.connect();
    const current = readMigrations();
    const frozen = current.slice(0, 48).map((migration) => ({ ...migration,
      source: execFileSync("git", ["show", `${UPGRADE_SOURCE.revision}:db/migrations/${migration.name}`], { encoding: "utf8" }).replaceAll("\r\n", "\n"),
    }));
    assert.equal(migrationDigest(frozen), UPGRADE_SOURCE.migrationDigest);
    for (const migration of frozen) assert.equal(createHash("sha256").update(migration.source).digest("hex"), migration.checksum);
    assert.equal(await migrateDatabase(sourceClient, frozen), 48);
    const payloadStore = new EncryptedFilePayloadStore(join(root, "payloads"), "synthetic-upgrade-master-key-0000000000000000");
    const payloadRef = await payloadStore.write({ tenantId: "tenant-a", appId: "app-delete", objectId: "synthetic-upgrade-inbox" }, Buffer.from("synthetic upgrade evidence"));
    const frozenArtifact = (name: string) => JSON.parse(execFileSync("git", ["show", `${UPGRADE_SOURCE.revision}:fixtures/v0.4/${fixtureName}/${name}`], { encoding: "utf8" }));
    const metric = (frozenArtifact("expected_metric_runs.json") as Any[]).find((run) => run.metric_name === "d7_roas" && run.value_unscaled !== undefined)!;
    assert.ok(metric, "the frozen fixture must contain a present d7 ROAS run");
    const raw = frozenArtifact("expected_raw_records.json")[0] as Any;
    await sourceClient.query("BEGIN");
    await sourceClient.query("SET LOCAL ROLE openmasu_owner");
    await sourceClient.query("SELECT set_config('openmasu.tenant_id','tenant-a',true)");
    await sourceClient.query("INSERT INTO control.apps (tenant_id,app_id,created_at) VALUES ('tenant-a','app-a','2026-08-01T00:00:00.000Z'),('tenant-a','app-delete','2026-08-01T00:00:00.000Z')");
    // Insert only columns present in the frozen release, not today's ingestion code.
    const rawKeys = ["record_id", "tenant_id", "app_id", "producer", "producer_version", "event_id", "delivery_id", "event_name", "schema_version", "payload_sha256", "occurred_at", "occurred_at_source", "received_at", "raw_payload_ref", "processing_purpose_id", "consent_evaluation_policy_version", "consent_decision_reason_code"];
    await sourceClient.query(`INSERT INTO ledger.raw_records (${rawKeys.join(",")},artifact) VALUES (${rawKeys.map((_, index) => `$${index + 1}`).join(",")},$${rawKeys.length + 1}::jsonb)`, [...rawKeys.map((key) => raw[key]), JSON.stringify(raw)]);
    const keys = ["metric_run_id", "metric_name", "metric_definition_version", "input_snapshot_id", "input_received_at_watermark", "input_ledger_position", "computed_at", "data_freshness", "aggregation_time_zone", "rule_bundle_id", "rule_bundle_version", "rule_bundle_hash", "rounding_mode", "reproducibility_status", "value_type", "value_state", "value_unscaled"];
    await sourceClient.query(`INSERT INTO ledger.metric_runs (${keys.join(",")},tenant_id,app_id,grouping,grouping_digest,artifact) VALUES (${keys.map((_, index) => `$${index + 1}`).join(",")},'tenant-a','app-a',$${keys.length + 1}::jsonb,$${keys.length + 2},$${keys.length + 3}::jsonb)`, [...keys.map((key) => key === "value_state" ? metric.value_state ?? "present" : metric[key]), JSON.stringify(metric.grouping.dimensions), metric.grouping.dimension_digest, JSON.stringify(metric)]);
    await sourceClient.query(`INSERT INTO ledger.ingest_inbox (inbox_id,tenant_id,app_id,producer,event_id,token_mode,received_at,raw_query_ref,raw_query_digest,artifact) VALUES ($1,'tenant-a','app-delete','import:synthetic-upgrade','event:upgrade','all','2026-08-01T00:00:00.000Z',$2,$3,'{}'::jsonb)`, [uuidV7(), payloadRef, sha256("synthetic upgrade evidence")]);
    const privacy = { contract_version: "0.4.0", privacy_request_id: "privacy:synthetic-upgrade", tenant_id: "tenant-a", app_id: "app-delete", status: "completed", deletion_scope: "app", deletion_subject_digest: "a".repeat(64), affected_records: [], requested_via: "tenant_admin_api", requester_auth_ref: "admin:synthetic", requested_at: "2026-08-02T00:00:00.000Z", completed_at: "2026-08-02T00:00:01.000Z", reason_code: "privacy_deletion", policy_version: "privacy-v0.4" };
    await sourceClient.query(`INSERT INTO ledger.privacy_requests (privacy_request_id,tenant_id,app_id,requested_at,completed_at,status,artifact) VALUES ($1,'tenant-a','app-delete','2026-08-02T00:00:00.000Z','2026-08-02T00:00:01.000Z','completed',$2::jsonb)`, [privacy.privacy_request_id, JSON.stringify(privacy)]);
    await sourceClient.query("COMMIT");
    const stoppedStarted = performance.now();
    const dumpPath = join(root, "synthetic.dump");
    runPostgresTool("pg_dump", ["--format=custom", "--no-owner", "--file", dumpPath, source.toString()], dumpPath);
    const payloadArchive = join(root, "synthetic-payload.tar");
    execFileSync("tar", ["-cf", payloadArchive, "-C", root, "payloads"], { stdio: "pipe" });
    const restoredRoot = join(root, "restored"); mkdirSync(restoredRoot);
    execFileSync("tar", ["-xf", payloadArchive, "-C", restoredRoot], { stdio: "pipe" });
    const restoredPayloadStore = new EncryptedFilePayloadStore(join(restoredRoot, "payloads"), "synthetic-upgrade-master-key-0000000000000000");
    const backup = validateUpgradeBackup({ format: "openmasu-upgrade-backup-v1", source_tag: "v0.2.0", source_revision: UPGRADE_SOURCE.revision,
      postgres_major: 17, migration_digest: UPGRADE_SOURCE.migrationDigest, database_sha256: await fileDigest(dumpPath), payload_sha256: await fileDigest(payloadArchive),
      payload_snapshot_id: "synthetic:snapshot", master_key_ref: "synthetic:key", privacy_boundary_at: "2026-08-02T00:00:01.000Z" }, "v0.2.0");
    await verifyBackupFiles(backup, dumpPath, payloadArchive);
    await assert.rejects(verifyBackupFiles({ ...backup, payload_sha256: "b".repeat(64) }, dumpPath, payloadArchive), /upgrade_backup_checksum_mismatch/);
    // Restore through the privileged connection while retaining archive ownership.
    // COPY must not run as the FORCE-RLS owner, and later DDL needs its original owner.
    runPostgresTool("pg_restore", ["--exit-on-error", "--dbname", target.toString(), dumpPath], dumpPath);
    targetClient = new Client({ connectionString: target.toString() }); await targetClient.connect();
    assert.equal((await upgradePreflight(targetClient, backup)).pending, current.length - 48);
    await assert.rejects(migrateDatabase(targetClient, current, (migration) => { if (migration.version === "050") throw new Error("synthetic_mid_migration_failure"); }), /synthetic_mid_migration_failure/);
    assert.equal((await targetClient.query("SELECT count(*)::int AS count FROM public.schema_migrations")).rows[0].count, 49);
    assert.equal((await targetClient.query("SELECT has_column_privilege('openmasu_reader','control.google_data_manager_destinations','enabled','SELECT') AS allowed")).rows[0].allowed, false, "failed migration grant rolls back too");
    assert.equal((await upgradePreflight(targetClient, backup)).pending, current.length - 49);
    assert.equal(await migrateDatabase(targetClient), current.length - 49);
    assert.equal(await migrateDatabase(targetClient), 0);
    assert.equal((await upgradePreflight(targetClient, backup)).pending, 0);
    const targetAppUrl = new URL(appUrl); targetAppUrl.pathname = `/${names[1]}`;
    targetPool = new Pool({ connectionString: targetAppUrl.toString() });
    const before = await withTenant(targetPool, "tenant-a", (client) => client.query("SELECT artifact,comparison_context FROM ledger.metric_runs"));
    assert.equal(sha256(before.rows[0].artifact), sha256(metric));
    assert.equal(before.rows[0].comparison_context, null, "legacy meaning is not invented");
    assert.equal(await withTenant(targetPool, "tenant-a", async (client) => (await client.query("SELECT count(*)::int AS count FROM ledger.raw_records")).rows[0].count), 1);
    assert.equal((await restoredPayloadStore.read(payloadRef)).toString(), "synthetic upgrade evidence");
    const result = await reapplyCompletedPrivacyRequests({ pool: targetPool, payloadStore: restoredPayloadStore, tenantId: "tenant-a" });
    assert.equal(result.privacy_requests, 1); assert.equal(result.payloads_purged, 1); assert.equal(result.unsupported_metric_runs, 0);
    await assert.rejects(restoredPayloadStore.read(payloadRef));
    const after = await withTenant(targetPool, "tenant-a", (client) => client.query("SELECT artifact FROM ledger.metric_runs"));
    assert.equal(sha256(after.rows[0].artifact), sha256(metric));
    console.log(JSON.stringify({ upgrade: "v0.2.0_to_candidate", postgres_major: 17, postgres_version: (await targetClient.query("SHOW server_version")).rows[0].server_version,
      platform: process.platform, node: process.version, synthetic: true, elapsed_ms: Math.round(performance.now() - started), stopped_boundary_ms: Math.round(performance.now() - stoppedStarted),
      downtime_scope: "isolated test writers absent; not a production SLO", ledger_preserved: true, metric_preserved: true, privacy_reapplied: true, failed_migration_resumed: true }));
  } finally {
    if (sourceClient) await sourceClient.end();
    if (targetClient) await targetClient.end();
    if (targetPool) await endRestoredPool(targetPool, admin, names[1]);
    for (const name of names) { await waitForDatabaseConnectionsToClose(admin, name); await admin.query(`DROP DATABASE IF EXISTS "${name}"`); }
    await admin.end(); rmSync(root, { recursive: true, force: true });
  }
});
