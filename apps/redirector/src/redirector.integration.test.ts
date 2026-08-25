import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  createAppPool,
  EncryptedFilePayloadStore,
  withTenant,
  type PayloadStore,
} from "@openmasu/runtime";
import { decodeInstallReferrer } from "@openmasu/redirector-core";
import { createTrackingLink } from "../../api/src/tracking-links.js";
import { registerAppLinkIdentity, registerLinkDomain } from "../../api/src/link-domains.js";
import { createRedirectorHandler } from "./handler.js";

const suffix = randomBytes(6).toString("hex");
const tenantId = `tenant-redirect-${suffix}`;
const appId = `app-redirect-${suffix}`;
const root = mkdtempSync(join(tmpdir(), "openmasu-redirect-"));
const pool = createAppPool();
const payloadStore = new EncryptedFilePayloadStore(root, `master-${randomBytes(32).toString("base64url")}`);
const fallback = "https://safe.example/fallback";
let baseUrl = "";
let server: ReturnType<typeof createServer>;
let slug = "";
let deepSlug = "";
const linkHost = `links-${suffix}.synthetic.example`;
const precedenceSlug = "well-known000";

async function fetchWithHost(baseUrl: string, path: string, host: string): Promise<Response> {
  const target = new URL(path, baseUrl);
  return new Promise<Response>((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers: { host, "user-agent": "Synthetic Android" },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500, headers }));
      });
    });
    request.on("error", reject);
    request.end();
  });
}

describe("M2a redirector HTTP shell", () => {
  before(async () => {
    await withTenant(pool, tenantId, (client) => client.query(
      `INSERT INTO control.apps (tenant_id, app_id, created_at)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, appId, new Date().toISOString()],
    ).then(() => undefined));
    const link = await createTrackingLink({
      pool, tenantId, appId, actorRef: "admin_key:synthetic-redirector-test", allowedOrigins: [],
      body: {
        destination_kind: "play_store",
        destination_url: "https://play.google.com/store/apps/details?id=invalid.placeholder",
        play_package_name: "dev.openmasu.synthetic",
        campaign_id: `campaign-${suffix}`,
      },
    });
    slug = link.slug;
    const deepLink = await createTrackingLink({
      pool, tenantId, appId, actorRef: "admin_key:synthetic-redirector-test", allowedOrigins: [],
      body: {
        destination_kind: "play_store",
        destination_url: "https://play.google.com/store/apps/details?id=invalid.placeholder",
        play_package_name: "dev.openmasu.synthetic",
        campaign_id: `campaign-deep-${suffix}`,
        deep_link_value: "/default/53",
        deep_link_param_names: ["code"],
      },
    });
    deepSlug = deepLink.slug;
    await withTenant(pool, tenantId, async (client) => {
      const trackingLinkId = `tracking-link:precedence:${suffix}`;
      await client.query(
        `INSERT INTO control.tracking_links (
           tracking_link_id, tenant_id, app_id, slug, destination_kind, destination_url,
           play_package_name, campaign_id, created_at, artifact
         ) VALUES ($1,$2,$3,$4,'play_store',$5,$6,$7,$8,$9::jsonb)`,
        [trackingLinkId, tenantId, appId, precedenceSlug,
          "https://play.google.com/store/apps/details?id=invalid.placeholder",
          "dev.openmasu.synthetic", `campaign-precedence-${suffix}`, "2026-08-19T01:58:00.000Z",
          JSON.stringify({ tracking_link_id: trackingLinkId, slug: precedenceSlug })],
      );
      await client.query(
        `INSERT INTO control.tracking_link_states (
           tracking_link_id, tenant_id, app_id, status, changed_at, artifact
         ) VALUES ($1,$2,$3,'active',$4,$5::jsonb)`,
        [trackingLinkId, tenantId, appId, "2026-08-19T01:58:01.000Z", JSON.stringify({ status: "active" })],
      );
    });
    await registerLinkDomain({
      pool,
      identity: { keyId: "synthetic-admin", tenantId, role: "admin" },
      host: linkHost,
      now: "2026-08-19T01:59:00.000Z",
    });
    const fingerprint = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0").toUpperCase()).join(":");
    await registerAppLinkIdentity({
      pool,
      identity: { keyId: "synthetic-admin", tenantId, appId, role: "admin" },
      body: {
        android_package_name: `dev.openmasu.synthetic.${suffix}`,
        android_sha256_fingerprints: [fingerprint],
        apple_team_id: "ABCDE12345",
        apple_bundle_id: `dev.openmasu.synthetic.${suffix}`,
      },
      now: "2026-08-19T01:59:01.000Z",
    });
    server = createServer(createRedirectorHandler({
      pool, payloadStore, tenantId, fallbackUrl: fallback, geoMode: "off",
      limiter: { allow: () => true },
      clock: () => new Date("2026-08-19T02:00:00.000Z"),
    }));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    await once(server, "close");
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  it("uses only the stored destination and round-trips one short referrer", async () => {
    const response = await fetch(`${baseUrl}/r/${slug}?destination=https://attacker.invalid&next=https://attacker.invalid`, {
      redirect: "manual",
      headers: { "user-agent": "Synthetic Android", location: "https://attacker.invalid" },
    });
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get("location")!);
    assert.equal(location.hostname, "play.google.com");
    assert.equal(location.searchParams.get("id"), "dev.openmasu.synthetic");
    const referrer = location.searchParams.get("referrer")!;
    assert.ok(Buffer.byteLength(referrer, "utf8") < 64);
    assert.match(decodeInstallReferrer(referrer).cid, /^[A-Za-z0-9_-]{22,128}$/);
  });

  it("DL-A-08 through DL-A-10 resolves tenant hosts and serves byte-stable public association files", async () => {
    const hosted = createServer(createRedirectorHandler({
      pool, payloadStore, tenantId: "unused-fixed-tenant", hostMode: "host_header",
      fallbackUrl: fallback, geoMode: "off", limiter: { allow: () => true },
      wellKnownLimiter: { allow: () => true }, wellKnownCacheSeconds: 53, wellKnownMaximumBytes: 131_072,
    }));
    hosted.listen(0, "127.0.0.1");
    await once(hosted, "listening");
    const hostedBase = `http://127.0.0.1:${(hosted.address() as AddressInfo).port}`;
    const get = (path: string, host = linkHost) => fetchWithHost(hostedBase, path, host);
    const assetlinks = await get("/.well-known/assetlinks.json");
    const assetBytes = Buffer.from(await assetlinks.arrayBuffer());
    const dotted = await get("/.well-known/assetlinks.json", `${linkHost}.`);
    assert.equal(assetlinks.status, 200);
    assert.equal(assetlinks.headers.get("content-type"), "application/json");
    assert.equal(assetlinks.headers.get("cache-control"), "public, max-age=53");
    assert.equal(assetlinks.headers.get("set-cookie"), null);
    assert.equal(assetlinks.headers.get("location"), null);
    assert.deepEqual(Buffer.from(await dotted.arrayBuffer()), assetBytes);
    assert.equal((JSON.parse(assetBytes.toString("utf8")) as any[])[0].target.namespace, "android_app");
    const aasa = await get("/.well-known/apple-app-site-association");
    assert.deepEqual((await aasa.json() as any).applinks.details[0].components, [{ "/": "/r/*" }]);
    assert.equal((await get("/.well-known/assetlinks.json", "unknown.synthetic.example")).status, 404);
    assert.equal((await get(`/r/${slug}/shop/item/53?dlp_code=abc`)).status, 302);
    assert.equal((await get(`/r/${precedenceSlug}`)).status, 302);

    const otherTenant = `tenant-other-${suffix}`;
    await withTenant(pool, otherTenant, (client) => client.query(
      `INSERT INTO control.apps (tenant_id, app_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [otherTenant, `app-other-${suffix}`, new Date().toISOString()],
    ).then(() => undefined));
    await assert.rejects(registerLinkDomain({
      pool, identity: { keyId: "synthetic-admin", tenantId: otherTenant, role: "admin" }, host: linkHost,
    }), /link_host_already_registered/);
    const otherHost = `links-other-${suffix}.synthetic.example`;
    await registerLinkDomain({
      pool, identity: { keyId: "synthetic-admin", tenantId: otherTenant, role: "admin" }, host: otherHost,
    });
    const otherBefore = await withTenant(pool, otherTenant, async (client) => (await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM ledger.ingest_batches WHERE tenant_id=$1",
      [otherTenant],
    )).rows[0].count);
    const crossTenant = await get(`/r/${slug}`, otherHost);
    assert.equal(crossTenant.headers.get("location"), fallback);
    const otherAfter = await withTenant(pool, otherTenant, async (client) => (await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM ledger.ingest_batches WHERE tenant_id=$1",
      [otherTenant],
    )).rows[0].count);
    assert.equal(otherAfter, otherBefore, "DL-A-10 cross-tenant slug lookup must not write a click batch");

    const denied = createServer(createRedirectorHandler({
      pool, payloadStore, tenantId: "unused-fixed-tenant", hostMode: "host_header",
      fallbackUrl: fallback, geoMode: "off", limiter: { allow: () => true },
      wellKnownLimiter: { allow: () => false },
    }));
    denied.listen(0, "127.0.0.1");
    await once(denied, "listening");
    const deniedBase = `http://127.0.0.1:${(denied.address() as AddressInfo).port}`;
    assert.equal((await fetchWithHost(deniedBase, "/.well-known/assetlinks.json", linkHost)).status, 429);
    denied.close();
    await once(denied, "close");

    const oversized = createServer(createRedirectorHandler({
      pool, payloadStore, tenantId: "unused-fixed-tenant", hostMode: "host_header",
      fallbackUrl: fallback, geoMode: "off", limiter: { allow: () => true },
      wellKnownLimiter: { allow: () => true }, wellKnownMaximumBytes: 1,
    }));
    oversized.listen(0, "127.0.0.1");
    await once(oversized, "listening");
    const oversizedBase = `http://127.0.0.1:${(oversized.address() as AddressInfo).port}`;
    assert.equal((await fetchWithHost(oversizedBase, "/.well-known/assetlinks.json", linkHost)).status, 503);
    oversized.close();
    await once(oversized, "close");
    hosted.close();
    await once(hosted, "close");
  });

  it("DL-A-04, DL-A-05, DL-A-11, and DL-A-13 keep request input bounded", async () => {
    const request = (path: string, userAgent = "Synthetic Android") => fetch(`${baseUrl}${path}`, {
      redirect: "manual", headers: { "user-agent": userAgent },
    });
    const baseline = await request(`/r/${deepSlug}/direct/53?dlp_code=abc`);
    const injected = await request(`/r/${deepSlug}/direct/53?dlp_code=abc&destination=https://attacker.invalid&url=https://attacker.invalid&next=https://attacker.invalid&dl=/attacker&dlp_unknown=x`);
    const baselineLocation = new URL(baseline.headers.get("location")!);
    const injectedLocation = new URL(injected.headers.get("location")!);
    assert.equal(injectedLocation.origin + injectedLocation.pathname, baselineLocation.origin + baselineLocation.pathname);
    assert.equal(injectedLocation.searchParams.get("id"), baselineLocation.searchParams.get("id"));
    const decoded = decodeInstallReferrer(injectedLocation.searchParams.get("referrer")!);
    assert.equal(decoded.dl, "/direct/53");
    assert.equal(decoded.dlp_code, "abc");
    assert.equal(decoded.dlp_unknown, undefined);
    const invalidParameter = await request(`/r/${deepSlug}/direct/53?dlp_code=space%20value`);
    assert.equal(decodeInstallReferrer(new URL(invalidParameter.headers.get("location")!).searchParams.get("referrer")!).dlp_code, undefined);
    assert.equal((await request(`/r/${deepSlug}/direct/53`, "Synthetic iPhone")).headers.get("location"), fallback);
    const destinationless = await request(`/r/${slug}`);
    assert.deepEqual(Object.keys(decodeInstallReferrer(new URL(destinationless.headers.get("location")!).searchParams.get("referrer")!)).sort(), ["cid", "omv"]);

    const bounded = createServer(createRedirectorHandler({
      pool, payloadStore, tenantId, fallbackUrl: fallback, geoMode: "off",
      limiter: { allow: () => true }, referrerMaximumEncodedCharacters: 54,
    }));
    bounded.listen(0, "127.0.0.1");
    await once(bounded, "listening");
    const boundedBase = `http://127.0.0.1:${(bounded.address() as AddressInfo).port}`;
    const omitted = await fetch(`${boundedBase}/r/${deepSlug}/direct/53?dlp_code=abc`, { redirect: "manual", headers: { "user-agent": "Synthetic Android" } });
    const omittedReferrer = decodeInstallReferrer(new URL(omitted.headers.get("location")!).searchParams.get("referrer")!);
    assert.match(omittedReferrer.cid, /^[A-Za-z0-9_-]{22,128}$/);
    assert.equal(omittedReferrer.dl, undefined);
    bounded.close();
    await once(bounded, "close");
  });

  it("returns byte-identical fallbacks for unknown, paused, archived, and internal-error paths", async () => {
    const request = async (path: string) => {
      const response = await fetch(`${baseUrl}${path}`, { redirect: "manual", headers: { "user-agent": "Synthetic Android" } });
      return {
        status: response.status,
        // Node adds a wall-clock Date header outside the application response.
        headers: [...response.headers.entries()].filter(([name]) => name !== "date").sort(),
        body: await response.text(),
      };
    };
    const unknown = await request("/r/UnknownSlug0_");
    await withTenant(pool, tenantId, (client) => client.query(
      `INSERT INTO control.tracking_link_states (
        tracking_link_id, tenant_id, app_id, status, changed_at, artifact
      ) SELECT tracking_link_id, tenant_id, app_id, 'paused', $3, $4::jsonb
        FROM control.tracking_links WHERE tenant_id=$1 AND slug=$2`,
      [tenantId, slug, new Date().toISOString(), JSON.stringify({ status: "paused" })],
    ).then(() => undefined));
    assert.deepEqual(await request(`/r/${slug}`), unknown);
    await withTenant(pool, tenantId, (client) => client.query(
      `INSERT INTO control.tracking_link_states (
        tracking_link_id, tenant_id, app_id, status, changed_at, artifact
      ) SELECT tracking_link_id, tenant_id, app_id, 'archived', $3, $4::jsonb
        FROM control.tracking_links WHERE tenant_id=$1 AND slug=$2`,
      [tenantId, slug, new Date().toISOString(), JSON.stringify({ status: "archived" })],
    ).then(() => undefined));
    assert.deepEqual(await request(`/r/${slug}`), unknown);

    const failingStore: PayloadStore = {
      ...payloadStore,
      write: async () => { throw new Error("synthetic persistence failure"); },
      read: (reference) => payloadStore.read(reference),
      purge: (reference) => payloadStore.purge(reference),
      scanFor: (value) => payloadStore.scanFor(value),
    };
    await withTenant(pool, tenantId, (client) => client.query(
      `INSERT INTO control.tracking_link_states (
        tracking_link_id, tenant_id, app_id, status, changed_at, artifact
      ) SELECT tracking_link_id, tenant_id, app_id, 'active', $3, $4::jsonb
        FROM control.tracking_links WHERE tenant_id=$1 AND slug=$2`,
      [tenantId, slug, new Date().toISOString(), JSON.stringify({ status: "active" })],
    ).then(() => undefined));
    const errorServer = createServer(createRedirectorHandler({
      pool, payloadStore: failingStore, tenantId, fallbackUrl: fallback, geoMode: "off",
      limiter: { allow: () => true },
    }));
    errorServer.listen(0, "127.0.0.1");
    await once(errorServer, "listening");
    const errorBase = `http://127.0.0.1:${(errorServer.address() as AddressInfo).port}`;
    const response = await fetch(`${errorBase}/r/${slug}`, { redirect: "manual", headers: { "user-agent": "Synthetic Android" } });
    const internal = {
      status: response.status,
      headers: [...response.headers.entries()].filter(([name]) => name !== "date").sort(),
      body: await response.text(),
    };
    errorServer.close();
    await once(errorServer, "close");
    assert.deepEqual(internal, unknown);
  });

  it("fails closed at link creation and never persists the source IP", async () => {
    await assert.rejects(createTrackingLink({
      pool, tenantId, appId, actorRef: "admin_key:synthetic-redirector-test", allowedOrigins: [],
      body: { destination_kind: "custom_https", destination_url: "https://attacker.invalid/" },
    }), /destination_origin_not_allowed/);
    const databaseContainsIp = await withTenant(pool, tenantId, async (client) => {
      const columns = await client.query<{ table_schema: string; table_name: string; column_name: string }>(
        `SELECT table_schema, table_name, column_name
         FROM information_schema.columns
         WHERE table_schema IN ('control','ledger','ephemeral')
           AND data_type IN ('text','character varying','json','jsonb')
           AND has_table_privilege(
             quote_ident(table_schema) || '.' || quote_ident(table_name),
             'SELECT'
           )
         ORDER BY table_schema, table_name, ordinal_position`,
      );
      const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
      for (const column of columns.rows) {
        const result = await client.query<{ found: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM ${identifier(column.table_schema)}.${identifier(column.table_name)}
             WHERE ${identifier(column.column_name)}::text LIKE $1
           ) AS found`, ["%127.0.0.1%"],
        );
        if (result.rows[0].found) return true;
      }
      return false;
    });
    assert.equal(databaseContainsIp, false);
    assert.equal(await payloadStore.scanFor("127.0.0.1"), false);
    const bodyRef = await withTenant(pool, tenantId, async (client) => (await client.query<{ body_ref: string }>(
      `SELECT body_ref FROM ledger.ingest_batches
       WHERE tenant_id=$1 AND app_id=$2 AND producer='redirector'
       ORDER BY inbox_seq DESC LIMIT 1`, [tenantId, appId],
    )).rows[0].body_ref);
    const stored = JSON.parse((await payloadStore.read(bodyRef)).toString("utf8")) as { records: Array<{ payload: Record<string, unknown> }> };
    assert.equal(stored.records[0].payload.country, undefined);

    const limited = createServer(createRedirectorHandler({
      pool, payloadStore, tenantId, fallbackUrl: fallback, geoMode: "off", limiter: { allow: () => false },
    }));
    limited.listen(0, "127.0.0.1");
    await once(limited, "listening");
    const limitedBase = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${limitedBase}/r/${slug}`, { redirect: "manual", headers: { "user-agent": "Synthetic Android" } })).status, 429);
    limited.close();
    await once(limited, "close");
  });
});
