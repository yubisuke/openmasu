import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { recordJobOutcome, uuidV7, withTenant, type PayloadStore } from "@openmasu/runtime";
import {
  buildGoogleDataManagerIngestRequest,
  googleDiagnosticPollPlan,
  retrieveGoogleDataManagerRequestStatus,
  sendGoogleDataManagerEvent,
} from "./google-conversion-delivery.js";
import { googleServiceAccountAccessToken } from "./google-service-account.js";

type Candidate = {
  verification_result_id: string; verified_record_id: string; app_id: string;
  destination_id: string; operating_account_id: string; conversion_action_id: string;
  app_audience: "general" | "mixed" | "child_directed"; amount_unscaled: string;
  amount_scale: number; currency: string; occurred_at: string; status: "non_organic" | "organic" | "unattributed";
  finality: "final" | "provisional"; network: string; remote_click_ref: string;
};
type DeliveryRow = {
  delivery_id: string; app_id: string; request_ref: string; request_digest: string;
  transaction_digest: string; state: string; attempts: number; provider_request_id: string | null;
  diagnostics_deadline_at: Date | string | null;
  claim_token: string | null; claimed_until: Date | string | null;
};

type GoogleConversionWorkerDependencies = Readonly<{
  accessToken: typeof googleServiceAccountAccessToken;
  sendEvent: typeof sendGoogleDataManagerEvent;
  retrieveStatus: typeof retrieveGoogleDataManagerRequestStatus;
  claimToken: () => string;
}>;

type ProcessGoogleConversionOptions = {
  readonly enabled: boolean;
  readonly credentialsJson?: string;
  readonly apiBaseUrl?: string;
  readonly tokenUrl?: string;
  readonly now?: () => Date;
  readonly claimLeaseMs?: number;
  readonly dependencies?: Partial<GoogleConversionWorkerDependencies>;
};

export const DEFAULT_GOOGLE_CONVERSION_CLAIM_LEASE_MS = 5 * 60_000;
const MIN_GOOGLE_CONVERSION_CLAIM_LEASE_MS = 1_000;
const MAX_GOOGLE_CONVERSION_CLAIM_LEASE_MS = 15 * 60_000;
const DEFAULT_GOOGLE_CONVERSION_DEPENDENCIES: GoogleConversionWorkerDependencies = {
  accessToken: googleServiceAccountAccessToken,
  sendEvent: sendGoogleDataManagerEvent,
  retrieveStatus: retrieveGoogleDataManagerRequestStatus,
  claimToken: randomUUID,
};

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

async function appendResult(client: PoolClient, tenantId: string, row: DeliveryRow, state: string,
  now: string, reason?: string, providerRequestId?: string): Promise<void> {
  const artifact = { delivery_id: row.delivery_id, tenant_id: tenantId, app_id: row.app_id, state,
    attempt: row.attempts + 1, occurred_at: now, request_digest: row.request_digest,
    ...(providerRequestId ? { provider_request_id: providerRequestId } : {}),
    ...(reason ? { reason_code: reason } : {}) };
  await client.query(
    `INSERT INTO ledger.google_conversion_delivery_results (
       delivery_result_id,delivery_id,tenant_id,app_id,state,attempt,occurred_at,
       request_digest,provider_request_id,reason_code,artifact
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
    [uuidV7(Date.parse(now)), row.delivery_id, tenantId, row.app_id, state, row.attempts + 1,
      now, row.request_digest, providerRequestId ?? null, reason ?? null, JSON.stringify(artifact)],
  );
}

function claimLeaseMilliseconds(value: number | undefined): number {
  const lease = value ?? DEFAULT_GOOGLE_CONVERSION_CLAIM_LEASE_MS;
  if (!Number.isSafeInteger(lease)
    || lease < MIN_GOOGLE_CONVERSION_CLAIM_LEASE_MS
    || lease > MAX_GOOGLE_CONVERSION_CLAIM_LEASE_MS) {
    throw new Error("google_conversion_claim_lease_invalid");
  }
  return lease;
}

async function claimGoogleConversionDeliveries(
  pool: Pool,
  tenantId: string,
  now: Date,
  claimToken: string,
  leaseMs: number,
): Promise<DeliveryRow | undefined> {
  const rows = await withTenant(pool, tenantId, (client) => client.query<DeliveryRow>(
    `WITH due AS (
       SELECT delivery_id
         FROM ephemeral.google_conversion_deliveries
        WHERE tenant_id=$1
          AND state IN ('queued','http_accepted','diagnostics_processing')
          AND next_attempt_at <= clock_timestamp()
          AND (claimed_until IS NULL OR claimed_until <= clock_timestamp())
        ORDER BY next_attempt_at,delivery_id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE ephemeral.google_conversion_deliveries AS delivery
        SET claim_token=$3::uuid,
            claimed_until=clock_timestamp() + ($4::integer * interval '1 millisecond'),
            updated_at=$2
       FROM due
      WHERE delivery.tenant_id=$1 AND delivery.delivery_id=due.delivery_id
     RETURNING delivery.delivery_id::text,delivery.app_id,delivery.request_ref,
       delivery.request_digest,delivery.transaction_digest,delivery.state,delivery.attempts,
       delivery.provider_request_id,delivery.diagnostics_deadline_at,
       delivery.claim_token::text,delivery.claimed_until`,
    [tenantId, now.toISOString(), claimToken, leaseMs],
  ));
  return rows.rows[0];
}

async function finalizeGoogleConversionDelivery(
  pool: Pool,
  tenantId: string,
  row: DeliveryRow,
  completedAt: Date,
  state: string,
  next: Date,
  providerRequestId: string | undefined,
  deadline: Date | undefined,
  reason: string | undefined,
): Promise<boolean> {
  return withTenant(pool, tenantId, async (client) => {
    if (!row.claim_token || !row.claimed_until) {
      throw new Error("google_conversion_claim_missing");
    }
    const updated = await client.query(
      `UPDATE ephemeral.google_conversion_deliveries
          SET state=$4,attempts=attempts+1,next_attempt_at=$5,provider_request_id=$6,
              diagnostics_deadline_at=$7,safe_reason=$8,updated_at=$3,
              claim_token=NULL,claimed_until=NULL
        WHERE tenant_id=$1 AND delivery_id=$2 AND claim_token=$9::uuid
          AND claimed_until > clock_timestamp() AND state=$10
      RETURNING delivery_id`,
      [tenantId, row.delivery_id, completedAt.toISOString(), state, next.toISOString(),
        providerRequestId ?? null, deadline?.toISOString() ?? null,
        reason?.replace(/[^a-z0-9_]/g, "_").slice(0, 64) ?? null, row.claim_token, row.state],
    );
    if (updated.rowCount !== 1) return false;
    await appendResult(
      client,
      tenantId,
      row,
      state,
      completedAt.toISOString(),
      reason,
      providerRequestId,
    );
    return true;
  });
}

export async function discoverGoogleConversionDeliveries(
  pool: Pool, payloadStore: PayloadStore, tenantId: string, now = new Date(),
): Promise<number> {
  const candidates = await withTenant(pool, tenantId, (client) => client.query<Candidate>(
    `SELECT result.verification_result_id::text, result.verified_record_id::text, result.app_id,
            destination.destination_id::text, destination.operating_account_id,
            destination.conversion_action_id, destination.app_audience,
            purchase.amount_unscaled, purchase.amount_scale, purchase.currency,
            purchase.occurred_at, attribution.status,
            attribution.artifact->>'finality' AS finality,
            click.network, click.remote_click_ref
       FROM ledger.google_play_purchase_verification_results result
       JOIN ledger.purchase_facts purchase
         ON purchase.tenant_id=result.tenant_id AND purchase.app_id=result.app_id
        AND purchase.record_id=result.verified_record_id AND purchase.financial_status='settled'
       JOIN ledger.raw_records purchase_raw
         ON purchase_raw.tenant_id=purchase.tenant_id AND purchase_raw.app_id=purchase.app_id
        AND purchase_raw.record_id=purchase.record_id
       JOIN LATERAL (
         SELECT candidate.* FROM ledger.attribution_results candidate
          WHERE candidate.tenant_id=purchase.tenant_id AND candidate.app_id=purchase.app_id
            AND candidate.subject_ref=purchase.installation_id
            AND NOT EXISTS (SELECT 1 FROM ledger.attribution_results newer
              WHERE newer.tenant_id=candidate.tenant_id AND newer.app_id=candidate.app_id
                AND newer.artifact->>'supersedes_attribution_id'=candidate.attribution_id)
          ORDER BY candidate.decided_at DESC,candidate.attribution_id DESC LIMIT 1
       ) attribution ON true
       JOIN ledger.install_facts install
         ON install.tenant_id=purchase.tenant_id AND install.app_id=purchase.app_id
        AND install.installation_id=purchase.installation_id
       JOIN ledger.click_facts click
        ON click.tenant_id=install.tenant_id AND click.app_id=install.app_id AND click.click_id=install.click_id
       JOIN ledger.logical_events click_event ON click_event.logical_event_id=click.logical_event_id
       JOIN ledger.raw_records click_raw
         ON click_raw.tenant_id=click_event.tenant_id AND click_raw.app_id=click_event.app_id
        AND click_raw.record_id=click_event.record_id
       JOIN control.google_data_manager_destinations destination
         ON destination.tenant_id=result.tenant_id AND destination.app_id=result.app_id
        AND destination.enabled=true
      WHERE result.tenant_id=$1 AND result.verdict='verified'
        AND attribution.status='non_organic' AND attribution.artifact->>'finality'='final'
        AND click.network='google_ads' AND click.remote_click_ref IS NOT NULL
        AND purchase_raw.withdrawal_recognized_at IS NULL
        AND click_raw.withdrawal_recognized_at IS NULL
        AND purchase_raw.consent_decision_reason_code <> 'consent_withdrawn'
        AND click_raw.consent_decision_reason_code <> 'consent_withdrawn'
        AND destination.app_audience <> 'child_directed'
        AND NOT EXISTS (SELECT 1 FROM ledger.privacy_tombstones tombstone
          WHERE tombstone.tenant_id=result.tenant_id AND tombstone.app_id=result.app_id
            AND tombstone.record_id IN (result.verified_record_id,click_event.record_id))
        AND NOT EXISTS (SELECT 1 FROM ephemeral.google_conversion_deliveries delivery
          WHERE delivery.tenant_id=result.tenant_id AND delivery.app_id=result.app_id
            AND delivery.verification_result_id=result.verification_result_id
            AND delivery.destination_id=destination.destination_id)
      ORDER BY result.verification_result_id`,
    [tenantId],
  ));
  let created = 0;
  for (const candidate of candidates.rows) {
    const prepared = buildGoogleDataManagerIngestRequest({
      verifiedResultId: candidate.verification_result_id, verificationVerdict: "verified",
      verifiedRecordId: candidate.verified_record_id, financialStatus: "settled",
      attributionStatus: candidate.status, attributionFinality: candidate.finality,
      clickNetwork: candidate.network, sourceQualifiedGclid: candidate.remote_click_ref,
      destinationEnabled: true, appAudience: candidate.app_audience, redacted: false, withdrawn: false,
      amountUnscaled: candidate.amount_unscaled, amountScale: candidate.amount_scale,
      currency: candidate.currency, eventTimestamp: candidate.occurred_at,
      operatingAccountId: candidate.operating_account_id, conversionActionId: candidate.conversion_action_id,
    });
    const deliveryId = uuidV7(now.valueOf() + created);
    const requestRef = await payloadStore.write({ tenantId, appId: candidate.app_id,
      objectId: `google-conversion-${deliveryId}` }, prepared.body);
    try {
      const inserted = await withTenant(pool, tenantId, async (client) => {
        const result = await client.query(
          `INSERT INTO ephemeral.google_conversion_deliveries (
             delivery_id,tenant_id,app_id,destination_id,verification_result_id,verified_record_id,
             request_ref,request_digest,transaction_digest,state,attempts,next_attempt_at,
             created_at,updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',0,$10::text::timestamptz,$10,$10)
           ON CONFLICT (tenant_id,app_id,verification_result_id,destination_id) DO NOTHING RETURNING delivery_id`,
          [deliveryId, tenantId, candidate.app_id, candidate.destination_id, candidate.verification_result_id,
            candidate.verified_record_id, requestRef, sha256(prepared.body), sha256(prepared.transactionId), now.toISOString()],
        );
        if (result.rowCount === 1) await appendResult(client, tenantId, {
          delivery_id: deliveryId, app_id: candidate.app_id, request_ref: requestRef,
          request_digest: sha256(prepared.body), transaction_digest: sha256(prepared.transactionId),
          state: "queued", attempts: -1, provider_request_id: null, diagnostics_deadline_at: null,
          claim_token: null, claimed_until: null,
        }, "queued", now.toISOString());
        return result.rowCount === 1;
      });
      if (inserted) created += 1; else await payloadStore.purge(requestRef);
    } catch (error) { await payloadStore.purge(requestRef); throw error; }
  }
  return created;
}

export async function processGoogleConversionDeliveries(pool: Pool, payloadStore: PayloadStore, tenantId: string,
  options: ProcessGoogleConversionOptions,
): Promise<{ processed: number }> {
  if (!options.enabled) return { processed: 0 };
  if (!options.credentialsJson) throw new Error("google_data_manager_credentials_missing");
  const dependencies = { ...DEFAULT_GOOGLE_CONVERSION_DEPENDENCIES, ...options.dependencies };
  const leaseMs = claimLeaseMilliseconds(options.claimLeaseMs);
  let accessToken: string | undefined;
  let processed = 0;
  for (let claimed = 0; claimed < 100; claimed += 1) {
    const now = options.now?.() ?? new Date();
    const row = await claimGoogleConversionDeliveries(
      pool,
      tenantId,
      now,
      dependencies.claimToken(),
      leaseMs,
    );
    if (!row) break;
    accessToken ??= await dependencies.accessToken({ credentialsJson: options.credentialsJson,
      scope: "https://www.googleapis.com/auth/datamanager", tokenUrl: options.tokenUrl });
    let state = row.state; let reason: string | undefined; let providerRequestId = row.provider_request_id ?? undefined;
    let next = new Date(now.valueOf() + Math.min(900_000, 60_000 * (2 ** Math.min(row.attempts, 4))));
    let deadline = row.diagnostics_deadline_at ? new Date(row.diagnostics_deadline_at) : undefined;
    if (row.state === "queued") {
      const body = await payloadStore.read(row.request_ref);
      if (sha256(body) !== row.request_digest) throw new Error("google_conversion_request_digest_mismatch");
      const request = JSON.parse(body.toString("utf8")) as any;
      const transactionId = String(request.events?.[0]?.transactionId);
      if (sha256(transactionId) !== row.transaction_digest) {
        throw new Error("google_conversion_transaction_digest_mismatch");
      }
      const result = await dependencies.sendEvent({ transactionId, request, body },
        { accessToken, baseUrl: options.apiBaseUrl });
      if (result.outcome === "accepted") {
        state = "http_accepted"; providerRequestId = result.requestId;
        next = new Date(now.valueOf() + 30 * 60_000); deadline = new Date(now.valueOf() + 24 * 60 * 60_000);
      } else if (result.outcome === "terminal") { state = "failed"; reason = result.reason; }
      else reason = result.reason;
    } else if (providerRequestId && deadline) {
      if (now >= deadline) { state = "expired"; reason = "diagnostics_expired"; }
      else {
        const result = await dependencies.retrieveStatus(providerRequestId,
          { accessToken, baseUrl: options.apiBaseUrl });
        if (result.outcome === "status") {
          if (result.status === "processing") {
            state = "diagnostics_processing";
            const plan = googleDiagnosticPollPlan({ pollAttempt: row.attempts,
              acceptedAt: new Date(deadline.valueOf() - 24 * 60 * 60_000).toISOString(), now: now.toISOString() });
            next = new Date(now.valueOf() + (plan.outcome === "poll_after" ? plan.delayMilliseconds : 0));
          } else state = result.status === "success" ? "succeeded" : result.status === "partial_success" ? "partial_success" : "failed";
          if (result.errors.length) reason = result.errors[0]!.reason.toLowerCase();
        } else if (result.outcome === "terminal") { state = "failed"; reason = result.reason; }
        else reason = result.reason;
      }
    }
    const completedAt = options.now?.() ?? new Date();
    const finalized = await finalizeGoogleConversionDelivery(
      pool, tenantId, row, completedAt, state, next, providerRequestId, deadline, reason,
    );
    if (!finalized) continue;
    processed += 1;
    if (["succeeded", "partial_success", "failed", "expired"].includes(state)) await payloadStore.purge(row.request_ref);
    await recordJobOutcome({ pool, tenantId, appId: row.app_id, job: "google_conversion_delivery", outcome: "succeeded", now: completedAt });
  }
  return { processed };
}
