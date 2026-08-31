import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
} from "@openmasu/runtime";
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

  function handler(options: {
    loginRate?: number;
    loginBurst?: number;
    trackingOrigins?: readonly string[];
  } = {}) {
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
      trackingDestinationAllowlist: options.trackingOrigins ?? ["https://links.synthetic.example"],
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
    payloadRoot = mkdtempSync(join(tmpdir(), "openmasu-m3-"));
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
      assert.match(setCookie, /^openmasu_dashboard=[A-Za-z0-9_-]{43};/);
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
    assert.match(html, /OpenMasu dashboard/);
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
    const expiredCookie = `openmasu_dashboard=${expired.token}`;
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
    assert.match(appHtml, new RegExp(`/dashboard/apps/${newAppId}/sdk-keys`));
    assert.match(appHtml, new RegExp(`/dashboard/apps/${newAppId}/apple-registration`));
    assert.match(appHtml, /Google Data Manager delivery health/);
    assert.match(appHtml, /No Google conversion deliveries are recorded/);
    assert.equal(appHtml.includes(issued.sdk_key), false);

    const deliveryHealth = await fetch(
      `${baseUrl}/v1/admin/apps/${newAppId}/google-data-manager/deliveries`,
      { headers },
    );
    assert.equal(deliveryHealth.status, 200);
    const deliveryHealthText = await deliveryHealth.text();
    assert.deepEqual(JSON.parse(deliveryHealthText), {
      destination: { configured: false, enabled: false, next_request_at: null },
      summary: {
        total: 0,
        due_now: 0,
        scheduled: 0,
        by_state: {
          queued: 0,
          http_accepted: 0,
          diagnostics_processing: 0,
          succeeded: 0,
          partial_success: 0,
          failed: 0,
          expired: 0,
        },
      },
      deliveries: [],
      maximum_rows: 50,
    });
    for (const forbidden of [
      "request_ref", "request_digest", "transaction_digest", "provider_request_id",
      "verification_result_id", "verified_record_id", "artifact", "claim_token", "claimed_until",
    ]) assert.equal(deliveryHealthText.includes(forbidden), false, forbidden);
    const missingHealth = await fetch(
      `${baseUrl}/v1/admin/apps/unknown-${suffix}/google-data-manager/deliveries`,
      { headers },
    );
    assert.equal(missingHealth.status, 404);
    assert.deepEqual(await missingHealth.json(), { error: "app_not_found" });

    await withTenant(appPool, tenantId, async (client) => {
      const destinationId = randomUUID();
      await client.query(`INSERT INTO control.google_data_manager_destinations (
        destination_id,tenant_id,app_id,operating_account_id,conversion_action_id,
        app_audience,enabled,registered_at,artifact,next_request_at
      ) VALUES ($1,$2,$3,'123456789','987654321','general',true,$4,$5::jsonb,$6)`, [
        destinationId,
        tenantId,
        newAppId,
        "2026-08-31T09:00:00.000Z",
        JSON.stringify({ synthetic: true }),
        "2026-08-31T10:00:00.000Z",
      ]);
      for (const [index, state, attempts, nextAttempt, deadline, reason] of [
        [0, "queued", 2, "2099-08-31T10:01:00.000Z", null, "rate_limited"],
        [1, "diagnostics_processing", 1, "2099-08-31T10:30:00.000Z", "2099-09-01T10:00:00.000Z", null],
        [2, "failed", 3, "2026-08-31T10:00:00.000Z", null, "provider_rejected"],
      ] as const) {
        const verificationResultId = randomUUID();
        const digest = randomUUID().replaceAll("-", "").repeat(2);
        await client.query(`INSERT INTO ledger.google_play_purchase_verification_results (
          verification_result_id,verification_id,tenant_id,app_id,subject_record_id,
          verified_record_id,token_digest,verdict,provider_purchase_state,product_matched,
          evidence_ref,response_digest,decided_at,artifact,purchase_kind
        ) VALUES ($1,$2,$3,$4,$5,NULL,$6,'unavailable',NULL,false,NULL,NULL,$7,$8::jsonb,'one_time_product')`, [
          verificationResultId,
          randomUUID(),
          tenantId,
          newAppId,
          `synthetic-record-${index}`,
          digest,
          "2026-08-31T09:00:00.000Z",
          JSON.stringify({ synthetic: true }),
        ]);
        const providerRequestId = state === "diagnostics_processing" ? "provider-request-synthetic-secret" : null;
        await client.query(`INSERT INTO ephemeral.google_conversion_deliveries (
          delivery_id,tenant_id,app_id,destination_id,verification_result_id,verified_record_id,
          request_ref,request_digest,transaction_digest,state,attempts,next_attempt_at,
          provider_request_id,diagnostics_deadline_at,safe_reason,created_at,updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [
          randomUUID(),
          tenantId,
          newAppId,
          destinationId,
          verificationResultId,
          `synthetic-verified-record-${index}`,
          `encrypted:synthetic-secret-${index}`,
          digest,
          digest,
          state,
          attempts,
          nextAttempt,
          providerRequestId,
          deadline,
          reason,
          `2026-08-31T09:0${index}:00.000Z`,
          `2026-08-31T09:1${index}:00.000Z`,
        ]);
      }
    });
    const populatedHealth = await fetch(
      `${baseUrl}/v1/admin/apps/${newAppId}/google-data-manager/deliveries`,
      { headers },
    );
    assert.equal(populatedHealth.status, 200);
    const populatedText = await populatedHealth.text();
    const populated = JSON.parse(populatedText) as {
      destination: { configured: boolean; enabled: boolean; next_request_at: string };
      summary: { total: number; scheduled: number; by_state: Record<string, number> };
      deliveries: Array<{ state: string; safe_reason: string | null }>;
    };
    assert.deepEqual(populated.destination, {
      configured: true,
      enabled: true,
      next_request_at: "2026-08-31T10:00:00.000Z",
    });
    assert.equal(populated.summary.total, 3);
    assert.equal(populated.summary.scheduled, 2);
    assert.equal(populated.summary.by_state.queued, 1);
    assert.equal(populated.summary.by_state.diagnostics_processing, 1);
    assert.equal(populated.summary.by_state.failed, 1);
    assert.deepEqual(populated.deliveries.map((row) => row.state), [
      "failed", "diagnostics_processing", "queued",
    ]);
    for (const forbidden of [
      "provider-request-synthetic-secret", "encrypted:synthetic-secret", "synthetic-verified-record",
      "request_ref", "request_digest", "transaction_digest", "provider_request_id",
      "verification_result_id", "verified_record_id", "artifact", "claim_token", "claimed_until",
    ]) assert.equal(populatedText.includes(forbidden), false, forbidden);
    const populatedDashboard = await (await fetch(`${baseUrl}/dashboard/apps/${newAppId}`, {
      headers: { cookie: dashboardCookie },
    })).text();
    assert.match(populatedDashboard, /diagnostics_processing/);
    assert.match(populatedDashboard, /rate_limited/);
    assert.match(populatedDashboard, /provider_rejected/);
    assert.equal(populatedDashboard.includes("provider-request-synthetic-secret"), false);

    const rejectedRotation = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/sdk-keys`, {
      method: "POST",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: "wrong-session-token", platform: "ios" }),
    });
    assert.equal(rejectedRotation.status, 403);
    const dashboardRotation = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/sdk-keys`, {
      method: "POST",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf, platform: "ios" }),
    });
    assert.equal(dashboardRotation.status, 201);
    const rotationHtml = await dashboardRotation.text();
    const successorSecret = /<dt>SDK key<\/dt><dd><code>([^<]+)<\/code>/.exec(rotationHtml)?.[1];
    assert.ok(successorSecret);
    const refreshedApp = await (await fetch(`${baseUrl}/dashboard/apps/${newAppId}`, {
      headers: { cookie: dashboardCookie },
    })).text();
    assert.equal(refreshedApp.includes(successorSecret), false);
    assert.match(refreshedApp, /secrets are never listed/);

    const firstServerIssue = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/server-keys`, {
      method: "POST",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf, producer: "postback:first-party" }),
    });
    assert.equal(firstServerIssue.status, 201);
    const firstServerHtml = await firstServerIssue.text();
    const firstServerKeyId = /<dt>Server key ID<\/dt><dd>([^<]+)<\/dd>/.exec(firstServerHtml)?.[1];
    const firstServerSecret = /<dt>Server key<\/dt><dd><code>([^<]+)<\/code>/.exec(firstServerHtml)?.[1];
    assert.ok(firstServerKeyId);
    assert.ok(firstServerSecret);
    const secondServerIssue = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/server-keys`, {
      method: "POST",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf, producer: "postback:first-party" }),
    });
    assert.equal(secondServerIssue.status, 201);
    const secondServerHtml = await secondServerIssue.text();
    const secondServerKeyId = /<dt>Server key ID<\/dt><dd>([^<]+)<\/dd>/.exec(secondServerHtml)?.[1];
    const secondServerSecret = /<dt>Server key<\/dt><dd><code>([^<]+)<\/code>/.exec(secondServerHtml)?.[1];
    assert.ok(secondServerKeyId);
    assert.ok(secondServerSecret);
    const serverMetadataPage = await (await fetch(`${baseUrl}/dashboard/apps/${newAppId}`, {
      headers: { cookie: dashboardCookie },
    })).text();
    assert.match(serverMetadataPage, /Server-to-server keys/);
    assert.match(serverMetadataPage, new RegExp(firstServerKeyId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(serverMetadataPage, new RegExp(secondServerKeyId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(serverMetadataPage.includes(firstServerSecret), false);
    assert.equal(serverMetadataPage.includes(secondServerSecret), false);
    assert.equal(serverMetadataPage.includes("secret_ref"), false);
    const retiredServer = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/server-keys/${encodeURIComponent(firstServerKeyId)}/retire`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf }),
    });
    assert.equal(retiredServer.status, 303);
    const lastServer = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/server-keys/${encodeURIComponent(secondServerKeyId)}/retire`, {
      method: "POST",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf }),
    });
    assert.equal(lastServer.status, 409);
    assert.match(await lastServer.text(), /last_active_server_key/);

    const linkDomain = await fetch(`${baseUrl}/dashboard/link-domain`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf_token: csrf, host: `wo18-${suffix}.synthetic.example` }),
    });
    assert.equal(linkDomain.status, 303);
    const trackingLink = await fetch(`${baseUrl}/dashboard/apps/${newAppId}/tracking-links`, {
      method: "POST",
      headers: { cookie: dashboardCookie, origin: configuredOrigin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrf_token: csrf,
        destination_kind: "play_store",
        destination_url: "https://play.google.com/store/apps/details?id=dev.openmasu.synthetic",
        play_package_name: "dev.openmasu.synthetic",
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

  it("WO13 creates tracking links for configured origins and rejects unconfigured origins", async () => {
    const dashboardCookie = cookie(await login(adminKeyA));
    const appPage = await fetch(`${baseUrl}/dashboard/apps/${appId}`, {
      headers: { cookie: dashboardCookie },
    });
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(await appPage.text())?.[1];
    assert.ok(csrf);
    const create = (destinationUrl: string) => fetch(`${baseUrl}/dashboard/apps/${appId}/tracking-links`, {
      method: "POST",
      headers: {
        cookie: dashboardCookie,
        origin: configuredOrigin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        csrf_token: csrf,
        destination_kind: "custom_https",
        destination_url: destinationUrl,
        campaign_id: "synthetic-allowlist-campaign",
      }),
    });

    const allowed = await create("https://links.synthetic.example/landing");
    assert.equal(allowed.status, 201);
    assert.match(await allowed.text(), /Tracking link created/);

    const rejected = await create("https://unlisted.synthetic.example/landing");
    assert.equal(rejected.status, 400);
    assert.match(await rejected.text(), /destination_origin_not_allowed/);

    const stored = await withTenant(appPool, tenantId, (client) => client.query<{ destination_url: string }>(
      `SELECT destination_url FROM control.tracking_links
       WHERE tenant_id=$1 AND app_id=$2 AND campaign_id='synthetic-allowlist-campaign'
       ORDER BY destination_url`,
      [tenantId, appId],
    ));
    assert.deepEqual(stored.rows.map((row) => row.destination_url), ["https://links.synthetic.example/landing"]);
  });

  it("WO18 rotates SDK keys and transitions tracking links with append-only audit history", async () => {
    const lifecycleApp = `lifecycle-${suffix}`;
    const headers = { authorization: `Bearer ${adminKeyA}`, "content-type": "application/json" };
    const registered = await fetch(`${baseUrl}/v1/admin/apps`, {
      method: "POST", headers, body: JSON.stringify({ app_id: lifecycleApp, sdk_platform: "android" }),
    });
    assert.equal(registered.status, 201);
    const first = await registered.json() as { sdk_key_id: string; sdk_key: string };

    const issued = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/sdk-keys`, {
      method: "POST", headers, body: JSON.stringify({ platform: "ios" }),
    });
    assert.equal(issued.status, 201);
    const second = await issued.json() as { sdk_key_id: string; sdk_key: string; platform: string };
    assert.equal(second.platform, "ios");
    assert.notEqual(second.sdk_key, first.sdk_key);

    const listed = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/sdk-keys`, { headers });
    assert.equal(listed.status, 200);
    const listText = await listed.text();
    const list = JSON.parse(listText) as { data: Array<{ sdk_key_id: string; status: string }> };
    assert.equal(list.data.length, 2);
    assert.equal(list.data.every((key) => key.status === "active"), true);
    assert.equal(listText.includes(first.sdk_key), false);
    assert.equal(listText.includes(second.sdk_key), false);
    assert.equal(listText.includes("secret_ref"), false);

    const overlap = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/sdk-keys`, {
      method: "POST", headers, body: JSON.stringify({ platform: "android" }),
    });
    assert.equal(overlap.status, 409);
    assert.deepEqual(await overlap.json(), { error: "sdk_key_overlap_limit_reached" });

    const retire = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/sdk-keys/${encodeURIComponent(first.sdk_key_id)}/retire`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(retire.status, 200);
    const lastActive = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/sdk-keys/${encodeURIComponent(second.sdk_key_id)}/retire`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(lastActive.status, 409);
    assert.deepEqual(await lastActive.json(), { error: "last_active_sdk_key" });

    const link = await fetch(`${baseUrl}/v1/admin/tracking-links`, {
      method: "POST", headers, body: JSON.stringify({
        app_id: lifecycleApp,
        destination_kind: "custom_https",
        destination_url: "https://links.synthetic.example/lifecycle",
        campaign_id: "synthetic-lifecycle",
      }),
    });
    assert.equal(link.status, 201);
    const linkBody = await link.json() as { tracking_link_id: string };
    const pause = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/tracking-links/${encodeURIComponent(linkBody.tracking_link_id)}/pause`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(pause.status, 200);
    const archive = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/tracking-links/${encodeURIComponent(linkBody.tracking_link_id)}/archive`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(archive.status, 200);
    const repeated = await fetch(`${baseUrl}/v1/admin/apps/${lifecycleApp}/tracking-links/${encodeURIComponent(linkBody.tracking_link_id)}/archive`, {
      method: "POST", headers, body: "{}",
    });
    assert.equal(repeated.status, 409);

    const history = await withTenant(appPool, tenantId, async (client) => {
      const states = await client.query<{ status: string }>(
        `SELECT status FROM control.tracking_link_states
          WHERE tenant_id=$1 AND app_id=$2 AND tracking_link_id=$3
          ORDER BY tracking_link_state_seq`,
        [tenantId, lifecycleApp, linkBody.tracking_link_id],
      );
      const audits = await client.query<{ action: string; row_text: string }>(
        `SELECT action, row_to_json(audit_logs)::text AS row_text FROM ledger.audit_logs
          WHERE tenant_id=$1 AND app_id=$2
            AND action IN ('sdk_key_issued','sdk_key_retired','tracking_link_paused','tracking_link_archived')
          ORDER BY occurred_at, audit_log_id`,
        [tenantId, lifecycleApp],
      );
      return { states: states.rows, audits: audits.rows };
    });
    assert.deepEqual(history.states.map((state) => state.status), ["active", "paused", "archived"]);
    assert.equal(history.audits.some((audit) => audit.row_text.includes(first.sdk_key) || audit.row_text.includes(second.sdk_key)), false);
    assert.equal(history.audits.some((audit) => audit.action === "sdk_key_retired"), true);
    assert.equal(history.audits.some((audit) => audit.action === "tracking_link_paused"), true);
    assert.equal(history.audits.some((audit) => audit.action === "tracking_link_archived"), true);
  });
});
