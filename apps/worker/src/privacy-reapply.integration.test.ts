import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client, Pool } from "pg";
import { sha256 } from "@open-mmp/attribution-core";
import {
  createAppPool,
  createSeedPool,
  EncryptedFilePayloadStore,
  uuidV7,
  withTenant,
} from "@open-mmp/runtime";
import { executePrivacyRequest } from "../../api/src/privacy.js";
import { encodeMetricReport, metricReport } from "../../api/src/reporting.js";
import { parseMetricQuery } from "../../api/src/report-query.js";
import { ingestFixture } from "./ingestion.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { reapplyCompletedPrivacyRequests } from "./privacy-reapply.js";

type Any = Record<string, any>;
const fixtureName = "33-stage-b-cohort-metrics";
const fixtureDirectory = join(process.cwd(), "fixtures", "v0.3", fixtureName);
const input: Any = JSON.parse(readFileSync(join(fixtureDirectory, "input.json"), "utf8"));

function runPostgresTool(tool: "pg_dump" | "pg_restore", args: readonly string[], dumpPath: string): void {
  if (process.env.OPENMMP_M5_PG_TOOLS !== "docker") {
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

describe("M5 privacy reapply and deletion reporting", { concurrency: false }, () => {
  let appPool: Pool;
  let seedPool: Pool;
  let root: string;
  let snapshot: string;
  let payloadStore: EncryptedFilePayloadStore;
  let payloadReference: string;
  let privacyRequestId: string;

  before(async () => {
    appPool = createAppPool();
    seedPool = createSeedPool();
    root = mkdtempSync(join(tmpdir(), "openmmp-m5-privacy-live-"));
    snapshot = mkdtempSync(join(tmpdir(), "openmmp-m5-privacy-snapshot-"));
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
    await withTenant(appPool, "tenant-a", (client) => client.query(
      `INSERT INTO ledger.ingest_inbox (
        inbox_id, tenant_id, app_id, producer, event_id, token_mode,
        received_at, raw_query_ref, raw_query_digest, artifact
      ) VALUES ($1,'tenant-a','app-a','import:synthetic-provider','event:install-33','all',
        '2026-08-01T00:00:01.000Z',$2,$3,$4::jsonb)`,
      [uuidV7(), payloadReference, sha256("synthetic payload only"), JSON.stringify({ synthetic: true })],
    ));
    cpSync(root, join(snapshot, "payloads"), { recursive: true });

    const privacy = await executePrivacyRequest(
      appPool,
      { keyId: "key:synthetic-m5", tenantId: "tenant-a", appId: "app-a", role: "admin" },
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

    // Simulate an object-store snapshot restored after the database already recorded deletion.
    cpSync(join(snapshot, "payloads"), root, { recursive: true, force: true });
    assert.equal((await payloadStore.read(payloadReference)).toString("utf8"), "synthetic payload only");
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
    skip: process.env.OPENMMP_M5_BACKUP_RESTORE !== "1",
  }, async () => {
    const migrationUrl = process.env.OPENMMP_MIGRATION_DATABASE_URL;
    const appUrl = process.env.OPENMMP_APP_DATABASE_URL;
    assert.ok(migrationUrl && appUrl);
    const databaseName = `openmmp_restore_${Date.now()}`;
    const dumpPath = join(snapshot, `${databaseName}.dump`);
    const restoredPayloadRoot = mkdtempSync(join(tmpdir(), "openmmp-m5-restored-payload-"));
    cpSync(join(snapshot, "payloads"), restoredPayloadRoot, { recursive: true, force: true });
    const admin = new Client({ connectionString: migrationUrl });
    await admin.connect();
    let restoredPool: Pool | undefined;
    try {
      runPostgresTool("pg_dump", ["--format=custom", "--no-owner", "--file", dumpPath, migrationUrl], dumpPath);
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const restoredAdminUrl = new URL(migrationUrl);
      restoredAdminUrl.pathname = `/${databaseName}`;
      runPostgresTool("pg_restore", [
        "--exit-on-error", "--no-owner", "--dbname", restoredAdminUrl.toString(), dumpPath,
      ], dumpPath);

      const restoredAppUrl = new URL(appUrl);
      restoredAppUrl.pathname = `/${databaseName}`;
      restoredPool = new Pool({ connectionString: restoredAppUrl.toString() });
      const restoredPayloadStore = new EncryptedFilePayloadStore(
        restoredPayloadRoot,
        "synthetic-m5-privacy-master-key-000000000000000",
      );
      assert.equal((await restoredPayloadStore.read(payloadReference)).toString("utf8"), "synthetic payload only");
      const result = await reapplyCompletedPrivacyRequests({
        pool: restoredPool,
        payloadStore: restoredPayloadStore,
        tenantId: "tenant-a",
      });
      assert.equal(result.privacy_requests, 1);
      assert.equal(result.metrics_recalculated, 8);
      await assert.rejects(restoredPayloadStore.read(payloadReference));
      const auditCount = await withTenant(restoredPool, "tenant-a", async (client) => Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.audit_logs WHERE action='privacy_reapply' AND target_ref=$1",
        [privacyRequestId],
      )).rows[0].count));
      assert.equal(auditCount, 1);
    } finally {
      await restoredPool?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
      await admin.end();
      rmSync(restoredPayloadRoot, { recursive: true, force: true });
    }
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
