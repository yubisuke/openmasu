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
  createMigrationPool,
  EncryptedFilePayloadStore,
  type PayloadStore,
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

type Any = Record<string, any>;

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
  readonly producer: "sdk-android" | "sdk-ios" | "redirector";
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
  eventName: "click" | "install" | "purchase" | "refund" | "consent_changed",
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
    processing_purpose_id: ["purchase", "refund"].includes(eventName) ? "revenue_measurement" : "attribution",
    processing_sequence: 1,
    payload: { event_name: eventName, ...payload },
  };
}

async function append(
  input: Scope,
  value: Record<string, unknown>,
  installationKeyId?: string,
): Promise<string> {
  return appendDurableBatch(pool, payloadStore, {
    tenantId: input.tenantId,
    appId: input.appId,
    producer: input.producer,
    body: Buffer.from(JSON.stringify({ records: [value] }), "utf8"),
    eventCount: 1,
    receivedAt: input.receivedAt,
    ...(installationKeyId ? { installationKeyId } : {}),
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

function countingPayloadStore(reads: string[]): PayloadStore {
  return {
    write: (scope, plaintext) => payloadStore.write(scope, plaintext),
    read: async (reference) => {
      reads.push(reference);
      return payloadStore.read(reference);
    },
    purge: (reference) => payloadStore.purge(reference),
    scanFor: (value) => payloadStore.scanFor(value),
  };
}

async function purgeRecordEvidence(input: Scope, recordId: string): Promise<void> {
  const bodyRef = await withTenant(pool, input.tenantId, async (client) => (await client.query<{ body_ref: string }>(
    `SELECT batch.body_ref
       FROM ledger.ingest_batches AS batch
       JOIN ledger.ingest_batch_records AS member USING (ingest_batch_id, tenant_id, app_id)
      WHERE member.tenant_id=$1 AND member.app_id=$2 AND member.record_id=$3
      ORDER BY batch.inbox_seq DESC LIMIT 1`,
    [input.tenantId, input.appId, recordId],
  )).rows[0].body_ref);
  await payloadStore.purge(bodyRef);
  await withTenant(pool, input.tenantId, (client) => client.query(
    `INSERT INTO ledger.raw_payload_states (
       tenant_id, app_id, record_id, lifecycle_status, changed_at
     ) VALUES ($1,$2,$3,'purged',$4)
     ON CONFLICT (record_id, lifecycle_status) DO NOTHING`,
    [input.tenantId, input.appId, recordId, new Date().toISOString()],
  ).then(() => undefined));
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
    }), { completed: 1, unavailable: 1 });
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

  it("reconstructs an available click from the normalized ledger without reopening its processed batch", async () => {
    const clickScope = scope("ledger-click", "redirector");
    const clickId = `click_${randomBytes(18).toString("base64url")}`;
    const click = record(clickScope, "ledger-click", "click", {
      click_id: clickId,
      tracking_link_id: `link-ledger-${run}`,
      campaign_id: `campaign-ledger-${run}`,
      redirector_click_at: clickScope.receivedAt,
      redirector_time_status: "available",
    });
    await append(clickScope, click);
    assert.equal(await processSdkInbox(pool, payloadStore, clickScope.tenantId), 1);

    const installAt = new Date(Date.parse(clickScope.receivedAt) + 60_000).toISOString();
    const installScope: Scope = { ...clickScope, producer: "sdk-android", receivedAt: installAt };
    const install = record(installScope, "ledger-install", "install", {
      installation_id: `installation:ledger-click-${run}`,
      install_type: "first_install",
      referrer_status: "available",
      click_id: clickId,
      install_begin_at_server_status: "available",
      install_begin_at_server: installAt,
      protected_referrer_evidence_ref: `protected:ledger-click-${run}`,
    });
    await append(installScope, install);
    const reads: string[] = [];
    assert.equal(await processSdkInbox(pool, countingPayloadStore(reads), installScope.tenantId), 1);
    assert.equal(reads.length, 1, "only the new install body may be decrypted");
    const attribution = await withTenant(pool, installScope.tenantId, async (client) => (await client.query<{
      reason_code: string;
    }>(
      "SELECT reason_code FROM ledger.attribution_results WHERE attribution_id=$1",
      [`attr:${String(install.record_id)}`],
    )).rows[0]);
    assert.deepEqual(attribution, { reason_code: "valid_install_referrer" });
  });

  it("keeps tombstone idempotency while excluding purged click semantics", async () => {
    const input = scope("ledger-tombstone", "redirector");
    const clickId = `click_${randomBytes(18).toString("base64url")}`;
    const original = record(input, "ledger-tombstone", "click", {
      click_id: clickId,
      tracking_link_id: `link-tombstone-${run}`,
      campaign_id: `campaign-tombstone-${run}`,
      redirector_click_at: input.receivedAt,
      redirector_time_status: "available",
    });
    await append(input, original);
    assert.equal(await processSdkInbox(pool, payloadStore, input.tenantId), 1);
    await purgeRecordEvidence(input, String(original.record_id));

    const laterAt = new Date(Date.parse(input.receivedAt) + 60_000).toISOString();
    const duplicateScope: Scope = { ...input, receivedAt: laterAt };
    const duplicate: Any = {
      ...record(duplicateScope, "ledger-tombstone-duplicate", "click", structuredClone(original.payload as Any)),
      event_id: original.event_id,
    };
    await append(duplicateScope, duplicate);
    const duplicateReads: string[] = [];
    assert.equal(await processSdkInbox(pool, countingPayloadStore(duplicateReads), input.tenantId), 1);
    assert.equal(duplicateReads.length, 1);

    const conflictScope: Scope = {
      ...input,
      receivedAt: new Date(Date.parse(laterAt) + 60_000).toISOString(),
    };
    const conflictPayload = { ...(original.payload as Any), campaign_id: `campaign-conflict-${run}` };
    const conflict: Any = {
      ...record(conflictScope, "ledger-tombstone-conflict", "click", conflictPayload),
      event_id: original.event_id,
    };
    await append(conflictScope, conflict);
    const conflictReads: string[] = [];
    assert.equal(await processSdkInbox(pool, countingPayloadStore(conflictReads), input.tenantId), 1);
    assert.equal(conflictReads.length, 1);

    const installScope: Scope = {
      ...input,
      producer: "sdk-android",
      receivedAt: new Date(Date.parse(conflictScope.receivedAt) + 60_000).toISOString(),
    };
    const install = record(installScope, "ledger-tombstone-install", "install", {
      installation_id: `installation:ledger-tombstone-${run}`,
      install_type: "first_install",
      referrer_status: "available",
      click_id: clickId,
      install_begin_at_server_status: "available",
      install_begin_at_server: installScope.receivedAt,
      protected_referrer_evidence_ref: `protected:ledger-tombstone-${run}`,
    });
    await append(installScope, install);
    const installReads: string[] = [];
    assert.equal(await processSdkInbox(pool, countingPayloadStore(installReads), input.tenantId), 1);
    assert.equal(installReads.length, 1);

    const evidence = await withTenant(pool, input.tenantId, async (client) => ({
      duplicate: (await client.query<{ duplicate_resolution: string; ingestion_status: string }>(
        `SELECT duplicate_resolution, ingestion_status FROM ledger.event_deliveries
          WHERE tenant_id=$1 AND app_id=$2 AND delivery_id=$3 ORDER BY ledger_seq DESC LIMIT 1`,
        [input.tenantId, input.appId, duplicate.delivery_id],
      )).rows[0],
      conflict: (await client.query<{ duplicate_resolution: string; ingestion_status: string }>(
        `SELECT duplicate_resolution, ingestion_status FROM ledger.event_deliveries
          WHERE tenant_id=$1 AND app_id=$2 AND delivery_id=$3 ORDER BY ledger_seq DESC LIMIT 1`,
        [input.tenantId, input.appId, conflict.delivery_id],
      )).rows[0],
      attribution: (await client.query<{ reason_code: string }>(
        "SELECT reason_code FROM ledger.attribution_results WHERE attribution_id=$1",
        [`attr:${String(install.record_id)}`],
      )).rows[0],
    }));
    assert.deepEqual(evidence.duplicate, { duplicate_resolution: "duplicate_delivery", ingestion_status: "accepted" });
    assert.deepEqual(evidence.conflict, { duplicate_resolution: "event_id_conflict", ingestion_status: "rejected" });
    assert.deepEqual(evidence.attribution, { reason_code: "unknown_click_id" });
  });

  it("resolves a refund against an available purchase fact without reopening the purchase batch", async () => {
    const purchaseScope = scope("ledger-commerce", "sdk-android");
    const installationId = `installation:ledger-commerce-${run}`;
    const transactionId = `transaction:ledger-commerce-${run}`;
    const purchase = record(purchaseScope, "ledger-commerce-purchase", "purchase", {
      installation_id: installationId,
      transaction_id: transactionId,
      amount_unscaled: "2500000",
      amount_scale: 6,
      currency: "USD",
      financial_status: "settled",
    });
    await append(purchaseScope, purchase);
    assert.equal(await processSdkInbox(pool, payloadStore, purchaseScope.tenantId), 1);

    const refundScope: Scope = {
      ...purchaseScope,
      receivedAt: new Date(Date.parse(purchaseScope.receivedAt) + 60_000).toISOString(),
    };
    const refund = record(refundScope, "ledger-commerce-refund", "refund", {
      installation_id: installationId,
      transaction_id: `transaction:ledger-commerce-refund-${run}`,
      original_transaction_id: transactionId,
      amount_unscaled: "500000",
      amount_scale: 6,
      currency: "USD",
      financial_status: "settled",
    });
    await append(refundScope, refund);
    const reads: string[] = [];
    assert.equal(await processSdkInbox(pool, countingPayloadStore(reads), refundScope.tenantId), 1);
    assert.equal(reads.length, 1, "only the new refund body may be decrypted");
    const correction = await withTenant(pool, refundScope.tenantId, async (client) => (await client.query<{
      corrects_record_id: string;
    }>(
      "SELECT corrects_record_id FROM ledger.corrections WHERE correction_id=$1",
      [`correction:${String(refund.record_id)}`],
    )).rows[0]);
    assert.deepEqual(correction, { corrects_record_id: purchase.record_id });
  });

  it("fails closed on an unprojected legacy consent control without reopening its encrypted body", async () => {
    const input = scope("ledger-consent-upgrade", "sdk-android");
    const installationKeyId = `installation-key-ledger-consent-${run}`;
    const consent = record(input, "ledger-consent-upgrade", "consent_changed", {
      consent_state: "withdrawn",
      effective_at: input.receivedAt,
      consent_policy_version: "synthetic-consent-v1",
    });
    const consentBatchId = await append(input, consent, installationKeyId);
    assert.equal(await processSdkInbox(pool, payloadStore, input.tenantId), 1);
    const migrationPool = createMigrationPool();
    try {
      await migrationPool.query(
        "DELETE FROM control.installation_withdrawal_backfill_states WHERE tenant_id=$1 AND app_id=$2",
        [input.tenantId, input.appId],
      );
      await migrationPool.query(
        "DELETE FROM control.installation_withdrawals WHERE tenant_id=$1 AND app_id=$2",
        [input.tenantId, input.appId],
      );
    } finally {
      await migrationPool.end();
    }
    const consentBodyRef = await withTenant(pool, input.tenantId, async (client) => (await client.query<{
      body_ref: string;
    }>(
      "SELECT body_ref FROM ledger.ingest_batches WHERE ingest_batch_id=$1",
      [consentBatchId],
    )).rows[0].body_ref);
    await payloadStore.purge(consentBodyRef);

    const later: Scope = {
      ...input,
      receivedAt: new Date(Date.parse(input.receivedAt) + 60_000).toISOString(),
    };
    const purchase = record(later, "ledger-consent-later", "purchase", {
      installation_id: `installation:ledger-consent-${run}`,
      transaction_id: `transaction:ledger-consent-${run}`,
      amount_unscaled: "1000000",
      amount_scale: 6,
      currency: "USD",
      financial_status: "settled",
    });
    const batchId = await append(later, purchase, installationKeyId);
    const reads: string[] = [];
    await assert.rejects(
      processSdkInbox(pool, countingPayloadStore(reads), input.tenantId),
      /withdrawal_projection_upgrade_required/,
    );
    assert.equal(reads.length, 1, "the unavailable historical consent body must not be reopened");
    assert.deepEqual(await batchState(input, batchId), { status: "pending", reason_code: null });
  });

  it("reads only new work instead of any lifetime processed SDK batch", async () => {
    const input = scope("bounded-history", "sdk-android");
    const installationId = `installation:sdk-bounded-history-${run}`;
    for (let index = 0; index < 24; index += 1) {
      const value = {
        ...record(input, `irrelevant-${index}`, "purchase", {
          installation_id: `${installationId}-${index}`,
          transaction_id: `transaction:sdk-bounded-history-${index}-${run}`,
          amount_unscaled: "1000000",
          amount_scale: 6,
          currency: "USD",
          financial_status: "settled",
        }),
        processing_sequence: index + 1,
      };
      await append(input, value);
      assert.equal(await processSdkInbox(pool, payloadStore, input.tenantId), 1);
    }

    const current = {
      ...record(input, "current", "purchase", {
        installation_id: installationId,
        transaction_id: `transaction:sdk-bounded-history-current-${run}`,
        amount_unscaled: "2000000",
        amount_scale: 6,
        currency: "USD",
        financial_status: "settled",
      }),
      processing_sequence: 100,
    };
    await append(input, current);
    const reads: string[] = [];
    const countingStore: PayloadStore = {
      write: (scope, plaintext) => payloadStore.write(scope, plaintext),
      read: async (reference) => {
        reads.push(reference);
        return payloadStore.read(reference);
      },
      purge: (reference) => payloadStore.purge(reference),
      scanFor: (value) => payloadStore.scanFor(value),
    };
    assert.equal(await processSdkInbox(pool, countingStore, input.tenantId), 1);
    assert.equal(reads.length, 1, "one new batch must not replay any processed body");
  });
});
