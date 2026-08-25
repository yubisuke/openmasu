import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  createAppPool,
  EncryptedFilePayloadStore,
  withTenant,
} from "@openmasu/runtime";
import { createRequestHandler } from "../../api/src/router.js";
import { KeyedTokenBucket } from "../../api/src/rate-limit.js";
import { ensureSdkKeys, signSdkRequest } from "../../api/src/sdk-auth.js";
import { processAdServicesLookups } from "./adservices-worker.js";
import { listRuntimeWorkTenants, processSdkInbox } from "./sdk-worker.js";

const run = randomBytes(6).toString("hex");
const tenantId = `tenant-m4-adservices-${run}`;
const appId = `app-m4-adservices-${run}`;
const sdkKeyId = `sdk-key-ios-${run}`;
const sdkSecret = `sdk-secret-${randomBytes(32).toString("base64url")}`;
const masterKey = `master-${randomBytes(32).toString("base64url")}`;
const digestKey = `digest-${randomBytes(32).toString("base64url")}`;
const root = mkdtempSync(join(tmpdir(), "openmasu-m4-adservices-"));
const pool = createAppPool();
const payloadStore = new EncryptedFilePayloadStore(root, masterKey);
const authConfig = {
  tenantId,
  appId,
  timestampSkewMs: 300_000,
  nonceTtlMs: 900_000,
  installationDigestKey: digestKey,
};
let server: ReturnType<typeof createServer>;
let baseUrl = "";

async function signed(input: {
  readonly path: string;
  readonly value: unknown;
  readonly secret: string;
  readonly installationKeyId?: string;
}): Promise<Response> {
  const body = Buffer.from(JSON.stringify(input.value), "utf8");
  const timestampMs = Date.now();
  const nonce = randomBytes(18).toString("base64url");
  const signature = signSdkRequest(input.secret, {
    method: "POST",
    path: input.path,
    sdkKeyId,
    installationKeyId: input.installationKeyId,
    timestampMs,
    nonce,
    body,
  });
  return fetch(`${baseUrl}${input.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openmasu-sdk-key-id": sdkKeyId,
      "x-openmasu-installation-key-id": input.installationKeyId ?? "-",
      "x-openmasu-timestamp-ms": String(timestampMs),
      "x-openmasu-nonce": nonce,
      "x-openmasu-signature": signature,
    },
    body,
  });
}

async function enroll(label: string): Promise<{
  installationId: string;
  installationKeyId: string;
  installationSecret: string;
}> {
  const installationId = `installation:m4-${label}-${run}`;
  const response = await signed({
    path: "/v1/installations",
    value: { installation_id: installationId },
    secret: sdkSecret,
  });
  assert.equal(response.status, 201);
  const value = await response.json() as Record<string, string>;
  return {
    installationId,
    installationKeyId: value.installation_key_id,
    installationSecret: value.installation_secret,
  };
}

function installEvent(label: string, installationId: string, value: Record<string, unknown>): Record<string, unknown> {
  return {
    producer_version: "synthetic-m4-ios",
    event_id: `event:m4-adservices-${label}-${run}`,
    event_name: "install",
    occurred_at: "2026-08-20T12:00:00.000Z",
    occurred_at_source: "device",
    processing_sequence: 1,
    payload: {
      event_name: "install",
      installation_id: installationId,
      install_type: "first_install",
      install_origin: "ios_first_launch",
      referrer_status: "not_applicable",
      ...value,
    },
  };
}

async function submitInstall(label: string, token: string): Promise<{
  installationId: string;
  installationKeyId: string;
  installationSecret: string;
  recordId: string;
}> {
  const credential = await enroll(label);
  const response = await signed({
    path: "/v1/events/batch",
    value: {
      records: [installEvent(label, credential.installationId, {
        extensions: { adservices_attribution_token_protected: token },
      })],
    },
    secret: credential.installationSecret,
    installationKeyId: credential.installationKeyId,
  });
  assert.equal(response.status, 202);
  await processSdkInbox(pool, payloadStore, tenantId);
  const raw = await withTenant(pool, tenantId, (client) => client.query<{
    record_id: string;
    artifact_text: string;
  }>(
    `SELECT record_id, artifact::text AS artifact_text
     FROM ledger.raw_records WHERE tenant_id=$1 AND app_id=$2 AND event_id=$3`,
    [tenantId, appId, `event:m4-adservices-${label}-${run}`],
  ));
  assert.equal(raw.rows.length, 1);
  assert.equal(raw.rows[0].artifact_text.includes(token), false);
  assert.equal(await payloadStore.scanFor(token), false, "raw token appeared outside encrypted payload bytes");
  return {
    installationId: credential.installationId,
    installationKeyId: credential.installationKeyId,
    installationSecret: credential.installationSecret,
    recordId: raw.rows[0].record_id,
  };
}

describe("M4 AdServices server-side lookup", () => {
  before(async () => {
    await ensureSdkKeys(pool, payloadStore, { tenantId, appId }, [
      { keyId: sdkKeyId, secret: sdkSecret, platform: "ios" },
    ]);
    server = createServer(createRequestHandler({
      pool,
      readerPool: pool,
      payloadStore,
      maxConfig: {
        tenantId,
        appId,
        pathSecret: "synthetic-m4-path",
        eventKey: "synthetic-m4-key",
        tokenMode: "all_with_event_fallback",
        maxParameters: 40,
        maxQueryBytes: 8_192,
      },
      publicBaseUrl: "http://localhost:8080",
      redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: false, publicBaseUrl: "http://localhost:8080", tenantId, sessionTtlSeconds: 43_200 },
      sdk: {
        pool,
        payloadStore,
        config: authConfig,
        maximumBytes: 128 * 1024,
        maximumEvents: 100,
        enrollmentBucket: new KeyedTokenBucket(100, 100),
        installationBucket: new KeyedTokenBucket(100, 100),
        appBucket: new KeyedTokenBucket(100, 100),
        privacyBucket: new KeyedTokenBucket(100, 100),
      },
    }));
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    server.close();
    await new Promise<void>((resolve) => server.once("close", () => resolve()));
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  it("A09 rejects a device-supplied parsed claim before durable insertion", async () => {
    const credential = await enroll("forged-claim");
    const response = await signed({
      path: "/v1/events/batch",
      value: {
        records: [installEvent("forged-claim", credential.installationId, {
          adservices_context: { status: "attributed", attribution: true, campaign_id: "123" },
        })],
      },
      secret: credential.installationSecret,
      installationKeyId: credential.installationKeyId,
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "device_adservices_claim_forbidden" });

    const nested = await signed({
      path: "/v1/events/batch",
      value: {
        records: [installEvent("forged-claim-nested", credential.installationId, {
          extensions: {
            adservices_context: { status: "attributed", attribution: true, campaign_id: "123" },
          },
        })],
      },
      secret: credential.installationSecret,
      installationKeyId: credential.installationKeyId,
    });
    assert.equal(nested.status, 403);
    assert.deepEqual(await nested.json(), { error: "device_adservices_claim_forbidden" });
  });

  it("A08 derives an immutable superseding attribution from a protected raw token", async () => {
    const token = `synthetic-adservices-token-${randomBytes(32).toString("base64url")}`;
    const install = await submitInstall("attributed", token);
    assert.ok((await listRuntimeWorkTenants(pool)).includes(tenantId));
    let observedToken = "";
    const outcome = await processAdServicesLookups(pool, payloadStore, tenantId, {
      endpoint: "http://127.0.0.1/apple-adservices",
      client: async (request) => {
        observedToken = request.token;
        assert.deepEqual(Object.keys(request).sort(), ["endpoint", "token"]);
        return {
          status: 200,
          body: Buffer.from(JSON.stringify({
            attribution: true,
            orgId: 1,
            campaignId: 2,
            conversionType: "Download",
            claimType: "Click",
            countryOrRegion: "US",
          })),
        };
      },
    });
    assert.deepEqual(outcome, { completed: 1, retried: 0 });
    assert.equal(observedToken, token);
    const replacement = await withTenant(pool, tenantId, (client) => client.query<{
      artifact: Record<string, unknown>;
    }>(
      `SELECT artifact FROM ledger.attribution_results
       WHERE tenant_id=$1 AND app_id=$2 AND subject_ref=$3
         AND reason_code='adservices_attributed'`,
      [tenantId, appId, install.installationId],
    ));
    assert.equal(replacement.rows.length, 1);
    assert.equal(replacement.rows[0].artifact.method, "apple_adservices");
    assert.equal(typeof replacement.rows[0].artifact.supersedes_attribution_id, "string");
    const stored = await withTenant(pool, tenantId, (client) => client.query<{
      response_ref: string;
      status: string;
      artifact: Record<string, unknown>;
    }>(
      `SELECT response_ref, status, artifact FROM ledger.adservices_lookup_results
       WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=$3`,
      [tenantId, appId, install.recordId],
    ));
    assert.equal(stored.rows[0].status, "attributed");
    assert.deepEqual(stored.rows[0].artifact.adservices_context, {
      status: "attributed",
      attribution: true,
      org_id: "1",
      campaign_id: "2",
      conversion_type: "Download",
      claim_type: "Click",
      country_or_region: "US",
    });
    assert.deepEqual(JSON.parse((await payloadStore.read(stored.rows[0].response_ref)).toString("utf8")), {
      attribution: true,
      orgId: 1,
      campaignId: 2,
      conversionType: "Download",
      claimType: "Click",
      countryOrRegion: "US",
    });
  });

  it("A09 purges pending AdServices work before on-device deletion completes", async () => {
    const token = `synthetic-adservices-delete-${randomBytes(32).toString("base64url")}`;
    const install = await submitInstall("privacy-delete", token);
    const response = await signed({
      path: "/v1/privacy/on-device",
      value: { installation_id: install.installationId },
      secret: install.installationSecret,
      installationKeyId: install.installationKeyId,
    });
    assert.equal(response.status, 201);
    const pending = await withTenant(pool, tenantId, (client) => client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ephemeral.adservices_lookups
       WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=$3`,
      [tenantId, appId, install.recordId],
    ));
    assert.equal(pending.rows[0].count, "0");
    assert.equal(await payloadStore.scanFor(token), false);
    let called = false;
    const outcome = await processAdServicesLookups(pool, payloadStore, tenantId, {
      endpoint: "http://127.0.0.1/apple-adservices",
      client: async () => {
        called = true;
        return { status: 200, body: Buffer.from('{"attribution":true}') };
      },
    });
    assert.equal(called, false);
    assert.deepEqual(outcome, { completed: 0, retried: 0 });
  });

  it("A09 never queues a token from an event-ID conflict", async () => {
    const credential = await enroll("conflict");
    const submit = async (token: string): Promise<void> => {
      const response = await signed({
        path: "/v1/events/batch",
        value: {
          records: [installEvent("conflict", credential.installationId, {
            extensions: { adservices_attribution_token_protected: token },
          })],
        },
        secret: credential.installationSecret,
        installationKeyId: credential.installationKeyId,
      });
      assert.equal(response.status, 202);
      await processSdkInbox(pool, payloadStore, tenantId);
    };
    await submit(`synthetic-conflict-a-${run}`);
    await submit(`synthetic-conflict-b-${run}`);
    const state = await withTenant(pool, tenantId, (client) => client.query<{
      pending: string;
      conflicts: string;
    }>(
      `SELECT
        (SELECT count(*)::text FROM ephemeral.adservices_lookups
         WHERE tenant_id=$1 AND app_id=$2) AS pending,
        (SELECT count(*)::text FROM ledger.rejections
         WHERE tenant_id=$1 AND app_id=$2 AND reason_code='event_id_conflict') AS conflicts`,
      [tenantId, appId],
    ));
    assert.equal(state.rows[0].pending, "1");
    assert.equal(state.rows[0].conflicts, "1");
    await processAdServicesLookups(pool, payloadStore, tenantId, {
      endpoint: "http://127.0.0.1/apple-adservices",
      client: async () => ({ status: 400, body: Buffer.from('{"error":"synthetic_cleanup"}') }),
    });
  });

  it("A08 retries 404 three times, backs off 500, terminates 400, and skips expired tokens", async () => {
    await submitInstall("not-found", `synthetic-404-${run}`);
    const initial = new Date();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await processAdServicesLookups(pool, payloadStore, tenantId, {
        endpoint: "http://127.0.0.1/apple-adservices",
        now: () => new Date(initial.getTime() + attempt * 5_000),
        client: async () => ({ status: 404, body: Buffer.from('{"error":"not_found"}') }),
      });
      assert.deepEqual(result, attempt < 2 ? { completed: 0, retried: 1 } : { completed: 1, retried: 0 });
    }

    await submitInstall("server-error", `synthetic-500-${run}`);
    const retry = await processAdServicesLookups(pool, payloadStore, tenantId, {
      endpoint: "http://127.0.0.1/apple-adservices",
      client: async () => ({ status: 500, body: Buffer.from('{"error":"unavailable"}') }),
    });
    assert.deepEqual(retry, { completed: 0, retried: 1 });

    await submitInstall("invalid", `synthetic-400-${run}`);
    const terminal = await processAdServicesLookups(pool, payloadStore, tenantId, {
      endpoint: "http://127.0.0.1/apple-adservices",
      client: async () => ({ status: 400, body: Buffer.from('{"error":"invalid"}') }),
    });
    assert.equal(terminal.completed, 1);

    const expired = await submitInstall("expired", `synthetic-expired-${run}`);
    await withTenant(pool, tenantId, (client) => client.query(
      `UPDATE ephemeral.adservices_lookups
       SET token_created_at=clock_timestamp() - interval '23 hours 1 minute',
           next_attempt_at=clock_timestamp() - interval '1 minute'
       WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=$3`,
      [tenantId, appId, expired.recordId],
    ).then(() => undefined));
    let called = false;
    const expiredOutcome = await processAdServicesLookups(pool, payloadStore, tenantId, {
      endpoint: "http://127.0.0.1/apple-adservices",
      client: async () => {
        called = true;
        return { status: 200, body: Buffer.from('{"attribution":true}') };
      },
    });
    assert.equal(called, false);
    assert.equal(expiredOutcome.completed, 1);
  });
});
