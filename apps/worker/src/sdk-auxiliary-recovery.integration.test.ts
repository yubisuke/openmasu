import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  SDK_POST_PROCESSING_PENDING_REASON,
  appendDurableBatch,
  createAppPool,
  EncryptedFilePayloadStore,
  uuidV7,
  withTenant,
} from "@openmasu/runtime";
import {
  processAdServicesLookups,
  queueAdServicesLookup,
} from "./adservices-worker.js";
import {
  processGooglePlayProductVerifications,
  queueGooglePlayProductVerification,
} from "./google-play-product-verifier.js";
import {
  processIntegrityVerifications,
  queueIntegrityVerification,
} from "./integrity-verifier.js";
import { processSdkInbox } from "./sdk-worker.js";

const run = randomBytes(6).toString("hex");
const root = mkdtempSync(join(tmpdir(), "openmasu-sdk-recovery-"));
const pool = createAppPool();
const payloadStore = new EncryptedFilePayloadStore(
  root,
  `master-${randomBytes(32).toString("base64url")}`,
);

type Scope = {
  readonly tenantId: string;
  readonly appId: string;
  readonly producer: "sdk-android" | "sdk-ios";
  readonly receivedAt: string;
};

function scope(label: string, producer: Scope["producer"]): Scope {
  return {
    tenantId: `tenant-sdk-recovery-${label}-${run}`,
    appId: `app-sdk-recovery-${label}-${run}`,
    producer,
    receivedAt: new Date().toISOString(),
  };
}

function record(
  input: Scope,
  label: string,
  eventName: "install" | "purchase",
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    contract_version: "0.4.0",
    record_id: `record:${uuidV7()}`,
    delivery_id: `delivery:${uuidV7()}`,
    tenant_id: input.tenantId,
    app_id: input.appId,
    producer: input.producer,
    producer_version: "synthetic-sdk-recovery",
    event_id: `event:sdk-recovery:${label}:${run}`,
    event_name: eventName,
    schema_version: "0.4.0",
    occurred_at: input.receivedAt,
    occurred_at_source: "device",
    received_at: input.receivedAt,
    processing_purpose_id: eventName === "purchase" ? "revenue_measurement" : "attribution",
    processing_sequence: 1,
    payload: { event_name: eventName, ...payload },
  };
}

async function append(input: Scope, value: Record<string, unknown>): Promise<string> {
  return appendDurableBatch(pool, payloadStore, {
    tenantId: input.tenantId,
    appId: input.appId,
    producer: input.producer,
    body: Buffer.from(JSON.stringify({ records: [value] }), "utf8"),
    eventCount: 1,
    receivedAt: input.receivedAt,
  });
}

async function batchState(input: Scope, batchId: string): Promise<{
  readonly status: string;
  readonly reason_code: string | null;
}> {
  return withTenant(pool, input.tenantId, async (client) => (await client.query<{
    status: string;
    reason_code: string | null;
  }>(
    `SELECT status, reason_code FROM ledger.ingest_batches_current
      WHERE tenant_id=$1 AND app_id=$2 AND ingest_batch_id=$3`,
    [input.tenantId, input.appId, batchId],
  )).rows[0]);
}

async function ledgerCount(input: Scope, recordId: string): Promise<number> {
  return withTenant(pool, input.tenantId, async (client) => (await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM ledger.raw_records raw
       JOIN ledger.logical_events logical
         ON logical.tenant_id=raw.tenant_id AND logical.app_id=raw.app_id
        AND logical.record_id=raw.record_id
      WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.record_id=$3`,
    [input.tenantId, input.appId, recordId],
  )).rows[0].count);
}

after(async () => {
  await pool.end();
  rmSync(root, { recursive: true, force: true });
});

describe("SDK auxiliary queue recovery", () => {
  it("recovers an AdServices queue failure after base persistence and stays terminal-idempotent", async () => {
    const input = scope("adservices", "sdk-ios");
    const token = `synthetic-adservices-recovery-${run}`;
    const value = record(input, "adservices", "install", {
      installation_id: `installation:sdk-recovery-adservices-${run}`,
      install_type: "first_install",
      install_origin: "ios_first_launch",
      referrer_status: "not_applicable",
      extensions: { adservices_attribution_token_protected: token },
    });
    const recordId = String(value.record_id);
    const batchId = await append(input, value);

    await assert.rejects(processSdkInbox(pool, payloadStore, input.tenantId, {
      auxiliaryQueues: { adServices: async () => { throw new Error("synthetic_adservices_queue_failure"); } },
    }), /synthetic_adservices_queue_failure/);
    assert.equal(await ledgerCount(input, recordId), 1);
    assert.deepEqual(await batchState(input, batchId), {
      status: "processed", reason_code: SDK_POST_PROCESSING_PENDING_REASON,
    });

    assert.equal(await processSdkInbox(pool, payloadStore, input.tenantId), 0);
    assert.deepEqual(await batchState(input, batchId), { status: "processed", reason_code: null });
    const pending = await withTenant(pool, input.tenantId, async (client) => (await client.query<{
      token_ref: string;
    }>(
      `SELECT token_ref FROM ephemeral.adservices_lookups
        WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=$3`,
      [input.tenantId, input.appId, recordId],
    )).rows);
    assert.equal(pending.length, 1);
    await processSdkInbox(pool, payloadStore, input.tenantId);
    assert.equal(await ledgerCount(input, recordId), 1);

    assert.deepEqual(await processAdServicesLookups(pool, payloadStore, input.tenantId, {
      endpoint: "http://127.0.0.1/apple-adservices",
      client: async () => ({ status: 400, body: Buffer.from('{"error":"synthetic_terminal"}') }),
    }), { completed: 1, retried: 0 });
    await queueAdServicesLookup(pool, {
      tenantId: input.tenantId,
      appId: input.appId,
      installRecordId: recordId,
      tokenRef: pending[0].token_ref,
      tokenCreatedAt: input.receivedAt,
    });
    const terminal = await withTenant(pool, input.tenantId, async (client) => (await client.query<{
      pending: number;
      results: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM ephemeral.adservices_lookups
          WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=$3) AS pending,
        (SELECT count(*)::int FROM ledger.adservices_lookup_results
          WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=$3) AS results`,
      [input.tenantId, input.appId, recordId],
    )).rows[0]);
    assert.deepEqual(terminal, { pending: 0, results: 1 });
  });

  it("recovers an integrity queue failure after base persistence and stays terminal-idempotent", async () => {
    const input = scope("integrity", "sdk-android");
    const binding = randomBytes(32).toString("base64url");
    const value = record(input, "integrity", "install", {
      installation_id: `installation:sdk-recovery-integrity-${run}`,
      install_type: "first_install",
      install_origin: "play_first_launch",
      referrer_status: "unavailable",
      extensions: {
        integrity_token_protected: `synthetic-integrity-recovery-${run}`,
        integrity_provider: "play_integrity",
        integrity_binding_mode: "challenge",
        integrity_binding: binding,
      },
    });
    const recordId = String(value.record_id);
    const batchId = await append(input, value);
    await assert.rejects(processSdkInbox(pool, payloadStore, input.tenantId, {
      auxiliaryQueues: { integrity: async () => { throw new Error("synthetic_integrity_queue_failure"); } },
    }), /synthetic_integrity_queue_failure/);
    assert.equal(await ledgerCount(input, recordId), 1);
    assert.deepEqual(await batchState(input, batchId), {
      status: "processed", reason_code: SDK_POST_PROCESSING_PENDING_REASON,
    });

    assert.equal(await processSdkInbox(pool, payloadStore, input.tenantId), 0);
    const queued = await withTenant(pool, input.tenantId, async (client) => (await client.query<{
      token_ref: string;
      challenge_digest: string;
    }>(
      `SELECT token_ref, challenge_digest FROM ephemeral.integrity_verifications
        WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3`,
      [input.tenantId, input.appId, recordId],
    )).rows[0]);
    assert.equal(queued.challenge_digest, createHash("sha256").update(binding, "utf8").digest("hex"));
    assert.deepEqual(await processIntegrityVerifications(pool, payloadStore, input.tenantId, {
      providerMode: "play_integrity",
      playEndpoint: "http://127.0.0.1/play-integrity",
      client: async () => ({ status: 503, body: Buffer.from("synthetic outage") }),
    }), { verified: 0, failed: 0, unavailable: 1 });
    await queueIntegrityVerification(pool, {
      tenantId: input.tenantId,
      appId: input.appId,
      subjectRecordId: recordId,
      provider: "play_integrity",
      tokenRef: queued.token_ref,
      bindingDigest: queued.challenge_digest,
      requestedAt: input.receivedAt,
    });
    const terminal = await withTenant(pool, input.tenantId, async (client) => (await client.query<{
      pending: number;
      results: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM ephemeral.integrity_verifications
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3) AS pending,
        (SELECT count(*)::int FROM ledger.integrity_verification_results
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3) AS results`,
      [input.tenantId, input.appId, recordId],
    )).rows[0]);
    assert.deepEqual(terminal, { pending: 0, results: 1 });
  });

  it("recovers a Google Play product queue failure after base persistence and stays terminal-idempotent", async () => {
    const input = scope("google-play", "sdk-android");
    const purchaseToken = `synthetic-google-play-recovery-${run}`;
    const productId = `product.synthetic.recovery.${run}`;
    const value = record(input, "google-play", "purchase", {
      installation_id: `installation:sdk-recovery-google-play-${run}`,
      transaction_id: `transaction:sdk-recovery-google-play-${run}`,
      amount_unscaled: "990000",
      amount_scale: 6,
      currency: "USD",
      financial_status: "pending",
      extensions: {
        google_play_purchase_token_protected: purchaseToken,
        google_play_product_id_protected: productId,
      },
    });
    const recordId = String(value.record_id);
    const batchId = await append(input, value);
    await assert.rejects(processSdkInbox(pool, payloadStore, input.tenantId, {
      auxiliaryQueues: { googlePlayProduct: async () => { throw new Error("synthetic_google_play_queue_failure"); } },
    }), /synthetic_google_play_queue_failure/);
    assert.equal(await ledgerCount(input, recordId), 1);
    assert.deepEqual(await batchState(input, batchId), {
      status: "processed", reason_code: SDK_POST_PROCESSING_PENDING_REASON,
    });

    assert.equal(await processSdkInbox(pool, payloadStore, input.tenantId), 0);
    const queued = await withTenant(pool, input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO control.app_link_identities (
          tenant_id, app_id, android_package_name, registered_at, artifact
        ) VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [input.tenantId, input.appId, `dev.openmasu.synthetic.recovery${run}`, input.receivedAt,
          JSON.stringify({ tenant_id: input.tenantId, app_id: input.appId })],
      );
      return (await client.query<{
        token_ref: string;
      }>(
        `SELECT token_ref FROM ephemeral.google_play_product_verifications
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3`,
        [input.tenantId, input.appId, recordId],
      )).rows[0];
    });
    assert.deepEqual(await processGooglePlayProductVerifications(pool, payloadStore, input.tenantId, {
      enabled: true,
      client: async () => ({ status: 400, body: Buffer.from('{"error":"synthetic_terminal"}') }),
    }), { verified: 0, failed: 1, unavailable: 0, deferred: 0 });
    await queueGooglePlayProductVerification(pool, {
      tenantId: input.tenantId,
      appId: input.appId,
      subjectRecordId: recordId,
      tokenRef: queued.token_ref,
      purchaseToken,
      productId,
      purchaseKind: "one_time_product",
      requestedAt: input.receivedAt,
    });
    const terminal = await withTenant(pool, input.tenantId, async (client) => (await client.query<{
      pending: number;
      results: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM ephemeral.google_play_product_verifications
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3) AS pending,
        (SELECT count(*)::int FROM ledger.google_play_purchase_verification_results
          WHERE tenant_id=$1 AND app_id=$2 AND subject_record_id=$3) AS results`,
      [input.tenantId, input.appId, recordId],
    )).rows[0]);
    assert.deepEqual(terminal, { pending: 0, results: 1 });
  });
});
