import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  createAppPool,
  EncryptedFilePayloadStore,
  PayloadNotFoundError,
  withTenant,
  type PayloadStore,
} from "@openmasu/runtime";
import { executePrivacyRequest, privacySubjectDigest } from "../../api/src/privacy.js";
import {
  discoverGoogleConversionDeliveries,
  processGoogleConversionDeliveries,
} from "./google-conversion-worker.js";

const suffix = randomBytes(5).toString("hex");
const pool = createAppPool();
const root = mkdtempSync(join(tmpdir(), "openmasu-gdm-"));
const payloadStore = new EncryptedFilePayloadStore(root, `synthetic-${randomBytes(32).toString("base64url")}`);
const at = "2026-08-24T00:00:00.000Z";
const privacyDigestKey = "synthetic-google-conversion-privacy-digest-key";

type SeededConversion = {
  readonly tenantId: string;
  readonly appId: string;
  readonly installationId: string;
  readonly clickRecord: string;
  readonly purchaseRecord: string;
};

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function providerStartedBeforeCompletion(
  started: Promise<void>,
  processing: Promise<{ processed: number }>,
  label: string,
): Promise<void> {
  await within(Promise.race([
    started,
    processing.then((result) => {
      throw new Error(`${label} completed before provider I/O: ${JSON.stringify(result)}`);
    }, (error: unknown) => {
      throw new Error(`${label} failed before provider I/O`, { cause: error });
    }),
  ]), label);
}

async function seedEligibleConversion(
  label: string,
  existing?: Pick<SeededConversion, "tenantId" | "appId">,
): Promise<SeededConversion> {
  const run = `${suffix}-${label}`;
  const tenantId = existing?.tenantId ?? `tenant-gdm-${run}`;
  const appId = existing?.appId ?? `app-gdm-${run}`;
  const installationId = `installation:gdm-${run}`;
  const clickRecord = `gdm-click-${run}`;
  const installRecord = `gdm-install-${run}`;
  const purchaseRecord = `gdm-purchase-${run}`;
  const clickLogical = `logical:${clickRecord}`;
  const installLogical = `logical:${installRecord}`;
  const purchaseLogical = `logical:${purchaseRecord}`;
  const verificationResultId = randomUUID();
  await withTenant(pool, tenantId, async (client) => {
    if (!existing) {
      await client.query("INSERT INTO control.apps (tenant_id,app_id,created_at) VALUES ($1,$2,$3)", [tenantId, appId, at]);
    }
    for (const [recordId, eventName] of [[clickRecord, "click"], [installRecord, "install"], [purchaseRecord, "purchase"]]) {
      await client.query(`INSERT INTO ledger.raw_records (
        record_id,tenant_id,app_id,producer,producer_version,event_id,delivery_id,event_name,
        schema_version,payload_sha256,occurred_at,occurred_at_source,received_at,raw_payload_ref,
        processing_purpose_id,consent_evaluation_policy_version,consent_decision_reason_code,artifact
      ) VALUES ($1,$2,$3,'synthetic-gdm','1',$4,$5,$6,'0.4','${"a".repeat(64)}',$7,
        'server',$7,$8,'measurement','synthetic-consent-v1','consent_not_required',$9::jsonb)`,
        [recordId, tenantId, appId, `event:${recordId}`, `delivery:${recordId}`, eventName, at,
          `encrypted:synthetic-${recordId}`, JSON.stringify({ synthetic: true })]);
      await client.query(`INSERT INTO ledger.raw_payload_states (
        tenant_id,app_id,record_id,lifecycle_status,changed_at
      ) VALUES ($1,$2,$3,'available',$4)`, [tenantId, appId, recordId, at]);
    }
    for (const [logicalId, recordId, eventName] of [[clickLogical, clickRecord, "click"],
      [installLogical, installRecord, "install"], [purchaseLogical, purchaseRecord, "purchase"]]) {
      await client.query(`INSERT INTO ledger.logical_events (
        logical_event_id,record_id,tenant_id,app_id,producer,event_id,event_name,timeliness,artifact
      ) VALUES ($1,$2,$3,$4,'synthetic-gdm',$5,$6,'on_time',$7::jsonb)`,
      [logicalId, recordId, tenantId, appId, `event:${recordId}`, eventName, JSON.stringify({ synthetic: true })]);
    }
    await client.query(`INSERT INTO ledger.click_facts (
      logical_event_id,tenant_id,app_id,click_id,redirector_click_at,network,remote_click_ref,artifact
    ) VALUES ($1,$2,$3,$4,$5,'google_ads',$6,$7::jsonb)`,
    [clickLogical, tenantId, appId, `click:${run}`, at, `syntheticGclid_${run}`, JSON.stringify({ synthetic: true })]);
    await client.query(`INSERT INTO ledger.install_facts (
      logical_event_id,tenant_id,app_id,installation_id,install_type,click_id,occurred_at,artifact
    ) VALUES ($1,$2,$3,$4,'first_install',$5,$6,$7::jsonb)`,
    [installLogical, tenantId, appId, installationId, `click:${run}`, at, JSON.stringify({ synthetic: true })]);
    await client.query(`INSERT INTO ledger.purchase_facts (
      logical_event_id,record_id,tenant_id,app_id,installation_id,transaction_id,amount_unscaled,
      amount_scale,currency,financial_status,occurred_at,artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,'1230000',6,'USD','settled',$7,$8::jsonb)`,
    [purchaseLogical, purchaseRecord, tenantId, appId, installationId, `transaction:${run}`, at, JSON.stringify({ synthetic: true })]);
    await client.query(`INSERT INTO ledger.attribution_results (
      attribution_id,tenant_id,app_id,subject_scope,subject_ref,effective_at,decided_at,
      status,method,model,reason_code,artifact
    ) VALUES ($1,$2,$3,'installation_level',$4,$5,$5,'non_organic','last_click','deterministic',
      'valid_install_referrer',$6::jsonb)`,
    [`attribution:${run}`, tenantId, appId, installationId, at,
      JSON.stringify({ attribution_id: `attribution:${run}`, finality: "final" })]);
    await client.query(`INSERT INTO ledger.google_play_purchase_verification_results (
      verification_result_id,verification_id,tenant_id,app_id,subject_record_id,verified_record_id,
      token_digest,verdict,provider_purchase_state,product_matched,evidence_ref,response_digest,
      decided_at,artifact,purchase_kind
    ) VALUES ($1,$2,$3,$4,$5,$5,$6,'verified','PURCHASED',true,$7,$8,$9,$10::jsonb,'one_time_product')`,
    [verificationResultId, randomUUID(), tenantId, appId, purchaseRecord, "b".repeat(64),
      `encrypted:synthetic-play-${run}`, "c".repeat(64), at, JSON.stringify({ synthetic: true })]);
    if (!existing) {
      await client.query(`INSERT INTO control.google_data_manager_destinations (
        destination_id,tenant_id,app_id,operating_account_id,conversion_action_id,app_audience,
        enabled,registered_at,artifact
      ) VALUES ($1,$2,$3,'123456789','987654321','general',true,$4,$5::jsonb)`,
      [randomUUID(), tenantId, appId, at, JSON.stringify({ synthetic: true })]);
    }
  });
  return { tenantId, appId, installationId, clickRecord, purchaseRecord };
}

async function deleteInstallation(
  seeded: SeededConversion,
  now = new Date("2026-08-24T00:01:00.000Z"),
) {
  const body = {
    tenant_id: seeded.tenantId,
    app_id: seeded.appId,
    requested_via: "on_device_sdk" as const,
    deletion_scope: "installation" as const,
    deletion_subject_ref: seeded.installationId,
  };
  return executePrivacyRequest(pool, {
    tenantId: seeded.tenantId,
    appId: seeded.appId,
    actorType: "sdk_installation",
    actorRef: `sdk_installation:${seeded.installationId}`,
    requesterAuthRef: `sdk_auth:${seeded.installationId}`,
    deletionSubjectDigest: privacySubjectDigest(privacyDigestKey, body),
  }, body, payloadStore, now);
}

after(async () => { await pool.end(); rmSync(root, { recursive: true, force: true }); });

describe("Google Data Manager verified-conversion integration", () => {
  it("discovers one eligible conversion and fences concurrent and expired delivery claims", async () => {
    const { tenantId, appId, installationId, purchaseRecord } =
      await seedEligibleConversion("claims");
    assert.equal(await discoverGoogleConversionDeliveries(pool, payloadStore, tenantId, new Date(at)), 1);
    assert.equal(await discoverGoogleConversionDeliveries(pool, payloadStore, tenantId, new Date(at)), 0);
    const row = await withTenant(pool, tenantId, (client) => client.query<{ request_ref: string }>(
      "SELECT request_ref FROM ephemeral.google_conversion_deliveries WHERE tenant_id=$1 AND app_id=$2", [tenantId, appId]));
    assert.equal(row.rowCount, 1);
    const body = (await payloadStore.read(row.rows[0]!.request_ref)).toString("utf8");
    assert.match(body, /"gclid":"syntheticGclid_/);
    for (const forbidden of [tenantId, appId, installationId, purchaseRecord, "transaction:"]) assert.equal(body.includes(forbidden), false);

    const started = deferred();
    const release = deferred();
    const transactionIds: string[] = [];
    const first = processGoogleConversionDeliveries(pool, payloadStore, tenantId, {
      enabled: true,
      credentialsJson: "{}",
      minimumRequestIntervalMs: 0,
      now: () => new Date(),
      claimLeaseMs: 60_000,
      dependencies: {
        accessToken: async () => "synthetic-access-token",
        sendEvent: async (event) => {
          transactionIds.push(event.transactionId);
          started.resolve();
          await release.promise;
          return { outcome: "retry", reason: "provider_unavailable", httpStatus: 503 } as const;
        },
      },
    });
    await providerStartedBeforeCompletion(started.promise, first, "claimed Google request");

    let blockedProviderCalls = 0;
    assert.deepEqual(await within(processGoogleConversionDeliveries(pool, payloadStore, tenantId, {
      enabled: true,
      credentialsJson: "{}",
      minimumRequestIntervalMs: 0,
      now: () => new Date(),
      claimLeaseMs: 60_000,
      dependencies: {
        accessToken: async () => "synthetic-access-token",
        sendEvent: async () => {
          blockedProviderCalls += 1;
          return { outcome: "retry", reason: "provider_unavailable", httpStatus: 503 } as const;
        },
      },
    }), "concurrent Google claim"), { processed: 0 });
    assert.equal(blockedProviderCalls, 0);
    release.resolve();
    assert.deepEqual(await within(first, "first Google claim completion"), { processed: 1 });

    await withTenant(pool, tenantId, (client) => client.query(
      `UPDATE ephemeral.google_conversion_deliveries
          SET next_attempt_at=clock_timestamp() - interval '1 second'
        WHERE tenant_id=$1 AND app_id=$2`,
      [tenantId, appId],
    ));

    const staleStarted = deferred();
    const releaseStale = deferred();
    const stale = processGoogleConversionDeliveries(pool, payloadStore, tenantId, {
      enabled: true,
      credentialsJson: "{}",
      minimumRequestIntervalMs: 0,
      now: () => new Date(),
      claimLeaseMs: 60_000,
      dependencies: {
        accessToken: async () => "synthetic-access-token",
        sendEvent: async (event) => {
          transactionIds.push(event.transactionId);
          staleStarted.resolve();
          await releaseStale.promise;
          return { outcome: "retry", reason: "provider_unavailable", httpStatus: 503 } as const;
        },
      },
    });
    await providerStartedBeforeCompletion(staleStarted.promise, stale, "expired Google claim");
    await withTenant(pool, tenantId, (client) => client.query(
      `UPDATE ephemeral.google_conversion_deliveries
          SET claimed_until=clock_timestamp() - interval '1 second'
        WHERE tenant_id=$1 AND app_id=$2`,
      [tenantId, appId],
    ));
    assert.deepEqual(await within(processGoogleConversionDeliveries(pool, payloadStore, tenantId, {
      enabled: true,
      credentialsJson: "{}",
      minimumRequestIntervalMs: 0,
      now: () => new Date(),
      claimLeaseMs: 60_000,
      dependencies: {
        accessToken: async () => "synthetic-access-token",
        sendEvent: async (event) => {
          transactionIds.push(event.transactionId);
          return { outcome: "retry", reason: "provider_unavailable", httpStatus: 503 } as const;
        },
      },
    }), "replacement Google claim"), { processed: 1 });
    releaseStale.resolve();
    assert.deepEqual(await within(stale, "stale Google claim completion"), { processed: 0 });

    const finalState = await withTenant(pool, tenantId, (client) => client.query<{
      attempts: number;
      claim_token: string | null;
      claimed_until: string | null;
      transaction_digest: string;
      result_count: number;
    }>(
      `SELECT delivery.attempts,delivery.claim_token::text,delivery.claimed_until::text,
              delivery.transaction_digest,
              (SELECT count(*)::int FROM ledger.google_conversion_delivery_results result
                WHERE result.tenant_id=delivery.tenant_id
                  AND result.delivery_id=delivery.delivery_id) AS result_count
         FROM ephemeral.google_conversion_deliveries delivery
        WHERE delivery.tenant_id=$1 AND delivery.app_id=$2`,
      [tenantId, appId],
    ));
    assert.deepEqual(finalState.rows.map(({ attempts, claim_token, claimed_until, result_count }) => ({
      attempts, claim_token, claimed_until, result_count,
    })), [{ attempts: 2, claim_token: null, claimed_until: null, result_count: 3 }]);
    assert.equal(transactionIds.length, 3);
    assert.equal(new Set(transactionIds).size, 1);
    assert.equal(
      createHash("sha256").update(transactionIds[0]!, "utf8").digest("hex"),
      finalState.rows[0]!.transaction_digest,
    );
  });

  it("shares destination pacing and Retry-After across distinct delivery claims", async () => {
    const firstSeed = await seedEligibleConversion("pacing-first");
    await seedEligibleConversion("pacing-second", firstSeed);
    assert.equal(await discoverGoogleConversionDeliveries(
      pool, payloadStore, firstSeed.tenantId, new Date(at),
    ), 2);

    const requestStarted = deferred();
    const releaseRequest = deferred();
    const cycleNow = new Date();
    let providerCalls = 0;
    const first = processGoogleConversionDeliveries(pool, payloadStore, firstSeed.tenantId, {
      enabled: true,
      credentialsJson: "{}",
      now: () => cycleNow,
      claimLeaseMs: 60_000,
      minimumRequestIntervalMs: 60_000,
      dependencies: {
        accessToken: async () => "synthetic-access-token",
        sendEvent: async () => {
          providerCalls += 1;
          requestStarted.resolve();
          await releaseRequest.promise;
          return {
            outcome: "retry", reason: "rate_limited", httpStatus: 429,
            retryAfterMilliseconds: 120_000,
          } as const;
        },
      },
    });
    await providerStartedBeforeCompletion(requestStarted.promise, first, "paced Google request");

    assert.deepEqual(await processGoogleConversionDeliveries(
      pool, payloadStore, firstSeed.tenantId, {
        enabled: true,
        credentialsJson: "{}",
        now: () => cycleNow,
        claimLeaseMs: 60_000,
        minimumRequestIntervalMs: 60_000,
        dependencies: {
          accessToken: async () => "synthetic-access-token",
          sendEvent: async () => {
            providerCalls += 1;
            return { outcome: "terminal", reason: "provider_rejected", httpStatus: 400 } as const;
          },
        },
      },
    ), { processed: 0 });
    assert.equal(providerCalls, 1);

    releaseRequest.resolve();
    assert.deepEqual(await within(first, "rate-limited Google request"), { processed: 1 });
    const paced = await withTenant(pool, firstSeed.tenantId, (client) => client.query<{
      next_request_at: Date | string;
      attempts: number[];
      result_count: number;
    }>(
      `SELECT destination.next_request_at,
              array_agg(delivery.attempts ORDER BY delivery.attempts) AS attempts,
              (SELECT count(*)::int
                 FROM ledger.google_conversion_delivery_results AS result
                WHERE result.tenant_id=destination.tenant_id
                  AND result.app_id=destination.app_id) AS result_count
         FROM control.google_data_manager_destinations AS destination
         JOIN ephemeral.google_conversion_deliveries AS delivery
           ON delivery.tenant_id=destination.tenant_id
          AND delivery.destination_id=destination.destination_id
        WHERE destination.tenant_id=$1 AND destination.app_id=$2
        GROUP BY destination.tenant_id,destination.app_id,destination.next_request_at`,
      [firstSeed.tenantId, firstSeed.appId],
    ));
    assert.deepEqual(paced.rows[0]!.attempts, [0, 1]);
    assert.equal(paced.rows[0]!.result_count, 3);
    assert.ok(new Date(paced.rows[0]!.next_request_at).valueOf() >= cycleNow.valueOf() + 120_000);

    await withTenant(pool, firstSeed.tenantId, (client) => client.query(
      `UPDATE control.google_data_manager_destinations
          SET next_request_at=clock_timestamp() - interval '1 second'
        WHERE tenant_id=$1 AND app_id=$2`,
      [firstSeed.tenantId, firstSeed.appId],
    ));
    assert.deepEqual(await processGoogleConversionDeliveries(
      pool, payloadStore, firstSeed.tenantId, {
        enabled: true,
        credentialsJson: "{}",
        now: () => new Date(cycleNow.valueOf() + 121_000),
        claimLeaseMs: 60_000,
        minimumRequestIntervalMs: 60_000,
        dependencies: {
          accessToken: async () => "synthetic-access-token",
          sendEvent: async () => {
            providerCalls += 1;
            return { outcome: "terminal", reason: "provider_rejected", httpStatus: 400 } as const;
          },
        },
      },
    ), { processed: 1 });
    assert.equal(providerCalls, 2);
  });

  it("does not enqueue discovery output after privacy wins the tenant fence", async () => {
    const seeded = await seedEligibleConversion("discovery-privacy");
    const writeStarted = deferred();
    const releaseWrite = deferred();
    let requestRef: string | undefined;
    const blockingStore: PayloadStore = {
      write: async (scope, plaintext) => {
        const reference = await payloadStore.write(scope, plaintext);
        if (scope.objectId.startsWith("google-conversion-")) {
          requestRef = reference;
          writeStarted.resolve();
          await releaseWrite.promise;
        }
        return reference;
      },
      read: (reference) => payloadStore.read(reference),
      purge: (reference) => payloadStore.purge(reference),
      scanFor: (value) => payloadStore.scanFor(value),
    };
    const discovery = discoverGoogleConversionDeliveries(
      pool,
      blockingStore,
      seeded.tenantId,
      new Date(at),
    );
    await within(writeStarted.promise, "Google conversion protected request write");
    await deleteInstallation(seeded);
    releaseWrite.resolve();
    assert.equal(await within(discovery, "privacy-raced Google conversion discovery"), 0);
    const deliveryCount = await withTenant(pool, seeded.tenantId, async (client) => (await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ephemeral.google_conversion_deliveries
        WHERE tenant_id=$1 AND app_id=$2`,
      [seeded.tenantId, seeded.appId],
    )).rows[0].count);
    assert.equal(deliveryCount, 0);
    assert.ok(requestRef);
    await assert.rejects(payloadStore.read(requestRef), PayloadNotFoundError);
  });

  it("does not start a claimed conversion request after privacy recognition", async () => {
    const seeded = await seedEligibleConversion("claimed-privacy");
    assert.equal(await discoverGoogleConversionDeliveries(
      pool, payloadStore, seeded.tenantId, new Date(at)), 1);
    const tokenStarted = deferred();
    const releaseToken = deferred();
    let providerCalls = 0;
    const processing = processGoogleConversionDeliveries(pool, payloadStore, seeded.tenantId, {
      enabled: true,
      credentialsJson: "{}",
      minimumRequestIntervalMs: 0,
      claimLeaseMs: 60_000,
      dependencies: {
        accessToken: async () => {
          tokenStarted.resolve();
          await releaseToken.promise;
          return "synthetic-access-token";
        },
        sendEvent: async () => {
          providerCalls += 1;
          return { outcome: "retry", reason: "provider_unavailable", httpStatus: 503 } as const;
        },
      },
    });
    await within(tokenStarted.promise, "claimed Google conversion token request");
    await deleteInstallation(seeded);
    releaseToken.resolve();
    assert.deepEqual(await within(processing, "deletion-first Google conversion processing"), {
      processed: 0,
    });
    assert.equal(providerCalls, 0);
  });

  it("rejects a provider-first completion after privacy purges the delivery", async () => {
    const seeded = await seedEligibleConversion("provider-first");
    assert.equal(await discoverGoogleConversionDeliveries(
      pool, payloadStore, seeded.tenantId, new Date(at)), 1);
    const request = await withTenant(pool, seeded.tenantId, async (client) => (await client.query<{ request_ref: string }>(
      `SELECT request_ref FROM ephemeral.google_conversion_deliveries
        WHERE tenant_id=$1 AND app_id=$2`,
      [seeded.tenantId, seeded.appId],
    )).rows[0]);
    const providerStarted = deferred();
    const releaseProvider = deferred();
    const processing = processGoogleConversionDeliveries(pool, payloadStore, seeded.tenantId, {
      enabled: true,
      credentialsJson: "{}",
      minimumRequestIntervalMs: 0,
      claimLeaseMs: 60_000,
      dependencies: {
        accessToken: async () => "synthetic-access-token",
        sendEvent: async () => {
          providerStarted.resolve();
          await releaseProvider.promise;
          return {
            outcome: "accepted",
            requestId: "synthetic-provider-request",
            httpStatus: 200,
          } as const;
        },
      },
    });
    await within(providerStarted.promise, "provider-first Google conversion request");
    await within(deleteInstallation(seeded), "provider-first privacy deletion");
    releaseProvider.resolve();
    assert.deepEqual(await within(processing, "provider-first stale completion"), { processed: 0 });
    const evidence = await withTenant(pool, seeded.tenantId, async (client) => (await client.query<{
      deliveries: number;
      results: number;
    }>(
      `SELECT
        (SELECT count(*)::int FROM ephemeral.google_conversion_deliveries
          WHERE tenant_id=$1 AND app_id=$2) AS deliveries,
        (SELECT count(*)::int FROM ledger.google_conversion_delivery_results
          WHERE tenant_id=$1 AND app_id=$2) AS results`,
      [seeded.tenantId, seeded.appId],
    )).rows[0]);
    assert.deepEqual(evidence, { deliveries: 0, results: 1 });
    await assert.rejects(payloadStore.read(request.request_ref), PayloadNotFoundError);
  });

  it("does not poll diagnostics after privacy recognition", async () => {
    const seeded = await seedEligibleConversion("diagnostics-privacy");
    assert.equal(await discoverGoogleConversionDeliveries(
      pool, payloadStore, seeded.tenantId, new Date(at)), 1);
    const acceptedAt = new Date();
    assert.deepEqual(await processGoogleConversionDeliveries(pool, payloadStore, seeded.tenantId, {
      enabled: true,
      credentialsJson: "{}",
      minimumRequestIntervalMs: 0,
      now: () => acceptedAt,
      claimLeaseMs: 60_000,
      dependencies: {
        accessToken: async () => "synthetic-access-token",
        sendEvent: async () => ({
          outcome: "accepted",
          requestId: "synthetic-diagnostic-request",
          httpStatus: 200,
        } as const),
      },
    }), { processed: 1 });
    await withTenant(pool, seeded.tenantId, (client) => client.query(
      `UPDATE ephemeral.google_conversion_deliveries
          SET next_attempt_at=clock_timestamp() - interval '1 second'
        WHERE tenant_id=$1 AND app_id=$2`,
      [seeded.tenantId, seeded.appId],
    ));
    const tokenStarted = deferred();
    const releaseToken = deferred();
    let diagnosticCalls = 0;
    const polling = processGoogleConversionDeliveries(pool, payloadStore, seeded.tenantId, {
      enabled: true,
      credentialsJson: "{}",
      minimumRequestIntervalMs: 0,
      now: () => new Date(acceptedAt.valueOf() + 31 * 60_000),
      claimLeaseMs: 60_000,
      dependencies: {
        accessToken: async () => {
          tokenStarted.resolve();
          await releaseToken.promise;
          return "synthetic-access-token";
        },
        retrieveStatus: async () => {
          diagnosticCalls += 1;
          return {
            outcome: "status",
            status: "success",
            errors: [],
            warnings: [],
          } as const;
        },
      },
    });
    await within(tokenStarted.promise, "claimed diagnostic token request");
    await deleteInstallation(seeded);
    releaseToken.resolve();
    assert.deepEqual(await within(polling, "deletion-first diagnostic polling"), { processed: 0 });
    assert.equal(diagnosticCalls, 0);
  });
});
