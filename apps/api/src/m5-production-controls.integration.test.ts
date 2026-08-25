import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Pool } from "pg";
import {
  createAppPool,
  createMigrationPool,
  createReaderPool,
  EncryptedFilePayloadStore,
  withTenant,
} from "@openmasu/runtime";
import { ensureAdminKeys, verifyAdminKey, type AppAdminIdentity } from "./admin-auth.js";
import { createRequestHandler } from "./router.js";
import { OperationalMetrics } from "./operational-metrics.js";
import { activateRuleBundle } from "./rule-bundles.js";
import { issueDashboardSession, verifyDashboardSession } from "./session.js";

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
    for (const forbidden of ["tenant_id", "app_id", "installation_id", "record_id", "payload", "authorization", "cookie"]) {
      assert.equal(body.includes(forbidden), false);
    }
  });

  it("keeps rule-bundle versions append-only with one current successor and audit history", async () => {
    const first = await activateRuleBundle({
      pool: appPool,
      identity: identities.admin,
      body: {
        rule_bundle_id: "attribution-default",
        rule_bundle_version: "1.0.0",
        rule_bundle_hash: "1".repeat(64),
      },
      now: new Date("2026-08-20T01:00:00.000Z"),
    });
    const second = await activateRuleBundle({
      pool: appPool,
      identity: identities.admin,
      body: {
        rule_bundle_id: "attribution-default",
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
        rule_bundle_id: "attribution-default",
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
      "rule-bundle:second-root", tenantId, appId, "attribution-default", "2.0.0",
      "4".repeat(64), null, "2026-08-20T01:02:00.000Z", "admin_key:synthetic",
      JSON.stringify({
        rule_bundle_revision_id: "rule-bundle:second-root",
        rule_bundle_id: "attribution-default",
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
});
