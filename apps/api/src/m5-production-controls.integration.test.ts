import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
  EncryptedFilePayloadStore,
  recordJobOutcome,
  uuidV7,
  withTenant,
} from "@openmasu/runtime";
import { ensureAdminKeys, verifyAdminKey, type AppAdminIdentity } from "./admin-auth.js";
import { createRequestHandler } from "./router.js";
import { OperationalMetrics, renderOperationalMetrics } from "./operational-metrics.js";
import { activateRuleBundle } from "./rule-bundles.js";
import { issueDashboardSession, verifyDashboardSession } from "./session.js";
import { resolveNonFraudBundle } from "../../worker/src/non-fraud-bundle-runtime.js";

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
      "metric_run:succeeded": "0",
      "metric_run:failed": "0",
    });
    const latest = values("openmasu_job_last_completion_timestamp_seconds");
    assert.equal(Object.keys(latest).length, 12);
    assert.equal(Number(latest["mmp_import:succeeded"]), Date.parse("2026-08-20T00:01:00.000Z") / 1000);
    assert.equal(Number(latest["cost_import:failed"]), Date.parse("2026-08-20T00:02:00.000Z") / 1000);
    for (const key of [
      "mmp_import:failed", "cost_import:succeeded", "max_revenue_import:succeeded",
      "max_revenue_import:failed", "google_conversion_delivery:succeeded",
      "google_conversion_delivery:failed", "operator_webhook_delivery:succeeded",
      "operator_webhook_delivery:failed", "metric_run:succeeded", "metric_run:failed",
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
            'job:google_conversion_delivery','job:operator_webhook_delivery','job:metric_run'
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
});
