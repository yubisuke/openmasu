import assert from "node:assert/strict";
import { createHash, scryptSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Pool } from "pg";
import { NON_FRAUD_RULE_BUNDLES, nonFraudBundleHash } from "@openmasu/contracts";
import { DEFAULT_FRAUD_BUNDLE, fraudBundleHash, sha256Jcs } from "@openmasu/fraud-rules";
import {
  createAppPool,
  createMigrationPool,
  createReaderPool,
  createSeedPool,
  EncryptedFilePayloadStore,
  recordJobOutcome,
  uuidV7,
  withTenant,
} from "@openmasu/runtime";
import { ensureAdminKeys, issueAdminKey, retireAdminKey, verifyAdminKey, type AppAdminIdentity } from "./admin-auth.js";
import { createRequestHandler } from "./router.js";
import { OperationalMetrics, renderOperationalMetrics } from "./operational-metrics.js";
import { activateRuleBundle } from "./rule-bundles.js";
import { issueDashboardSession, verifyDashboardSession } from "./session.js";
import { resolveNonFraudBundle } from "../../worker/src/non-fraud-bundle-runtime.js";
import { ingestFixture } from "../../worker/src/test-support/fixture-ingestion.js";
import { computeSqlMetricRuns } from "../../worker/src/metrics/cohort.js";

const suffix = `${Date.now()}`;
const tenantId = `tenant-m5-${suffix}`;
const appId = `app-m5-${suffix}`;
const keys = {
  admin: `synthetic-m5-admin-${suffix}-${"a".repeat(32)}`,
  operator: `synthetic-m5-operator-${suffix}-${"o".repeat(32)}`,
  read_only: `synthetic-m5-reader-${suffix}-${"r".repeat(32)}`,
} as const;

describe("M5 RBAC and rule-bundle production controls", { concurrency: false }, () => {
  let appPool: Pool;
  let migrationPool: Pool;
  let readerPool: Pool;
  let server: Server;
  let baseUrl: string;
  let payloadRoot: string;
  let payloadStore: EncryptedFilePayloadStore;
  let identities: Record<keyof typeof keys, AppAdminIdentity>;
  const operationalMetrics = new OperationalMetrics();

  before(async () => {
    appPool = createAppPool();
    migrationPool = createMigrationPool();
    readerPool = createReaderPool();
    payloadRoot = mkdtempSync(join(tmpdir(), "openmasu-m5-controls-"));
    payloadStore = new EncryptedFilePayloadStore(
      payloadRoot,
      "synthetic-m5-master-key-00000000000000000000000",
    );
    await ensureAdminKeys(appPool, { tenantId, appId }, [
      { key: keys.admin, role: "admin" },
      { key: keys.operator, role: "operator" },
      { key: keys.read_only, role: "read_only" },
    ]);
    const resolved = await Promise.all((Object.keys(keys) as (keyof typeof keys)[]).map(async (role) => {
      const identity = await verifyAdminKey(appPool, tenantId, `Bearer ${keys[role]}`);
      assert.ok(identity);
      assert.equal(identity.role, role);
      return [role, { ...identity, appId }] as const;
    }));
    identities = Object.fromEntries(resolved) as Record<keyof typeof keys, AppAdminIdentity>;

    server = createServer(createRequestHandler({
      pool: appPool,
      readerPool,
      payloadStore,
      maxConfig: {
        tenantId,
        appId,
        pathSecret: "synthetic-m5-max-path",
        eventKey: "synthetic-m5-max-event-key",
        tokenMode: "all",
        maxParameters: 40,
        maxQueryBytes: 8192,
      },
      publicBaseUrl: "http://localhost:8080",
      redirectorBaseUrl: "http://localhost:8090",
      dashboard: {
        enabled: true,
        publicBaseUrl: "http://localhost:8080",
        tenantId,
        sessionTtlSeconds: 43200,
      },
      operationalMetrics,
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await appPool?.end();
    await migrationPool?.end();
    await readerPool?.end();
    if (payloadRoot) rmSync(payloadRoot, { recursive: true, force: true });
  });

  async function request(role: keyof typeof keys, path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${keys[role]}`, ...init.headers },
    });
  }

  it("allows every role to read and restricts operate/administer capabilities", async () => {
    for (const role of Object.keys(keys) as (keyof typeof keys)[]) {
      assert.equal((await request(role, "/v1/admin/apps")).status, 200);
      assert.equal((await request(role, `/v1/admin/apps/${appId}/operator-delivery-health`)).status, 200);
      assert.equal((await request(role, `/v1/admin/apps/${appId}/measurement-health`)).status, 200);
      assert.equal((await request(role, `/v1/admin/apps/${appId}/metrics/missing-synthetic-run/explanation`)).status, 404);
    }
    assert.equal((await request("read_only", "/metrics")).status, 200);

    assert.equal((await request("admin", "/v1/admin/apps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: "!" }),
    })).status, 400);
    assert.equal((await request("operator", "/v1/admin/apps", { method: "POST" })).status, 403);
    assert.equal((await request("read_only", "/v1/admin/apps", { method: "POST" })).status, 403);

    const invalidTrackingLink = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId }),
    } satisfies RequestInit;
    assert.equal((await request("admin", "/v1/admin/tracking-links", invalidTrackingLink)).status, 400);
    assert.equal((await request("operator", "/v1/admin/tracking-links", invalidTrackingLink)).status, 400);
    assert.equal((await request("read_only", "/v1/admin/tracking-links", { method: "POST" })).status, 403);

    assert.equal((await request("admin", `/v1/admin/apps/${appId}/sdk-keys`)).status, 200);
    assert.equal((await request("operator", `/v1/admin/apps/${appId}/sdk-keys`)).status, 403);
    assert.equal((await request("read_only", `/v1/admin/apps/${appId}/sdk-keys`)).status, 403);
    assert.equal((await request("operator", `/v1/admin/apps/${appId}/tracking-links/missing/pause`, {
      method: "POST",
    })).status, 404);
    assert.equal((await request("read_only", `/v1/admin/apps/${appId}/tracking-links/missing/pause`, {
      method: "POST",
    })).status, 403);
  });

  it("invalidates dashboard sessions when the backing role key is retired", async () => {
    const session = await issueDashboardSession(
      appPool,
      tenantId,
      identities.read_only.keyId,
      3600,
      new Date("2026-08-20T00:00:00.000Z"),
    );
    const cookie = `openmasu_dashboard=${session.token}`;
    assert.equal((await verifyDashboardSession(
      readerPool,
      tenantId,
      cookie,
      "http://localhost:8080",
      new Date("2026-08-20T00:01:00.000Z"),
    ))?.role, "read_only");

    await withTenant(appPool, tenantId, (client) => client.query(
      `INSERT INTO control.admin_key_states (
        key_id, tenant_id, app_id, status, changed_at, artifact
      ) VALUES ($1,$2,NULL,'retired',$3,$4::jsonb)`,
      [
        identities.read_only.keyId,
        tenantId,
        "2026-08-20T00:02:00.000Z",
        JSON.stringify({ key_id: identities.read_only.keyId, status: "retired" }),
      ],
    ));
    assert.equal(await verifyAdminKey(appPool, tenantId, `Bearer ${keys.read_only}`), undefined);
    assert.equal(await verifyDashboardSession(
      readerPool,
      tenantId,
      cookie,
      "http://localhost:8080",
      new Date("2026-08-20T00:03:00.000Z"),
    ), undefined);
  });

  it("serves identifier-free Prometheus metrics only to authenticated readers", async () => {
    const completions = [
      { job: "mmp_import", outcome: "succeeded", now: new Date("2026-08-20T00:00:00.000Z") },
      { job: "mmp_import", outcome: "succeeded", now: new Date("2026-08-20T00:01:00.000Z") },
      { job: "cost_import", outcome: "failed", now: new Date("2026-08-20T00:02:00.000Z") },
    ] as const;
    for (const completion of completions) {
      await recordJobOutcome({ pool: appPool, tenantId, appId, ...completion });
    }

    const otherTenantId = `tenant-m5-other-${suffix}`;
    const otherAppId = `app-m5-other-${suffix}`;
    await withTenant(appPool, otherTenantId, (client) => client.query(
      "INSERT INTO control.apps (tenant_id, app_id, created_at) VALUES ($1,$2,$3)",
      [otherTenantId, otherAppId, "2026-08-20T00:00:00.000Z"],
    ).then(() => undefined));
    await recordJobOutcome({
      pool: appPool,
      tenantId: otherTenantId,
      appId: otherAppId,
      job: "metric_run",
      outcome: "succeeded",
      now: new Date("2026-08-20T00:03:00.000Z"),
    });

    const auditAcl = await migrationPool.query<{
      rls_enabled: boolean;
      rls_forced: boolean;
      reader_select: boolean;
      reader_insert: boolean;
      other_rows: number;
    }>(`
      SELECT table_class.relrowsecurity AS rls_enabled,
             table_class.relforcerowsecurity AS rls_forced,
             has_table_privilege('openmasu_reader', 'ledger.audit_logs', 'SELECT') AS reader_select,
             has_table_privilege('openmasu_reader', 'ledger.audit_logs', 'INSERT') AS reader_insert,
             (SELECT count(*)::int FROM ledger.audit_logs
               WHERE tenant_id=$1 AND actor_ref='job:metric_run') AS other_rows
        FROM pg_class AS table_class
        JOIN pg_namespace AS namespace ON namespace.oid=table_class.relnamespace
       WHERE namespace.nspname='ledger' AND table_class.relname='audit_logs'`,
    [otherTenantId]);
    assert.deepEqual(auditAcl.rows[0], {
      rls_enabled: true,
      rls_forced: true,
      reader_select: true,
      reader_insert: false,
      other_rows: 1,
    });
    const readerClient = await readerPool.connect();
    try {
      const unset = await readerClient.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM ledger.audit_logs",
      );
      assert.equal(unset.rows[0].count, 0);
      await readerClient.query("BEGIN");
      try {
        await readerClient.query("SELECT set_config('openmasu.tenant_id', $1, true)", [tenantId]);
        const crossTenant = await readerClient.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM ledger.audit_logs WHERE tenant_id=$1",
          [otherTenantId],
        );
        assert.equal(crossTenant.rows[0].count, 0);
      } finally {
        await readerClient.query("ROLLBACK");
      }
    } finally {
      readerClient.release();
    }

    const secretMarker = "synthetic-job-secret-do-not-export";
    const insertMalformed = async (options: {
      actorRef: string;
      action?: string;
      targetRef?: string;
      policyVersion?: string;
      outcome?: "succeeded" | "failed";
      reasonCode?: string | null;
      now: Date;
    }): Promise<void> => withTenant(appPool, tenantId, (client) => client.query(
      `INSERT INTO ledger.audit_logs (
         audit_log_id, tenant_id, app_id, occurred_at, actor_type, actor_ref,
         action, target_scope, target_ref, policy_version, request_digest,
         outcome, reason_code
       ) VALUES ($1,$2,$3,$4,'system_job',$5,$6,'app',$7,$8,$9,$10,$11)`,
      [
        uuidV7(options.now.valueOf()), tenantId, appId, options.now.toISOString(), options.actorRef,
        options.action ?? "job_completed", options.targetRef ?? appId,
        options.policyVersion ?? "job-health-v1", "f".repeat(64),
        options.outcome ?? "succeeded", options.reasonCode ?? null,
      ],
    ).then(() => undefined));
    await insertMalformed({
      actorRef: `job:${secretMarker}`,
      now: new Date("2026-08-20T00:04:00.000Z"),
    });
    await insertMalformed({
      actorRef: "job:metric_run",
      action: `${secretMarker}_completed`,
      now: new Date("2026-08-20T00:05:00.000Z"),
    });
    await insertMalformed({
      actorRef: "job:metric_run",
      policyVersion: `${secretMarker}-policy`,
      now: new Date("2026-08-20T00:06:00.000Z"),
    });
    await insertMalformed({
      actorRef: "job:metric_run",
      targetRef: secretMarker,
      now: new Date("2026-08-20T00:07:00.000Z"),
    });
    await insertMalformed({
      actorRef: "job:metric_run",
      reasonCode: "job_failed",
      now: new Date("2026-08-20T00:08:00.000Z"),
    });

    assert.equal((await fetch(`${baseUrl}/metrics`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: `Bearer synthetic-invalid-${"x".repeat(32)}` },
    })).status, 401);
    const response = await request("admin", "/metrics");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain; version=0\.0\.4/);
    const body = await response.text();
    assert.match(body, /openmasu_http_requests_total/);
    assert.match(body, /openmasu_ingest_backlog\{queue="sdk_batches"\}/);
    assert.match(body, /openmasu_ingest_backlog\{queue="operator_webhooks"\}/);
    assert.match(body, /openmasu_ingest_oldest_pending_seconds\{queue="operator_webhooks"\}/);
    assert.match(body, /openmasu_ingest_backlog\{queue="operator_bulk_exports"\}/);
    assert.match(body, /openmasu_ingest_backlog\{queue="privacy_purges"\}/);
    assert.match(body, /openmasu_ingest_oldest_pending_seconds\{queue="operator_bulk_exports"\}/);
    assert.match(body, /openmasu_scheduled_job_runs_total\{job="sdk_inbox",outcome="failed"\} 0/);
    assert.match(body, /openmasu_scheduled_job_consecutive_failures\{job="sdk_inbox"\} 0/);
    assert.match(body, /openmasu_scheduled_job_configured\{job="sdk_inbox"\} 0/);
    const values = (metric: string): Record<string, string> => Object.fromEntries(
      body.split("\n")
        .filter((line) => line.startsWith(`${metric}{`))
        .map((line) => {
          const match = /^\w+\{job="([^"]+)",outcome="([^"]+)"\} (.+)$/.exec(line);
          assert.ok(match);
          return [`${match[1]}:${match[2]}`, match[3]];
        }),
    );
    assert.deepEqual(values("openmasu_job_runs_total"), {
      "mmp_import:succeeded": "2",
      "mmp_import:failed": "0",
      "cost_import:succeeded": "0",
      "cost_import:failed": "1",
      "max_revenue_import:succeeded": "0",
      "max_revenue_import:failed": "0",
      "google_conversion_delivery:succeeded": "0",
      "google_conversion_delivery:failed": "0",
      "operator_webhook_delivery:succeeded": "0",
      "operator_webhook_delivery:failed": "0",
      "operator_bulk_export:succeeded": "0",
      "operator_bulk_export:failed": "0",
      "metric_run:succeeded": "0",
      "metric_run:failed": "0",
    });
    const latest = values("openmasu_job_last_completion_timestamp_seconds");
    assert.equal(Object.keys(latest).length, 14);
    assert.equal(Number(latest["mmp_import:succeeded"]), Date.parse("2026-08-20T00:01:00.000Z") / 1000);
    assert.equal(Number(latest["cost_import:failed"]), Date.parse("2026-08-20T00:02:00.000Z") / 1000);
    for (const key of [
      "mmp_import:failed", "cost_import:succeeded", "max_revenue_import:succeeded",
      "max_revenue_import:failed", "google_conversion_delivery:succeeded",
      "google_conversion_delivery:failed", "operator_webhook_delivery:succeeded",
      "operator_webhook_delivery:failed", "operator_bulk_export:succeeded",
      "operator_bulk_export:failed", "metric_run:succeeded", "metric_run:failed",
    ]) {
      assert.equal(latest[key], "0");
    }
    for (const forbidden of [
      "tenant_id", "app_id", "installation_id", "record_id", "payload",
      "authorization", "cookie", tenantId, appId, otherTenantId, otherAppId, secretMarker,
    ]) {
      assert.equal(body.includes(forbidden), false);
    }

    const audit = await withTenant(appPool, tenantId, (client) => client.query<{
      actor_ref: string; outcome: string; occurred_at: string; request_digest: string; row_text: string;
    }>(
      `SELECT actor_ref, outcome, occurred_at, request_digest, row_to_json(audit_logs)::text AS row_text
         FROM ledger.audit_logs
        WHERE action='job_completed' AND policy_version='job-health-v1'
          AND actor_ref IN (
            'job:mmp_import','job:cost_import','job:max_revenue_import',
            'job:google_conversion_delivery','job:operator_webhook_delivery',
            'job:operator_bulk_export','job:metric_run'
          )
          AND app_id=target_ref
          AND ((outcome='succeeded' AND reason_code IS NULL)
            OR (outcome='failed' AND reason_code='job_failed'))
        ORDER BY occurred_at`,
    ));
    assert.equal(audit.rows.length, 3);
    for (const row of audit.rows) {
      const job = row.actor_ref.slice("job:".length);
      const expectedDigest = createHash("sha256")
        .update(`${job}\u0000${row.outcome}\u0000${tenantId}\u0000${appId}\u0000${row.occurred_at}`, "utf8")
        .digest("hex");
      assert.equal(row.request_digest, expectedDigest);
      assert.equal(row.row_text.includes(secretMarker), false);
    }

    const afterRestart = await renderOperationalMetrics(readerPool, tenantId, new OperationalMetrics());
    assert.deepEqual(values("openmasu_job_runs_total"), Object.fromEntries(
      afterRestart.split("\n")
        .filter((line) => line.startsWith("openmasu_job_runs_total{"))
        .map((line) => {
          const match = /^\w+\{job="([^"]+)",outcome="([^"]+)"\} (.+)$/.exec(line);
          assert.ok(match);
          return [`${match[1]}:${match[2]}`, match[3]];
        }),
    ));
  });

  it("keeps rule-bundle versions append-only with one current successor and audit history", async () => {
    const first = await activateRuleBundle({
      pool: appPool,
      identity: identities.admin,
      body: {
        rule_bundle_id: "synthetic-history",
        rule_bundle_version: "1.0.0",
        rule_bundle_hash: "1".repeat(64),
      },
      now: new Date("2026-08-20T01:00:00.000Z"),
    });
    const second = await activateRuleBundle({
      pool: appPool,
      identity: identities.admin,
      body: {
        rule_bundle_id: "synthetic-history",
        rule_bundle_version: "1.1.0",
        rule_bundle_hash: "2".repeat(64),
        supersedes_rule_bundle_revision_id: first.rule_bundle_revision_id,
      },
      now: new Date("2026-08-20T01:01:00.000Z"),
    });
    await assert.rejects(() => activateRuleBundle({
      pool: appPool,
      identity: identities.admin,
      body: {
        rule_bundle_id: "synthetic-history",
        rule_bundle_version: "1.2.0",
        rule_bundle_hash: "3".repeat(64),
        supersedes_rule_bundle_revision_id: first.rule_bundle_revision_id,
      },
    }), /rule_bundle_predecessor_mismatch/);

    const invalidInsert = (values: readonly unknown[]) => withTenant(appPool, tenantId, (client) => client.query(
      `INSERT INTO control.rule_bundle_revisions (
        rule_bundle_revision_id, tenant_id, app_id, rule_bundle_id,
        rule_bundle_version, rule_bundle_hash, supersedes_rule_bundle_revision_id,
        activated_at, actor_ref, artifact
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [...values],
    ));
    await assert.rejects(() => invalidInsert([
      "rule-bundle:second-root", tenantId, appId, "synthetic-history", "2.0.0",
      "4".repeat(64), null, "2026-08-20T01:02:00.000Z", "admin_key:synthetic",
      JSON.stringify({
        rule_bundle_revision_id: "rule-bundle:second-root",
        rule_bundle_id: "synthetic-history",
        rule_bundle_version: "2.0.0",
        rule_bundle_hash: "4".repeat(64),
        activated_at: "2026-08-20T01:02:00.000Z",
      }),
    ]), (error: any) => error?.code === "23505");
    await assert.rejects(() => invalidInsert([
      "rule-bundle:cross-bundle", tenantId, appId, "fraud-default", "1.0.0",
      "5".repeat(64), second.rule_bundle_revision_id, "2026-08-20T01:03:00.000Z", "admin_key:synthetic",
      JSON.stringify({
        rule_bundle_revision_id: "rule-bundle:cross-bundle",
        rule_bundle_id: "fraud-default",
        rule_bundle_version: "1.0.0",
        rule_bundle_hash: "5".repeat(64),
        supersedes_rule_bundle_revision_id: second.rule_bundle_revision_id,
        activated_at: "2026-08-20T01:03:00.000Z",
      }),
    ]), (error: any) => error?.code === "23503");
    await assert.rejects(() => invalidInsert([
      "rule-bundle:artifact-mismatch", tenantId, appId, "measurement-default", "1.0.0",
      "6".repeat(64), null, "2026-08-20T01:04:00.000Z", "admin_key:synthetic",
      JSON.stringify({
        rule_bundle_revision_id: "rule-bundle:artifact-mismatch",
        rule_bundle_id: "wrong-bundle",
        rule_bundle_version: "1.0.0",
        rule_bundle_hash: "6".repeat(64),
        activated_at: "2026-08-20T01:04:00.000Z",
      }),
    ]), (error: any) => error?.code === "23514");

    const state = await withTenant(appPool, tenantId, async (client) => ({
      history: await client.query<{ rule_bundle_revision_id: string }>(
        "SELECT rule_bundle_revision_id FROM control.rule_bundle_revisions WHERE tenant_id=$1 AND app_id=$2 ORDER BY activated_at",
        [tenantId, appId],
      ),
      current: await client.query<{ rule_bundle_revision_id: string }>(
        "SELECT rule_bundle_revision_id FROM control.rule_bundles_current WHERE tenant_id=$1 AND app_id=$2",
        [tenantId, appId],
      ),
      audits: await client.query<{ action: string }>(
        "SELECT action FROM ledger.audit_logs WHERE tenant_id=$1 AND app_id=$2 AND target_scope='rule_bundle' ORDER BY occurred_at",
        [tenantId, appId],
      ),
    }));
    assert.deepEqual(state.history.rows.map((row) => row.rule_bundle_revision_id), [
      first.rule_bundle_revision_id,
      second.rule_bundle_revision_id,
    ]);
    assert.deepEqual(state.current.rows.map((row) => row.rule_bundle_revision_id), [second.rule_bundle_revision_id]);
    assert.deepEqual(state.audits.rows.map((row) => row.action), ["rule_bundle_activated", "rule_bundle_superseded"]);

    await assert.rejects(() => withTenant(appPool, tenantId, (client) => client.query(
      "UPDATE control.rule_bundle_revisions SET rule_bundle_version='changed' WHERE rule_bundle_revision_id=$1",
      [first.rule_bundle_revision_id],
    )), /permission denied/);
    await assert.rejects(() => withTenant(migrationPool, tenantId, (client) => client.query(
      "UPDATE control.rule_bundle_revisions SET rule_bundle_version='changed' WHERE rule_bundle_revision_id=$1",
      [first.rule_bundle_revision_id],
    )), /append-only/);
    await assert.rejects(() => withTenant(migrationPool, tenantId, (client) => client.query(
      "DELETE FROM control.rule_bundle_revisions WHERE rule_bundle_revision_id=$1",
      [first.rule_bundle_revision_id],
    )), /append-only/);
  });

  it("WO20 resolves an activated canonical non-fraud revision and rejects forged provenance", async () => {
    const definition = structuredClone(NON_FRAUD_RULE_BUNDLES["attribution-default"]);
    const hash = nonFraudBundleHash("attribution-default");
    const revision = await activateRuleBundle({
      pool: appPool,
      identity: identities.admin,
      body: {
        rule_bundle_id: definition.id,
        rule_bundle_version: definition.version,
        rule_bundle_hash: hash,
        definition,
        definition_digest: hash,
      },
      now: new Date("2026-08-20T01:30:00.000Z"),
    });
    const resolved = await resolveNonFraudBundle(appPool, tenantId, appId, "attribution-default");
    assert.deepEqual(resolved, {
      ruleBundleRevisionId: revision.rule_bundle_revision_id,
      ruleBundleId: definition.id,
      ruleBundleVersion: definition.version,
      ruleBundleHash: hash,
      definitionDigest: hash,
    });

    await assert.rejects(() => activateRuleBundle({
      pool: appPool,
      identity: identities.admin,
      body: {
        rule_bundle_id: definition.id,
        rule_bundle_version: definition.version,
        rule_bundle_hash: "f".repeat(64),
        definition,
        definition_digest: hash,
        supersedes_rule_bundle_revision_id: revision.rule_bundle_revision_id,
      },
    }), /rule_bundle_hash_mismatch/);
    await assert.rejects(() => activateRuleBundle({
      pool: appPool,
      identity: identities.admin,
      body: {
        rule_bundle_id: definition.id,
        rule_bundle_version: definition.version,
        definition: { ...definition, rules: [...definition.rules, "synthetic-forgery"] },
        supersedes_rule_bundle_revision_id: revision.rule_bundle_revision_id,
      },
    }), /non_fraud_rule_bundle_definition_unsupported/);
  });

  it("F-A-12 registers the canonical fraud definition and rejects forged digests", async () => {
    const definition = structuredClone(DEFAULT_FRAUD_BUNDLE);
    const revision = await activateRuleBundle({
      pool: appPool,
      identity: identities.admin,
      body: {
        rule_bundle_id: definition.id,
        rule_bundle_version: definition.version,
        rule_bundle_hash: fraudBundleHash(definition),
        definition,
        definition_digest: sha256Jcs(definition),
      },
      now: new Date("2026-08-20T02:00:00.000Z"),
    });
    assert.equal(revision.rule_bundle_hash, fraudBundleHash(definition));
    assert.equal(revision.definition_digest, sha256Jcs(definition));
    await assert.rejects(() => activateRuleBundle({
      pool: appPool,
      identity: identities.admin,
      body: {
        rule_bundle_id: definition.id,
        rule_bundle_version: "1.1.0",
        rule_bundle_hash: "f".repeat(64),
        definition: { ...definition, version: "1.1.0" },
        definition_digest: sha256Jcs({ ...definition, version: "1.1.0" }),
        supersedes_rule_bundle_revision_id: revision.rule_bundle_revision_id,
      },
    }), /rule_bundle_hash_mismatch/);
    await assert.rejects(() => activateRuleBundle({
      pool: appPool,
      identity: identities.admin,
      body: {
        rule_bundle_id: definition.id,
        rule_bundle_version: "1.1.0",
        definition: { ...definition, version: "1.1.0" },
        definition_digest: "0".repeat(64),
        supersedes_rule_bundle_revision_id: revision.rule_bundle_revision_id,
      },
    }), /rule_bundle_definition_digest_mismatch/);
    const stored = await withTenant(appPool, tenantId, (client) => client.query<{
      definition: unknown; definition_digest: string;
    }>(
      "SELECT definition,definition_digest FROM control.rule_bundle_revisions WHERE rule_bundle_revision_id=$1",
      [revision.rule_bundle_revision_id],
    ));
    assert.deepEqual(stored.rows[0].definition, definition);
    assert.equal(stored.rows[0].definition_digest, sha256Jcs(definition));
  });
  describe("optional app-scoped administration", { concurrency: false }, () => {
    const sibling = `${appId}-sibling`, foreignTenant = `${tenantId}-foreign`, foreignApp = `${appId}-foreign`;
    const cutoff = "2026-08-09T00:00:00.000Z";
    type Issued = Awaited<ReturnType<typeof issueAdminKey>>;
    let readA: Issued, readB: Issued, adminA: Issued, operatorA: Issued;
    let cookie: string, foreignKey: string, legacyKey: string;
    const runIds: string[][] = [];
    const cli = (args: string[]) => {
      const env: NodeJS.ProcessEnv = { ...process.env, OPENMASU_ADMIN_KEY: keys.admin };
      delete env.OPENMASU_ADMIN_KEY_FILE;
      return JSON.parse(execFileSync(process.execPath,
        ["--import", "tsx", "apps/api/src/admin-key-cli.ts", ...args], { env, encoding: "utf8" }));
    };
    const bearer = (key: string, path: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
      ...init, headers: { authorization: `Bearer ${key}`, ...init.headers },
    });
    const page = (path: string, sessionCookie = cookie, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
      ...init, headers: { cookie: sessionCookie, ...init.headers }, redirect: "manual",
    });
    const reportPath = (app: string, suffix = "") => `/v1/reports/metrics?app_id=${app}&watermark_at_most=${cutoff}${suffix}`;

    before(async () => {
      // One reset, three app populations: real ledger writes and the actual SQL
      // engine, not fabricated HTTP rows or a privileged mock reader.
      const variants = [[tenantId, appId], [tenantId, sibling], [foreignTenant, foreignApp]].map(([tenant, app], index) => {
        const fixture = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json", "utf8")
          .replaceAll('"tenant-a"', JSON.stringify(tenant)).replaceAll('"app-a"', JSON.stringify(app)));
        for (const record of fixture.records) for (const field of ["record_id", "delivery_id", "event_id"]) record[field] += `-scope-${index}`;
        for (const cost of fixture.cost_records) cost.cost_record_id += `-scope-${index}`;
        fixture.metric_evaluations = [{ ...fixture.metric_evaluations[0], metric_run_id_prefix: `scope-${index}` }];
        return fixture;
      });
      const seed = createSeedPool();
      try {
        await ingestFixture(`synthetic-app-scope-${suffix}`, { ...variants[0], records: undefined, server_context: undefined,
          metric_evaluations: [], cost_records: variants.flatMap(input => input.cost_records),
          batches: variants.map((input, index) => ({ batch_id: `scope-${index}`, server_context: input.server_context, records: input.records })),
        }, appPool, seed);
        for (const input of variants) runIds.push((await computeSqlMetricRuns(appPool, input)).map(run => run.metric_run_id));
      } finally { await seed.end(); }
      assert.ok(runIds.every(ids => ids.length === 7));
      readA = cli(["issue", `--tenant=${tenantId}`, "--role=read_only", `--app=${appId}`]);
      readB = await issueAdminKey(appPool, identities.admin, { role: "read_only", appScope: sibling });
      operatorA = await issueAdminKey(appPool, identities.admin, { role: "operator", appScope: appId });
      adminA = await issueAdminKey(appPool, identities.admin, { role: "admin", appScope: appId });
      const session = await issueDashboardSession(appPool, tenantId, readA.key_id, 3600);
      cookie = `openmasu_dashboard=${session.token}`;
      foreignKey = `synthetic-foreign-owner-${suffix}-${"f".repeat(32)}`;
      await ensureAdminKeys(appPool, { tenantId: foreignTenant, appId: foreignApp }, [foreignKey]);
      // An old populated app_id was deployment metadata, not an app restriction.
      legacyKey = `synthetic-legacy-reader-${suffix}-${"l".repeat(32)}`;
      const legacyId = `key:${createHash("sha256").update(legacyKey).digest("hex").slice(0, 32)}`;
      const salt = Buffer.alloc(16, 7);
      await withTenant(appPool, tenantId, async client => {
        await client.query(`INSERT INTO control.admin_keys (key_id,tenant_id,app_id,scrypt_salt,scrypt_digest,created_at,role)
          VALUES ($1,$2,$3,$4,$5,$6,'read_only')`, [legacyId, tenantId, sibling, salt.toString("hex"),
          scryptSync(legacyKey, salt, 32, { N: 16_384, r: 8, p: 1 }).toString("hex"), new Date().toISOString()]);
        await client.query(`INSERT INTO control.admin_key_states (key_id,tenant_id,app_id,status,changed_at,artifact)
          VALUES ($1,$2,$3,'active',$4,'{}')`, [legacyId, tenantId, sibling, new Date().toISOString()]);
      });
    });

    it("app_scope_actual_reader_isolates_list_detail_export_cursor_and_foreign_tenant_without_weakening_legacy_keys", async () => {
      const session = await verifyDashboardSession(readerPool, tenantId, cookie, "http://localhost:8080");
      assert.equal(session?.appScope, appId);
      const listed = await (await bearer(readA.admin_key, "/v1/admin/apps")).json() as { data: { app_id: string }[] };
      assert.deepEqual(listed.data.map(row => row.app_id), [appId]);
      assert.deepEqual((await (await bearer(legacyKey, "/v1/admin/apps")).json() as typeof listed).data.map(row => row.app_id), [appId, sibling].sort());
      assert.equal((await verifyAdminKey(appPool, tenantId, `Bearer ${legacyKey}`))?.appScope, undefined);
      assert.equal((await bearer(foreignKey, "/v1/admin/apps")).status, 401);
      assert.equal((await bearer(readB.admin_key, reportPath(sibling))).status, 200);
      const rows = await (await bearer(readA.admin_key, reportPath(appId))).json() as { data: { metric_run_id: string }[] };
      assert.equal(rows.data.length, 7);
      assert.ok(rows.data.every(row => runIds[0]!.includes(row.metric_run_id)));
      assert.equal((await bearer(readA.admin_key, `/v1/admin/apps/${appId}/metrics/${encodeURIComponent(runIds[0]![0]!)}/explanation`)).status, 200);
      const apiCsv = await bearer(readA.admin_key, reportPath(appId, "&format=csv"));
      const dashboardCsv = await page(`/dashboard/apps/${appId}/cohorts.csv?watermark_at_most=${cutoff}`);
      assert.equal(apiCsv.status, 200); assert.equal(dashboardCsv.status, 200);
      assert.equal(await dashboardCsv.text(), await apiCsv.text());
      const html = await (await page("/dashboard")).text();
      assert.ok(html.includes(appId)); assert.ok(!html.includes(sibling) && !html.includes(foreignApp));
      const cursorResponse = await bearer(keys.admin, reportPath(sibling, "&limit=1"));
      const cursor = cursorResponse.headers.get("x-next-cursor"); assert.ok(cursor);
      const crossed = await bearer(readA.admin_key, reportPath(appId, `&after=${encodeURIComponent(cursor)}`));
      // Cross-app cursors are positions, never authorization capabilities.
      if (crossed.status === 200) {
        const data = await crossed.json() as typeof rows;
        assert.ok(data.data.every(row => runIds[0]!.includes(row.metric_run_id)));
      } else assert.equal(crossed.status, 400);
      for (const makePath of [reportPath, (app: string) => `/v1/admin/apps/${app}/metrics/${encodeURIComponent(runIds[1]![0]!)}/explanation`,
        (app: string) => reportPath(app, "&format=csv&export=true")]) {
        const denied = await Promise.all([sibling, foreignApp, "missing-synthetic-app"].map(async app => {
          const response = await bearer(readA.admin_key, makePath(app)); return [response.status, await response.text()];
        }));
        assert.equal(denied[0]![0], 404); assert.deepEqual(denied[0], denied[1]); assert.deepEqual(denied[0], denied[2]);
      }
      const deniedPages = await Promise.all([sibling, foreignApp, "missing-synthetic-app"].map(async app => {
        const response = await page(`/dashboard/apps/${app}`); return [response.status, await response.text()];
      }));
      assert.equal(deniedPages[0]![0], 404); assert.deepEqual(deniedPages[0], deniedPages[1]); assert.deepEqual(deniedPages[0], deniedPages[2]);
      const foreignRows = await withTenant(readerPool, tenantId, client => client.query(
        "SELECT metric_run_id FROM ledger.metric_runs WHERE tenant_id=$1", [foreignTenant]));
      assert.equal(foreignRows.rowCount, 0);
    });

    it("app_scope_applies_to_roles_jobs_mutations_and_tenant_wide_controls_in_API_and_dashboard", async () => {
      const post = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ platform: "android" }) };
      assert.equal((await bearer(adminA.admin_key, `/v1/admin/apps/${appId}/sdk-keys`, post)).status, 201);
      assert.equal((await bearer(operatorA.admin_key, `/v1/admin/apps/${appId}/sdk-keys`, post)).status, 403);
      assert.equal((await bearer(readA.admin_key, `/v1/admin/apps/${appId}/sdk-keys`, post)).status, 403);
      for (const feature of ["sdk-keys", "metric-schedules", "operator-bulk-exports", "metric-recalculations"]) {
        assert.equal((await bearer(adminA.admin_key, `/v1/admin/apps/${appId}/${feature}`)).status, 200);
        for (const method of ["GET", "POST"]) {
          const results = await Promise.all([sibling, "missing-synthetic-app"].map(async app => {
            const response = await bearer(adminA.admin_key, `/v1/admin/apps/${app}/${feature}`, { ...post, method });
            return [response.status, await response.text()];
          }));
          assert.equal(results[0]![0], 404); assert.deepEqual(results[0], results[1]);
        }
      }
      assert.equal((await bearer(operatorA.admin_key, `/v1/admin/apps/${sibling}/metric-recalculations`, post)).status, 404);
      for (const path of ["/metrics", "/v1/admin/apps", "/v1/admin/link-domain"]) {
        assert.equal((await bearer(adminA.admin_key, path, path === "/metrics" ? {} : post)).status, 403);
      }
      assert.equal((await bearer(adminA.admin_key, "/v1/admin/privacy-requests", { ...post, body: JSON.stringify({
        tenant_id: tenantId, app_id: appId, requested_via: "tenant_admin_api", deletion_scope: "tenant", deletion_subject_ref: "synthetic-tenant",
      }) })).status, 403);
      const session = await issueDashboardSession(appPool, tenantId, adminA.key_id, 3600);
      const adminCookie = `openmasu_dashboard=${session.token}`;
      const html = await (await page(`/dashboard/apps/${appId}`, adminCookie)).text();
      assert.match(html, /Issue successor key/); assert.doesNotMatch(html, /Register an app|Register a link domain/);
      for (const path of ["/dashboard/apps", "/dashboard/link-domain"]) assert.equal((await page(path, adminCookie, { method: "POST" })).status, 403);
      const actor = await verifyAdminKey(appPool, tenantId, `Bearer ${adminA.admin_key}`); assert.ok(actor);
      await assert.rejects(() => issueAdminKey(appPool, actor, { role: "admin" }), /forbidden/);
      await assert.rejects(() => retireAdminKey(appPool, actor, readB.key_id), /forbidden/);
    });

    it("app_scope_rotation_is_immutable_atomic_audited_and_revokes_existing_sessions", async () => {
      const replacement = await issueAdminKey(appPool, identities.admin, { role: "read_only", appScope: appId });
      await assert.rejects(() => issueAdminKey(appPool, identities.admin, { role: "read_only", appScope: appId }), /overlap exceeds/);
      await assert.rejects(() => ensureAdminKeys(appPool, { tenantId, appId }, [{ key: readA.admin_key, role: "operator", appScope: appId }]), /role is immutable/);
      await assert.rejects(() => ensureAdminKeys(appPool, { tenantId, appId }, [{ key: readA.admin_key, role: "read_only", appScope: sibling }]), /app scope is immutable/);
      assert.equal(cli(["retire", `--tenant=${tenantId}`, `--key-id=${readA.key_id}`]).retired, true);
      assert.equal((await bearer(readA.admin_key, reportPath(appId))).status, 401);
      assert.equal((await page(`/dashboard/apps/${appId}`)).status, 401);
      assert.equal(await verifyDashboardSession(readerPool, tenantId, cookie, "http://localhost:8080"), undefined);
      assert.equal((await bearer(replacement.admin_key, reportPath(appId))).status, 200);
      await ensureAdminKeys(appPool, { tenantId, appId }, [{ key: readA.admin_key, role: "read_only", appScope: appId }]);
      assert.equal(await verifyAdminKey(appPool, tenantId, `Bearer ${readA.admin_key}`), undefined);
      await assert.rejects(() => retireAdminKey(appPool, identities.admin, identities.admin.keyId), /last_tenant_admin/);
      await assert.rejects(() => retireAdminKey(appPool, identities.admin, `key:${createHash("sha256").update(foreignKey).digest("hex").slice(0, 32)}`), /admin_key_not_found/);
      const audit = await withTenant(readerPool, tenantId, client => client.query<{ action: string; target_ref: string; app_id: string; row: string }>(
        `SELECT action,target_ref,app_id,row_to_json(audit_logs)::text AS row FROM ledger.audit_logs
         WHERE target_scope='admin_key' ORDER BY action,target_ref`));
      assert.equal(audit.rows.filter(row => row.action === "admin_key_issued").length, 5);
      assert.equal(audit.rows.filter(row => row.action === "admin_key_retired").length, 1);
      assert.ok(audit.rows.every(row => [appId, sibling].includes(row.app_id)));
      const serialized = JSON.stringify(audit.rows);
      for (const secret of [keys.admin, readA.admin_key, replacement.admin_key, "scrypt_digest", "scrypt_salt"]) assert.ok(!serialized.includes(secret));
    });
  });
});
