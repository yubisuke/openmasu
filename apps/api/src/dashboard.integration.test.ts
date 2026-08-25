import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Pool } from "pg";
import {
  createAppPool,
  createReaderPool,
  EncryptedFilePayloadStore,
  withTenant,
} from "@open-mmp/runtime";
import { ensureAdminKeys } from "./admin-auth.js";
import { KeyedTokenBucket, TokenBucket } from "./rate-limit.js";
import { createRequestHandler } from "./router.js";
import {
  csrfToken,
  issueDashboardSession,
  readDashboardToken,
  sweepExpiredDashboardSessions,
  verifyDashboardSession,
} from "./session.js";

const suffix = `${Date.now()}`;
const tenantId = `tenant-m3-${suffix}`;
const appId = `app-m3-${suffix}`;
const adminKeyA = `synthetic-m3-admin-key-a-${suffix}-${"a".repeat(32)}`;
const adminKeyB = `synthetic-m3-admin-key-b-${suffix}-${"b".repeat(32)}`;
const configuredOrigin = "http://localhost:8080";

describe("M3 dashboard identity and control plane", { concurrency: false }, () => {
  let appPool: Pool;
  let readerPool: Pool;
  let server: Server;
  let baseUrl: string;
  let payloadRoot: string;
  let payloadStore: EncryptedFilePayloadStore;

  function handler(options: { loginRate?: number; loginBurst?: number } = {}) {
    return createRequestHandler({
      pool: appPool,
      readerPool,
      payloadStore,
      maxConfig: {
        tenantId,
        appId,
        pathSecret: "synthetic-m3-max-path",
        eventKey: "synthetic-m3-max-event-key",
        tokenMode: "all",
        maxParameters: 40,
        maxQueryBytes: 8192,
      },
      publicBaseUrl: configuredOrigin,
      redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: true, publicBaseUrl: configuredOrigin, tenantId, sessionTtlSeconds: 43200 },
      dashboardLoginBucket: new KeyedTokenBucket(options.loginRate ?? 100, options.loginBurst ?? 100),
      dashboardLoginGlobalBucket: new TokenBucket(100, 100),
    });
  }

  async function start(candidate = handler()): Promise<{ server: Server; baseUrl: string }> {
    const instance = createServer(candidate);
    await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
    const address = instance.address();
    assert.ok(address && typeof address === "object");
    return { server: instance, baseUrl: `http://127.0.0.1:${address.port}` };
  }

  async function close(instance: Server): Promise<void> {
    await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  }

  async function login(key: string, endpoint = baseUrl): Promise<Response> {
    return fetch(`${endpoint}/dashboard/session`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ admin_key: key }),
    });
  }

  function cookie(response: Response): string {
    const value = response.headers.get("set-cookie");
    assert.ok(value);
    return value.split(";", 1)[0];
  }

  before(async () => {
    appPool = createAppPool();
    readerPool = createReaderPool();
    payloadRoot = mkdtempSync(join(tmpdir(), "openmmp-m3-"));
    payloadStore = new EncryptedFilePayloadStore(payloadRoot, "synthetic-m3-master-key-000000000000000000000000");
    await ensureAdminKeys(appPool, { tenantId, appId }, [adminKeyA, adminKeyB]);
    ({ server, baseUrl } = await start());
  });

  after(async () => {
    if (server) await close(server);
    await appPool?.end();
    await readerPool?.end();
    if (payloadRoot) rmSync(payloadRoot, { recursive: true, force: true });
  });

  it("C01 authenticates both overlap keys and keeps invalid responses byte-identical", async () => {
    for (const key of [adminKeyA, adminKeyB]) {
      const response = await login(key);
      assert.equal(response.status, 303);
      const setCookie = response.headers.get("set-cookie") ?? "";
      assert.match(setCookie, /^openmmp_dashboard=[A-Za-z0-9_-]{43};/);
      for (const attribute of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"]) assert.ok(setCookie.includes(attribute));
      assert.equal(response.headers.get("location"), "/dashboard");
    }
    const wrong = await login(`synthetic-wrong-${"w".repeat(40)}`);
    const unknown = await login(`synthetic-unknown-${"u".repeat(40)}`);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(await wrong.text(), await unknown.text());
    const failures = await withTenant(appPool, tenantId, (client) => client.query<{ actor_ref: string }>(
      "SELECT actor_ref FROM ledger.audit_logs WHERE tenant_id=$1 AND action='dashboard_login' AND outcome='failed' ORDER BY occurred_at DESC LIMIT 2",
      [tenantId],
    ));
    assert.equal(failures.rows.length, 2);
    assert.equal(failures.rows.every((row) => row.actor_ref === "admin_key:unrecognized"), true);
  });

  it("C02 issues, verifies, revokes, rejects mutations, and sweeps absolute sessions", async () => {
    const beforeCount = await withTenant(appPool, tenantId, async (client) => Number((await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ephemeral.dashboard_sessions WHERE tenant_id=$1",
      [tenantId],
    )).rows[0].count));
    const response = await login(adminKeyA);
    const sessionCookie = cookie(response);
    const page = await fetch(`${baseUrl}/dashboard`, { headers: { cookie: sessionCookie } });
    const html = await page.text();
    assert.match(html, /Open MMP dashboard/);
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(csrf);

    const changedCookie = `${sessionCookie.slice(0, -1)}${sessionCookie.endsWith("A") ? "B" : "A"}`;
    assert.match(await (await fetch(`${baseUrl}/dashboard`, { headers: { cookie: changedCookie } })).text(), /Admin key/);

    const logout = await fetch(`${baseUrl}/dashboard/session/delete`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: sessionCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf }),
    });
    assert.equal(logout.status, 303);
    assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
    assert.match(await (await fetch(`${baseUrl}/dashboard`, { headers: { cookie: sessionCookie } })).text(), /Admin key/);
    const afterCount = await withTenant(appPool, tenantId, async (client) => Number((await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ephemeral.dashboard_sessions WHERE tenant_id=$1",
      [tenantId],
    )).rows[0].count));
    assert.equal(afterCount, beforeCount);

    const expiredNow = new Date("2026-08-20T00:00:00.000Z");
    const activeKey = await withTenant(appPool, tenantId, async (client) => (await client.query<{ key_id: string }>(
      "SELECT key_id FROM control.admin_keys_current WHERE tenant_id=$1 AND status='active' ORDER BY key_id LIMIT 1",
      [tenantId],
    )).rows[0].key_id);
    const expired = await issueDashboardSession(
      appPool,
      tenantId,
      activeKey,
      60,
      new Date("2026-08-19T00:00:00.000Z"),
    );
    const expiredCookie = `openmmp_dashboard=${expired.token}`;
    assert.equal(await verifyDashboardSession(
      readerPool,
      tenantId,
      expiredCookie,
      configuredOrigin,
      expiredNow,
    ), undefined);
    assert.equal(await sweepExpiredDashboardSessions(appPool, tenantId, expiredNow), 1);
    const sweptCount = await withTenant(appPool, tenantId, async (client) => Number((await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM ephemeral.dashboard_sessions WHERE tenant_id=$1",
      [tenantId],
    )).rows[0].count));
    assert.equal(sweptCount, beforeCount);
  });

  it("C03 proves reader RLS visibility and database-enforced write denial", async () => {
    const visible = await withTenant(readerPool, tenantId, (client) => client.query(
      "SELECT app_id FROM control.apps WHERE tenant_id=$1 AND app_id=$2",
      [tenantId, appId],
    ));
    assert.equal(visible.rowCount, 1);
    const unset = await readerPool.query("SELECT app_id FROM control.apps WHERE tenant_id=$1", [tenantId]);
    assert.equal(unset.rowCount, 0);
    await assert.rejects(
      () => withTenant(readerPool, tenantId, (client) => client.query(
        "INSERT INTO control.apps (tenant_id, app_id, created_at) VALUES ($1,$2,$3)",
        [tenantId, `reader-write-${suffix}`, "2026-08-20T00:00:00.000Z"],
      )),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "42501",
    );
  });

  it("C04 never accepts the other namespace credential", async () => {
    const anonymous = await fetch(`${baseUrl}/dashboard`);
    const bearerOnly = await fetch(`${baseUrl}/dashboard`, { headers: { authorization: `Bearer ${adminKeyA}` } });
    assert.equal(bearerOnly.status, anonymous.status);
    assert.equal(await bearerOnly.text(), await anonymous.text());
    const sessionResponse = await login(adminKeyA);
    const cookieOnly = await fetch(`${baseUrl}/v1/admin/apps`, { headers: { cookie: cookie(sessionResponse) } });
    assert.equal(cookieOnly.status, 401);
  });

  it("C05 rejects missing, cross-session, and cross-origin CSRF before accepting the bound token", async () => {
    const first = cookie(await login(adminKeyA));
    const second = cookie(await login(adminKeyB));
    const firstToken = readDashboardToken(first, configuredOrigin);
    const secondToken = readDashboardToken(second, configuredOrigin);
    assert.ok(firstToken && secondToken);
    const post = (csrf: string | undefined, origin = configuredOrigin) => fetch(`${baseUrl}/dashboard/session/delete`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: first, origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(csrf ? { csrf_token: csrf } : {}),
    });
    assert.equal((await post(undefined)).status, 403);
    assert.equal((await post(csrfToken(secondToken))).status, 403);
    assert.equal((await post(csrfToken(firstToken), "https://cross-origin.invalid")).status, 403);
    assert.equal((await post(csrfToken(firstToken))).status, 303);
  });

  it("C06 throttles before audit insertion and never persists the source IP", async () => {
    const limited = await start(handler({ loginRate: 0.000001, loginBurst: 1 }));
    try {
      const before = await withTenant(appPool, tenantId, async (client) => Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.audit_logs WHERE tenant_id=$1",
        [tenantId],
      )).rows[0].count));
      assert.equal((await login(`synthetic-limited-${"l".repeat(40)}`, limited.baseUrl)).status, 401);
      const afterFailure = await withTenant(appPool, tenantId, async (client) => Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.audit_logs WHERE tenant_id=$1",
        [tenantId],
      )).rows[0].count));
      assert.equal(afterFailure, before + 1);
      assert.equal((await login(`synthetic-limited-${"m".repeat(40)}`, limited.baseUrl)).status, 429);
      const afterThrottle = await withTenant(appPool, tenantId, async (client) => Number((await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM ledger.audit_logs WHERE tenant_id=$1",
        [tenantId],
      )).rows[0].count));
      assert.equal(afterThrottle, afterFailure);
      const leaked = await withTenant(appPool, tenantId, (client) => client.query(
        "SELECT 1 FROM ledger.audit_logs WHERE tenant_id=$1 AND row_to_json(audit_logs)::text LIKE '%127.0.0.1%'",
        [tenantId],
      ));
      assert.equal(leaked.rowCount, 0);
      const tables = await appPool.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_type='BASE TABLE' AND table_schema IN ('control','ledger','ephemeral')
           AND has_table_privilege(
             quote_ident(table_schema) || '.' || quote_ident(table_name),
             'SELECT'
           )
         ORDER BY table_schema, table_name`,
      );
      for (const table of tables.rows) {
        const schema = `"${table.table_schema.replaceAll('"', '""')}"`;
        const name = `"${table.table_name.replaceAll('"', '""')}"`;
        const match = await withTenant(appPool, tenantId, (client) => client.query(
          `SELECT 1 FROM ${schema}.${name} AS candidate
           WHERE row_to_json(candidate)::text LIKE $1 LIMIT 1`,
          ["%127.0.0.1%"],
        ));
        assert.equal(match.rowCount, 0, `source IP leaked into ${table.table_schema}.${table.table_name}`);
      }
      assert.equal(await payloadStore.scanFor("127.0.0.1"), false);
    } finally {
      await close(limited.server);
    }
  });

  it("C08 registers an app, returns one SDK secret, audits IDs only, and hides app existence", async () => {
    const newAppId = `registered-${suffix}`;
    const headers = { authorization: `Bearer ${adminKeyA}`, "content-type": "application/json" };
    const registered = await fetch(`${baseUrl}/v1/admin/apps`, {
      method: "POST",
      headers,
      body: JSON.stringify({ app_id: newAppId }),
    });
    assert.equal(registered.status, 201);
    const issued = await registered.json() as { app_id: string; sdk_key_id: string; sdk_key: string };
    assert.equal(issued.app_id, newAppId);
    assert.ok(issued.sdk_key.length >= 32);
    assert.equal(await payloadStore.scanFor(issued.sdk_key), false);

    const listedBody = await (await fetch(`${baseUrl}/v1/admin/apps`, { headers })).text();
    assert.match(listedBody, new RegExp(newAppId));
    assert.equal(listedBody.includes(issued.sdk_key), false);
    const audits = await withTenant(appPool, tenantId, (client) => client.query<{ action: string; row_text: string }>(
      `SELECT action, row_to_json(audit_logs)::text AS row_text FROM ledger.audit_logs
       WHERE tenant_id=$1 AND app_id=$2 AND action IN ('app_registered','sdk_key_issued') ORDER BY action`,
      [tenantId, newAppId],
    ));
    assert.deepEqual(audits.rows.map((row) => row.action), ["app_registered", "sdk_key_issued"]);
    assert.equal(audits.rows.some((row) => row.row_text.includes(issued.sdk_key)), false);

    const dashboardCookie = cookie(await login(adminKeyA));
    const appPage = await fetch(`${baseUrl}/dashboard/apps/${newAppId}`, { headers: { cookie: dashboardCookie } });
    const appHtml = await appPage.text();
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(appHtml)?.[1];
    assert.ok(csrf);
    assert.match(appHtml, /Create a tracking link/);
    const trackingLink = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/tracking-links`, {
      method: "POST",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf_token: csrf,
        destination_kind: "play_store",
        destination_url: "https://play.google.com/store/apps/details?id=dev.openmmp.synthetic",
        play_package_name: "dev.openmmp.synthetic",
        campaign_id: "synthetic-campaign",
      }),
    });
    assert.equal(trackingLink.status, 201);
    const trackingLinkHtml = await trackingLink.text();
    assert.match(trackingLinkHtml, /Tracking link created/);
    assert.match(trackingLinkHtml, /http:\/\/localhost:8090\/r\/[A-Za-z0-9_-]+/);
    const trackingAudit = await withTenant(appPool, tenantId, (client) => client.query(
      `SELECT 1 FROM ledger.audit_logs
       WHERE tenant_id=$1 AND app_id=$2 AND action='tracking_link_created' AND outcome='succeeded'`,
      [tenantId, newAppId],
    ));
    assert.equal(trackingAudit.rowCount, 1);

    const dashboardLinks = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/tracking-links`, {
      headers: { cookie: dashboardCookie },
    });
    assert.equal(dashboardLinks.status, 200);
    const dashboardLinksHtml = await dashboardLinks.text();
    assert.match(dashboardLinksHtml, /Measurement links/);
    assert.match(dashboardLinksHtml, /http:\/\/localhost:8090\/r\/[A-Za-z0-9_-]+/);
    assert.match(dashboardLinksHtml, /synthetic-campaign/);
    assert.match(dashboardLinksHtml, /active/);

    const apiLinks = await fetch(`${baseUrl}/v1/admin/tracking-links?app_id=${newAppId}`, { headers });
    assert.equal(apiLinks.status, 200);
    const apiLinksBody = await apiLinks.json() as { data: readonly Record<string, unknown>[] };
    assert.equal(apiLinksBody.data.length, 1);
    assert.match(String(apiLinksBody.data[0].measurement_url), /^http:\/\/localhost:8090\/r\/[A-Za-z0-9_-]+$/);
    assert.equal(apiLinksBody.data[0].campaign_id, "synthetic-campaign");
    assert.equal(apiLinksBody.data[0].status, "active");
    assert.equal("tenant_id" in apiLinksBody.data[0], false);
    assert.equal("app_id" in apiLinksBody.data[0], false);
    assert.equal("artifact" in apiLinksBody.data[0], false);

    const emptyReport = await fetch(`${baseUrl}/v1/reports/metrics?app_id=${newAppId}&format=json`, { headers });
    assert.equal(emptyReport.status, 200);
    assert.deepEqual(await emptyReport.json(), { data: [] });

    const otherTenant = `tenant-other-${suffix}`;
    const otherApp = `app-other-${suffix}`;
    await withTenant(appPool, otherTenant, (client) => client.query(
      "INSERT INTO control.apps (tenant_id, app_id, created_at) VALUES ($1,$2,$3)",
      [otherTenant, otherApp, "2026-08-20T00:00:00.000Z"],
    ));
    const unknown = await fetch(`${baseUrl}/v1/reports/metrics?app_id=missing-${suffix}&format=json`, { headers });
    const crossTenant = await fetch(`${baseUrl}/v1/reports/metrics?app_id=${otherApp}&format=json`, { headers });
    assert.equal(unknown.status, 404);
    assert.equal(crossTenant.status, 404);
    assert.equal(await unknown.text(), await crossTenant.text());
    const unknownLinks = await fetch(`${baseUrl}/v1/admin/tracking-links?app_id=missing-${suffix}`, { headers });
    const crossTenantLinks = await fetch(`${baseUrl}/v1/admin/tracking-links?app_id=${otherApp}`, { headers });
    assert.equal(unknownLinks.status, 404);
    assert.equal(crossTenantLinks.status, 404);
    assert.equal(await unknownLinks.text(), await crossTenantLinks.text());
  });
});
