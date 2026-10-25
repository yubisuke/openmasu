import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { REFERENCE_AD_REVENUE_METRIC_DEFINITIONS } from "@openmasu/contracts/definitions";
import { createAppPool, createReaderPool, EncryptedFilePayloadStore, withTenant } from "@openmasu/runtime";
import { processSdkInbox } from "../apps/worker/src/sdk-worker.js";
import { computeSqlMetricRuns } from "../apps/worker/src/metrics/cohort.js";
import { ensureAdminKeys } from "../apps/api/src/admin-auth.js";
import { createRequestHandler } from "../apps/api/src/router.js";
import { KeyedTokenBucket } from "../apps/api/src/rate-limit.js";

// Source-SDK seam, deliberately outside the ordinary integration glob. The same
// observations go from the managed provider shim into the shipping JNI bridge,
// reopened Room queue, signed loopback HTTP admission and real PostgreSQL worker.
it("levelplay_callback_room_queue_signed_ingest_worker_and_ad_revenue_cohort", { timeout: 600_000 }, async () => {
  assert.equal(process.env.OPENMASU_SYNTHETIC_LEVELPLAY, "1");
  for (const connection of [process.env.OPENMASU_APP_DATABASE_URL, process.env.OPENMASU_READER_DATABASE_URL]) {
    const url = new URL(connection ?? "");
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.equal(url.pathname, "/openmasu_levelplay_synthetic");
  }
  const suffix = randomBytes(6).toString("hex"), tenantId = `tenant-ilr-${suffix}`, appId = `app-ilr-${suffix}`;
  const adminKey = `synthetic-admin-${randomBytes(32).toString("base64url")}`;
  const root = mkdtempSync(join(tmpdir(), "openmasu-levelplay-"));
  const payloadStore = new EncryptedFilePayloadStore(root, `synthetic-master-${randomBytes(32).toString("base64url")}`);
  const pool = createAppPool(), readerPool = createReaderPool();
  const bucket = () => new KeyedTokenBucket(100, 100);
  const server = createServer(createRequestHandler({ pool, readerPool, payloadStore,
    maxConfig: { tenantId, appId, pathSecret: "synthetic-disabled-path", eventKey: "synthetic-disabled-event",
      tokenMode: "all_with_event_fallback", maxParameters: 40, maxQueryBytes: 8192 },
    publicBaseUrl: "http://localhost:8080", redirectorBaseUrl: "http://localhost:8090",
    dashboard: { enabled: false, publicBaseUrl: "http://localhost:8080", tenantId, sessionTtlSeconds: 43_200 },
    sdk: { pool, payloadStore, config: { tenantId, appId, timestampSkewMs: 300_000, nonceTtlMs: 900_000,
      installationDigestKey: `synthetic-digest-${randomBytes(32).toString("base64url")}` },
      maximumBytes: 65536, maximumEvents: 100,
      enrollmentBucket: bucket(), installationBucket: bucket(), appBucket: bucket(), privacyBucket: bucket() },
  }));
  async function command(file: string, args: string[], env = process.env): Promise<void> {
    await new Promise<void>((done, reject) => {
      const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
      // These commands contain only synthetic inputs. Never put SDK credentials in argv.
      child.stdout.on("data", chunk => process.stdout.write(chunk));
      child.stderr.on("data", chunk => process.stderr.write(chunk));
      child.once("error", reject);
      child.once("exit", code => code === 0 ? done() : reject(new Error(`source SDK command failed: ${code}`)));
    });
  }
  try {
    await ensureAdminKeys(pool, { tenantId, appId: `bootstrap-${suffix}` }, [adminKey]);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const registration = await fetch(`${base}/v1/admin/apps`, { method: "POST",
      headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, sdk_platform: "android" }) });
    assert.equal(registration.status, 201);
    const key = await registration.json() as { sdk_key_id: string; sdk_key: string };
    const input = join(root, "synthetic-callbacks.json");
    await command("dotnet", ["run", "--project", "sdk/unity/tests/UnityCompileProbe.csproj", "--configuration", "Release",
      "--", "--levelplay-export", input]);
    await command(resolve("sdk/android/gradlew"), ["-p", "sdk/android", ":unitybridge:cleanTestDebugUnitTest",
      ":unitybridge:testDebugUnitTest", "--tests", "dev.openmasu.unity.AdRevenueQueueTest.callbackObservationsSurviveRoomReopenAndDeliverOnlyThreeImpressions", "--no-daemon", "--no-build-cache"],
    { ...process.env, OPENMASU_LEVELPLAY_INPUT: input, OPENMASU_LEVELPLAY_ENDPOINT: base,
      OPENMASU_LEVELPLAY_KEY_ID: key.sdk_key_id, OPENMASU_LEVELPLAY_SECRET: key.sdk_key });
    let processed = 0, slice = 0;
    do { slice = await processSdkInbox(pool, payloadStore, tenantId); processed += slice; } while (slice > 0 && processed < 20);
    assert.ok(processed > 0 && processed < 20);
    const evidence = await withTenant(readerPool, tenantId, async client => {
      const result = await client.query<{ event_name: string; occurred_at: string; artifact: Record<string, any> }>(
        "SELECT event_name,occurred_at,artifact FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId]);
      const facts = await client.query<{ amount_unscaled: string; revenue_source: string; impression_id: string }>(
        "SELECT amount_unscaled,revenue_source,impression_id FROM ledger.ad_revenue_facts WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId]);
      assert.equal(facts.rows.length, 3);
      assert.equal(new Set(facts.rows.map(row => row.impression_id)).size, 3);
      assert.ok(facts.rows.every(row => row.revenue_source === "client_estimated"));
      assert.equal(facts.rows.reduce((sum, row) => sum + BigInt(row.amount_unscaled), 0n), 2_000_000n);
      const rejected = await client.query("SELECT count(*)::int AS count FROM ledger.rejections WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId]);
      assert.equal(rejected.rows[0].count, 0);
      return result.rows;
    });
    const revenue = evidence.filter(row => row.event_name === "ad_revenue");
    assert.equal(revenue.length, 3, "four callbacks must not become four logical impressions");
    assert.equal(new Set(revenue.map(row => row.artifact.event_id)).size, 3);
    assert.equal(await processSdkInbox(pool, payloadStore, tenantId), 0);
    const day = evidence.find(row => row.event_name === "install")!.occurred_at.slice(0, 10);
    const watermark = new Date().toISOString();
    const runs = await computeSqlMetricRuns(pool, { contract_version: "0.4.0",
      fx_policy: { policy_version: "synthetic-levelplay", target_currency: "USD", target_scale: 6,
        rounding_mode: "half_even", rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0,
          source: "synthetic-identity", as_of: watermark }] },
      metric_definitions: [...REFERENCE_AD_REVENUE_METRIC_DEFINITIONS],
      metric_evaluations: [{ metric_run_id_prefix: `levelplay:${suffix}`,
        metric_names: ["d0_install_to_24h_ad_revenue_usd"], grouping: { cohort_date: day },
        input_received_at_watermark: watermark, computed_at: watermark, data_freshness: "partial", privacy_state: "after" }],
    }, true, { tenant_id: tenantId, app_id: appId });
    assert.equal(runs.length, 1); assert.equal(runs[0].value_unscaled, "2000000");
    console.log("LevelPlay source SDK journey passed: callback shim=4, Room unique/reopened=3, signed admission=accepted, worker=3, ad revenue cohort USD micros=2000000; actual provider/device=not_run");
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
    await Promise.all([pool.end(), readerPool.end()]);
    rmSync(root, { recursive: true, force: true });
  }
});
