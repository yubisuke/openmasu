import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { M3_METRIC_DEFINITIONS } from "@openmasu/contracts/definitions";
import { createAppPool, createReaderPool, EncryptedFilePayloadStore, withTenant } from "@openmasu/runtime";
import { processSdkInbox } from "../apps/worker/src/sdk-worker.js";
import { computeSqlMetricRuns } from "../apps/worker/src/metrics/cohort.js";
import { ensureAdminKeys } from "../apps/api/src/admin-auth.js";
import { createRequestHandler } from "../apps/api/src/router.js";
import { KeyedTokenBucket } from "../apps/api/src/rate-limit.js";
import { csrfToken, issueDashboardSession } from "../apps/api/src/session.js";

// Dedicated opt-in gate: never run a Gradle consumer from the normal integration
// glob. Its database must be explicitly disposable and local, not a .env fallback.
it("published_native_sdk_reaches_durable_ledger_daily_metric_and_saved_csv", { timeout: 720_000 }, async () => {
  assert.equal(process.env.OPENMASU_SYNTHETIC_ONBOARDING, "1", "use an explicitly disposable synthetic database");
  for (const connection of [process.env.OPENMASU_APP_DATABASE_URL, process.env.OPENMASU_READER_DATABASE_URL]) {
    const url = new URL(connection ?? "");
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "only loopback databases are permitted");
    assert.equal(url.pathname, "/openmasu_sdk_synthetic", "use the dedicated disposable onboarding database");
  }
  const bundle = resolve(process.env.OPENMASU_PUBLISHED_SDK_BUNDLE ?? "missing-published-sdk-bundle");
  const manifest = JSON.parse(readFileSync(join(bundle, "release-manifest.json"), "utf8")) as { version: string; source_revision: string };
  if (process.env.OPENMASU_PUBLISHED_SDK_VERSION) {
    assert.equal(manifest.version, process.env.OPENMASU_PUBLISHED_SDK_VERSION, "downloaded SDK must match the selected release");
  }
  const suffix = randomBytes(6).toString("hex"), tenantId = `tenant-sdk-consumer-${suffix}`, appId = `app-sdk-consumer-${suffix}`;
  const adminKey = `synthetic-admin-${randomBytes(32).toString("base64url")}`;
  const root = mkdtempSync(join(tmpdir(), "openmasu-published-sdk-"));
  const payloadStore = new EncryptedFilePayloadStore(root, `synthetic-master-${randomBytes(32).toString("base64url")}`);
  const pool = createAppPool(), readerPool = createReaderPool();
  const server = createServer(createRequestHandler({ pool, readerPool, payloadStore,
    maxConfig: { tenantId, appId, pathSecret: "synthetic-disabled-path", eventKey: "synthetic-disabled-event",
      tokenMode: "all_with_event_fallback", maxParameters: 40, maxQueryBytes: 8192 },
    publicBaseUrl: "http://localhost:8080", redirectorBaseUrl: "http://localhost:8090",
    dashboard: { enabled: true, publicBaseUrl: "http://localhost:8080", tenantId, sessionTtlSeconds: 43_200 },
    sdk: { pool, payloadStore,
      config: { tenantId, appId, timestampSkewMs: 300_000, nonceTtlMs: 900_000,
        installationDigestKey: `synthetic-digest-${randomBytes(32).toString("base64url")}` },
      maximumBytes: 65536, maximumEvents: 100,
      enrollmentBucket: new KeyedTokenBucket(100, 100), installationBucket: new KeyedTokenBucket(100, 100),
      appBucket: new KeyedTokenBucket(100, 100), privacyBucket: new KeyedTokenBucket(100, 100) },
  }));
  try {
    const [keyId] = await ensureAdminKeys(pool, { tenantId, appId: `bootstrap-${suffix}` }, [adminKey]);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const registered = await fetch(`${base}/v1/admin/apps`, { method: "POST",
      headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, sdk_platform: "android" }) });
    assert.equal(registered.status, 201);
    const key = await registered.json() as { sdk_key_id: string; sdk_key: string };
    const empty = await withTenant(readerPool, tenantId, client => client.query(
      "SELECT count(*)::int AS count FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId]));
    assert.equal(empty.rows[0].count, 0);

    // Nonblocking child: this same Node process must serve the native SDK's HTTP
    // requests. The consumer signs and constructs every event using public AARs.
    await new Promise<void>((done, reject) => {
      const child = spawn(process.env.PYTHON ?? "python", ["tools/run-published-sdk-consumer.py", "--bundle", bundle, "--endpoint", base], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, OPENMASU_SYNTHETIC_SDK_KEY_ID: key.sdk_key_id, OPENMASU_SYNTHETIC_SDK_SECRET: key.sdk_key },
      });
      child.stdout.on("data", chunk => process.stdout.write(chunk));
      child.stderr.on("data", chunk => process.stderr.write(chunk));
      child.once("error", reject);
      child.once("exit", code => code === 0 ? done() : reject(new Error(`published SDK consumer failed: ${code}`)));
    });

    let processed = 0, slice = 0;
    do { slice = await processSdkInbox(pool, payloadStore, tenantId); processed += slice; } while (slice > 0 && processed < 20);
    assert.ok(processed > 0 && processed < 20);
    const evidence = await withTenant(readerPool, tenantId, async client => {
      const records = await client.query<{ event_name: string; producer: string; producer_version: string; occurred_at: string }>(
        "SELECT event_name,producer,producer_version,occurred_at FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2 ORDER BY event_name", [tenantId, appId]);
      const rejected = await client.query("SELECT count(*)::int AS count FROM ledger.rejections WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId]);
      const logical = await client.query("SELECT count(*)::int AS count FROM ledger.logical_events WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId]);
      const batches = await client.query("SELECT status FROM ledger.ingest_batches_current WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId]);
      assert.equal(rejected.rows[0].count, 0);
      assert.equal(logical.rows[0].count, 5);
      assert.ok(batches.rows.every(row => row.status === "processed"));
      return records.rows;
    });
    assert.deepEqual(evidence.map(row => row.event_name), ["consent_changed", "custom_event", "install", "purchase", "session_start"]);
    assert.ok(evidence.every(row => row.producer === "sdk-android" && row.producer_version === manifest.version));
    assert.equal(await processSdkInbox(pool, payloadStore, tenantId), 0, "completed batches are not projected twice");

    const day = evidence.find(row => row.event_name === "install")!.occurred_at.slice(0, 10);
    const watermark = new Date().toISOString();
    const runs = await computeSqlMetricRuns(pool, { contract_version: "0.4.0",
      fx_policy: { policy_version: "synthetic-sdk-onboarding", target_currency: "USD", target_scale: 6,
        rounding_mode: "half_even", rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0,
          source: "synthetic-identity", as_of: watermark }] },
      metric_definitions: M3_METRIC_DEFINITIONS,
      metric_evaluations: [{ metric_run_id_prefix: `sdk-consumer:${suffix}`, metric_names: ["daily_install_count"],
        grouping: { metric_date: day }, input_received_at_watermark: watermark, computed_at: watermark,
        // Complete for this receipt cutoff, not a claim that today's calendar
        // window is closed or that a live source is complete.
        data_freshness: "complete", privacy_state: "after" }],
    }, true, { tenant_id: tenantId, app_id: appId });
    assert.equal(runs.length, 1); assert.equal(runs[0].value_unscaled, "1");
    const session = await issueDashboardSession(pool, tenantId, keyId!, 43_200);
    const cookie = `openmasu_dashboard=${session.token}`;
    const dashboard = await fetch(`${base}/dashboard/apps/${appId}?metric_name=daily_install_count`, { headers: { cookie } });
    assert.equal(dashboard.status, 200); assert.match(await dashboard.text(), /data-value-unscaled="1"/);
    const nextDay = new Date(Date.parse(`${day}T00:00:00.000Z`) + 86400000).toISOString().slice(0, 10);
    const form = new URLSearchParams({ csrf_token: csrfToken(session.token), name: "Synthetic published SDK",
      metric_name: "daily_install_count", date_from: day, date_to: nextDay, watermark_at_most: watermark, display: "all" });
    const saved = await fetch(`${base}/dashboard/apps/${appId}/analyses`, { method: "POST", redirect: "manual",
      headers: { cookie, origin: "http://localhost:8080" }, body: form });
    assert.equal(saved.status, 303);
    const location = saved.headers.get("location")!;
    const view = await fetch(`${base}${location}`, { headers: { cookie } });
    assert.equal(view.status, 200); assert.match(await view.text(), /daily_install_count/);
    const csv = await fetch(`${base}${location}.csv`, { headers: { cookie } });
    assert.equal(csv.status, 200); const text = await csv.text();
    assert.ok(text.includes(runs[0].metric_run_id)); assert.match(text, /daily_install_count/);
    console.log(JSON.stringify({ published_sdk_version: manifest.version, sdk_source_revision: manifest.source_revision,
      native_events: 5, rejected: 0, daily_install_count: "1", saved_analysis: "passed", csv: "passed", live_provider: "not_run" }));
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    await Promise.all([pool.end(), readerPool.end()]);
    rmSync(root, { recursive: true, force: true });
  }
});
