import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  acquirePrivacyTenantXactFence,
  PayloadNotFoundError,
  uuidV7,
  withTenant,
  type PayloadStore,
} from "@openmasu/runtime";

type JsonObject = Record<string, unknown>;

export type PendingAdServicesLookup = {
  readonly tenantId: string;
  readonly appId: string;
  readonly installRecordId: string;
  readonly tokenRef: string;
  readonly tokenCreatedAt: string;
};

type LookupRow = {
  lookup_id: string;
  tenant_id: string;
  app_id: string;
  install_record_id: string;
  token_ref: string;
  token_created_at: Date;
  attempts: number;
  claim_token: string | null;
  claimed_until: Date | string | null;
};

export type AdServicesResponse = {
  readonly status: number;
  readonly body: Buffer;
};

export type AdServicesHttpClient = (input: {
  readonly endpoint: string;
  readonly token: string;
}) => Promise<AdServicesResponse>;

export const DEFAULT_ADSERVICES_CLAIM_LEASE_MS = 5 * 60_000;
export const DEFAULT_ADSERVICES_REQUEST_TIMEOUT_MS = 30_000;
const MIN_ADSERVICES_CLAIM_LEASE_MS = 1_000;
const MAX_ADSERVICES_CLAIM_LEASE_MS = 15 * 60_000;
const MIN_ADSERVICES_REQUEST_TIMEOUT_MS = 10;
const MAX_ADSERVICES_REQUEST_TIMEOUT_MS = 2 * 60_000;

export class AdServicesLookupLimiter {
  readonly #entries = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    readonly ratePerSecond: number,
    readonly burst: number,
    readonly now: () => number = () => Date.now(),
  ) {
    if (!(ratePerSecond > 0) || !(burst >= 1)) throw new Error("invalid AdServices rate limit");
  }

  allow(key: string): boolean {
    const now = this.now();
    const prior = this.#entries.get(key) ?? { tokens: this.burst, updatedAt: now };
    const tokens = Math.min(this.burst, prior.tokens + (now - prior.updatedAt) / 1_000 * this.ratePerSecond);
    if (tokens < 1) {
      this.#entries.set(key, { tokens, updatedAt: now });
      return false;
    }
    this.#entries.set(key, { tokens: tokens - 1, updatedAt: now });
    return true;
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  reason: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(reason);
  }
  return selected;
}

async function withRequestTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("adservices_request_timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
  }
}

function parseObject(body: Buffer): JsonObject {
  if (body.length > 64 * 1024) throw new Error("adservices_response_too_large");
  const parsed: unknown = JSON.parse(body.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("adservices_response_invalid");
  }
  return parsed as JsonObject;
}

function optionalId(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  const rendered = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : typeof value === "string" && /^[0-9]+$/.test(value) ? value : "";
  if (!rendered) throw new Error(`adservices_${name}_invalid`);
  return rendered;
}

function optionalEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`adservices_${name}_invalid`);
  return value as T;
}

function optionalText(value: unknown, name: string, pattern?: RegExp): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || (pattern && !pattern.test(value))) {
    throw new Error(`adservices_${name}_invalid`);
  }
  return value;
}

export function normalizeAdServicesResponse(body: Buffer): JsonObject {
  const value = parseObject(body);
  if (typeof value.attribution !== "boolean") throw new Error("adservices_attribution_invalid");
  if (!value.attribution) return { status: "not_attributed", attribution: false };
  return {
    status: "attributed",
    attribution: true,
    ...Object.fromEntries([
      ["org_id", optionalId(value.orgId, "org_id")],
      ["campaign_id", optionalId(value.campaignId, "campaign_id")],
      ["ad_group_id", optionalId(value.adGroupId, "ad_group_id")],
      ["keyword_id", optionalId(value.keywordId, "keyword_id")],
      ["ad_id", optionalId(value.adId, "ad_id")],
      ["conversion_type", optionalEnum(value.conversionType, "conversion_type", ["Download", "Redownload", "PreOrder"] as const)],
      ["claim_type", optionalEnum(value.claimType, "claim_type", ["Click", "Impression"] as const)],
      ["country_or_region", optionalText(value.countryOrRegion, "country_or_region", /^[A-Z]{2}$/)],
      ["supply_placement", optionalText(value.supplyPlacement, "supply_placement")],
      ["click_date", optionalText(value.clickDate, "click_date")],
      ["impression_date", optionalText(value.impressionDate, "impression_date")],
    ].filter((entry): entry is [string, string] => entry[1] !== undefined)),
  };
}

export async function queueAdServicesLookup(pool: Pool, input: PendingAdServicesLookup): Promise<void> {
  const lookupId = uuidV7(Date.parse(input.tokenCreatedAt));
  const artifact = {
    lookup_id: lookupId,
    tenant_id: input.tenantId,
    app_id: input.appId,
    install_record_id: input.installRecordId,
    token_ref: input.tokenRef,
    token_created_at: input.tokenCreatedAt,
    attempts: 0,
    next_attempt_at: input.tokenCreatedAt,
    created_at: input.tokenCreatedAt,
  };
  await withTenant(pool, input.tenantId, (client) => client.query(
    `INSERT INTO ephemeral.adservices_lookups (
      lookup_id, tenant_id, app_id, install_record_id, token_ref,
      token_created_at, attempts, next_attempt_at, created_at, artifact
    )
    SELECT $1::uuid,$2::control.identifier,$3::control.identifier,$4::control.identifier,
           $5::text,$6::timestamptz,0,$6::timestamptz,$6::timestamptz,$7::jsonb
    WHERE NOT EXISTS (
      SELECT 1 FROM ledger.adservices_lookup_results result
      WHERE result.tenant_id=$2::control.identifier AND result.app_id=$3::control.identifier
        AND result.install_record_id=$4::control.identifier
    )
    ON CONFLICT (tenant_id, app_id, install_record_id) DO NOTHING`,
    [lookupId, input.tenantId, input.appId, input.installRecordId, input.tokenRef,
      input.tokenCreatedAt, JSON.stringify(artifact)],
  ).then(() => undefined));
}

async function tokenFor(payloadStore: PayloadStore, row: LookupRow): Promise<string> {
  const body = JSON.parse((await payloadStore.read(row.token_ref)).toString("utf8")) as JsonObject;
  if (!Array.isArray(body.records)) throw new Error("adservices_token_batch_invalid");
  const record = body.records.find((candidate: unknown) =>
    !!candidate && typeof candidate === "object"
      && (candidate as JsonObject).record_id === row.install_record_id,
  ) as JsonObject | undefined;
  const payload = record?.payload as JsonObject | undefined;
  const extensions = payload?.extensions as JsonObject | undefined;
  const token = extensions?.adservices_attribution_token_protected;
  if (typeof token !== "string" || token.length < 1 || Buffer.byteLength(token, "utf8") > 64 * 1024) {
    throw new Error("adservices_token_missing");
  }
  return token;
}

async function installAttribution(client: PoolClient, row: LookupRow): Promise<JsonObject> {
  const result = await client.query<{ artifact: JsonObject }>(
    `SELECT attribution.artifact
     FROM ledger.raw_records AS raw
     JOIN ledger.logical_events AS logical
       ON logical.tenant_id=raw.tenant_id AND logical.app_id=raw.app_id
      AND logical.record_id=raw.record_id
     JOIN ledger.install_facts AS install
       ON install.tenant_id=logical.tenant_id AND install.app_id=logical.app_id
      AND install.logical_event_id=logical.logical_event_id
     JOIN LATERAL (
       SELECT candidate.artifact
       FROM ledger.attribution_results AS candidate
       WHERE candidate.tenant_id=raw.tenant_id AND candidate.app_id=raw.app_id
         AND candidate.subject_scope='installation_level'
         AND candidate.subject_ref=install.installation_id
       ORDER BY candidate.decided_at DESC, candidate.attribution_id DESC
       LIMIT 1
     ) AS attribution ON true
     WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.record_id=$3`,
    [row.tenant_id, row.app_id, row.install_record_id],
  );
  if (!result.rows[0]) throw new Error("adservices_install_attribution_missing");
  return result.rows[0].artifact;
}

function terminalContext(status: "token_expired" | "lookup_unavailable"): JsonObject {
  return { status, attribution: false };
}

async function claimAdServicesLookup(
  pool: Pool,
  tenantId: string,
  now: Date,
  claimToken: string,
  leaseMs: number,
): Promise<LookupRow | undefined> {
  const expiredBefore = new Date(now.getTime() - 23 * 60 * 60 * 1_000);
  const claimed = await withTenant(pool, tenantId, (client) => client.query<LookupRow>(
    `WITH due AS (
       SELECT lookup_id
         FROM ephemeral.adservices_lookups
        WHERE tenant_id=$1
          AND (next_attempt_at <= $2 OR token_created_at <= $3)
          AND (claimed_until IS NULL OR claimed_until <= clock_timestamp())
        ORDER BY next_attempt_at,lookup_id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE ephemeral.adservices_lookups AS lookup
        SET claim_token=$4::uuid,
            claimed_until=clock_timestamp() + ($5::integer * interval '1 millisecond')
       FROM due
      WHERE lookup.tenant_id=$1 AND lookup.lookup_id=due.lookup_id
     RETURNING lookup.lookup_id::text,lookup.tenant_id,lookup.app_id,
       lookup.install_record_id,lookup.token_ref,lookup.token_created_at,lookup.attempts,
       lookup.claim_token::text,lookup.claimed_until`,
    [tenantId, now.toISOString(), expiredBefore.toISOString(), claimToken, leaseMs],
  ));
  return claimed.rows[0];
}

async function lockCurrentCompletion(client: PoolClient, row: LookupRow): Promise<boolean> {
  if (!row.claim_token || !row.claimed_until) throw new Error("adservices_claim_missing");
  const current = await client.query(
    `SELECT 1
       FROM ephemeral.adservices_lookups AS lookup
       JOIN ledger.raw_records_current AS raw
         ON raw.tenant_id=lookup.tenant_id AND raw.app_id=lookup.app_id
        AND raw.record_id=lookup.install_record_id
      WHERE lookup.tenant_id=$1 AND lookup.app_id=$2 AND lookup.lookup_id=$3::uuid
        AND lookup.claim_token=$4::uuid AND lookup.claimed_until > clock_timestamp()
        AND raw.payload_lifecycle_status='available'
      FOR UPDATE OF lookup`,
    [row.tenant_id, row.app_id, row.lookup_id, row.claim_token],
  );
  return current.rowCount === 1;
}

async function completeLookup(
  pool: Pool,
  payloadStore: PayloadStore,
  row: LookupRow,
  context: JsonObject,
  responseBody: Buffer,
  now: Date,
): Promise<boolean> {
  const responseDigest = sha256(responseBody);
  let responseRef: string | undefined;
  try {
    const committed = await withTenant(pool, row.tenant_id, async (client) => {
      await acquirePrivacyTenantXactFence(client, row.tenant_id, "shared");
      if (!await lockCurrentCompletion(client, row)) return false;
      responseRef = await payloadStore.write(
        { tenantId: row.tenant_id, appId: row.app_id, objectId: `adservices-result-${row.lookup_id}` },
        responseBody,
      );
      const prior = await installAttribution(client, row);
      const reasonCode = context.status === "attributed"
        ? "adservices_attributed"
        : context.status === "not_attributed"
          ? "adservices_not_attributed"
          : context.status === "token_expired"
            ? "adservices_token_expired"
            : "adservices_lookup_unavailable";
      const replacementId = `attr:adservices:${sha256([
        row.tenant_id, row.app_id, row.install_record_id, responseDigest, reasonCode,
      ].join("\u0000")).slice(0, 48)}`;
      const replacement: JsonObject = {
        ...prior,
        attribution_id: replacementId,
        status: context.status === "attributed" ? "non_organic" : "unattributed",
        method: "apple_adservices",
        model: "last_click",
        reason_code: reasonCode,
        evidence_refs: [
          ...(Array.isArray(prior.evidence_refs) ? prior.evidence_refs : []),
          {
            tenant_id: row.tenant_id,
            app_id: row.app_id,
            ref: responseRef,
            lifecycle_status: "available",
            access_class: "protected",
          },
        ],
        decided_at: now.toISOString(),
        input_cutoff_at: now.toISOString(),
        finality: "final",
        supersedes_attribution_id: prior.attribution_id,
      };
      await client.query(
        `INSERT INTO ledger.attribution_results (
          attribution_id, tenant_id, app_id, subject_scope, subject_ref, effective_at,
          decided_at, status, method, model, reason_code, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [replacementId, row.tenant_id, row.app_id, replacement.subject_scope,
          replacement.subject_ref, replacement.effective_at, replacement.decided_at,
          replacement.status, replacement.method, replacement.model,
          replacement.reason_code, JSON.stringify(replacement)],
      );
      const resultId = uuidV7(now.getTime());
      const resultArtifact = {
        lookup_result_id: resultId,
        tenant_id: row.tenant_id,
        app_id: row.app_id,
        install_record_id: row.install_record_id,
        attribution_id: replacementId,
        status: context.status,
        response_ref: responseRef,
        response_digest: responseDigest,
        adservices_context: context,
        decided_at: now.toISOString(),
      };
      await client.query(
        `INSERT INTO ledger.adservices_lookup_results (
          lookup_result_id, tenant_id, app_id, install_record_id, attribution_id,
          status, response_ref, response_digest, decided_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [resultId, row.tenant_id, row.app_id, row.install_record_id, replacementId,
          context.status, responseRef, responseDigest, now.toISOString(), JSON.stringify(resultArtifact)],
      );
      await client.query(
        `DELETE FROM ephemeral.adservices_lookups
          WHERE tenant_id=$1 AND app_id=$2 AND lookup_id=$3::uuid AND claim_token=$4::uuid`,
        [row.tenant_id, row.app_id, row.lookup_id, row.claim_token],
      );
      return true;
    });
    return committed;
  } catch (error) {
    if (responseRef) await payloadStore.purge(responseRef);
    throw error;
  }
}

async function reschedule(
  pool: Pool,
  row: LookupRow,
  attempts: number,
  nextAttemptAt: Date,
  reason: string,
): Promise<boolean> {
  if (!row.claim_token || !row.claimed_until) throw new Error("adservices_claim_missing");
  return withTenant(pool, row.tenant_id, async (client) => (await client.query(
    `UPDATE ephemeral.adservices_lookups
     SET attempts=$4, next_attempt_at=$5,
         claim_token=NULL, claimed_until=NULL,
         artifact=artifact || $6::jsonb
     WHERE tenant_id=$1 AND app_id=$2 AND lookup_id=$3::uuid
       AND claim_token=$7::uuid AND claimed_until > clock_timestamp()`,
    [row.tenant_id, row.app_id, row.lookup_id, attempts, nextAttemptAt.toISOString(), JSON.stringify({
      attempts,
      next_attempt_at: nextAttemptAt.toISOString(),
      last_outcome: reason,
    }), row.claim_token],
  )).rowCount === 1);
}

async function dropUnavailableToken(pool: Pool, row: LookupRow): Promise<boolean> {
  if (!row.claim_token || !row.claimed_until) throw new Error("adservices_claim_missing");
  return withTenant(pool, row.tenant_id, async (client) => (await client.query(
    `DELETE FROM ephemeral.adservices_lookups
      WHERE tenant_id=$1 AND app_id=$2 AND lookup_id=$3::uuid
        AND claim_token=$4::uuid AND claimed_until > clock_timestamp()`,
    [row.tenant_id, row.app_id, row.lookup_id, row.claim_token],
  )).rowCount === 1);
}

async function defaultClient(
  input: { endpoint: string; token: string },
  signal: AbortSignal,
): Promise<AdServicesResponse> {
  const response = await fetch(input.endpoint, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: input.token,
    redirect: "error",
    signal,
  });
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
}

function checkedEndpoint(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("adservices_endpoint_must_be_https_or_loopback");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("adservices_endpoint_invalid");
  return url.toString();
}

export async function processAdServicesLookups(
  pool: Pool,
  payloadStore: PayloadStore,
  tenantId: string,
  options: {
    readonly endpoint?: string;
    readonly enabled?: boolean;
    readonly client?: AdServicesHttpClient;
    readonly limiter?: AdServicesLookupLimiter;
    readonly now?: () => Date;
    readonly claimLeaseMs?: number;
    readonly requestTimeoutMs?: number;
    readonly claimToken?: () => string;
  } = {},
): Promise<{ readonly completed: number; readonly retried: number }> {
  if (options.enabled === false) return { completed: 0, retried: 0 };
  const now = options.now?.() ?? new Date();
  const endpoint = checkedEndpoint(options.endpoint ?? "https://api-adservices.apple.com/api/v1/");
  const claimLeaseMs = boundedInteger(
    options.claimLeaseMs,
    DEFAULT_ADSERVICES_CLAIM_LEASE_MS,
    MIN_ADSERVICES_CLAIM_LEASE_MS,
    MAX_ADSERVICES_CLAIM_LEASE_MS,
    "adservices_claim_lease_invalid",
  );
  const requestTimeoutMs = boundedInteger(
    options.requestTimeoutMs,
    DEFAULT_ADSERVICES_REQUEST_TIMEOUT_MS,
    MIN_ADSERVICES_REQUEST_TIMEOUT_MS,
    MAX_ADSERVICES_REQUEST_TIMEOUT_MS,
    "adservices_request_timeout_invalid",
  );
  if (requestTimeoutMs >= claimLeaseMs) {
    throw new Error("adservices_request_timeout_must_be_shorter_than_claim_lease");
  }
  let completed = 0;
  let retried = 0;
  for (let processed = 0; processed < 100; processed += 1) {
    const row = await claimAdServicesLookup(
      pool,
      tenantId,
      now,
      (options.claimToken ?? randomUUID)(),
      claimLeaseMs,
    );
    if (!row) break;
    if (now.getTime() - new Date(row.token_created_at).getTime() >= 23 * 60 * 60 * 1_000) {
      if (await completeLookup(pool, payloadStore, row, terminalContext("token_expired"),
        Buffer.from('{"status":"token_expired"}', "utf8"), now)) completed += 1;
      continue;
    }
    if (options.limiter && !options.limiter.allow(`${row.tenant_id}\u0000${row.app_id}`)) {
      if (await reschedule(
        pool,
        row,
        row.attempts,
        new Date(now.getTime() + 1_000),
        "rate_limited",
      )) retried += 1;
      continue;
    }
    let token: string;
    try {
      token = await tokenFor(payloadStore, row);
    } catch (error) {
      if (!(error instanceof PayloadNotFoundError)
        && (!(error instanceof Error) || error.message !== "adservices_token_missing")) throw error;
      if (await dropUnavailableToken(pool, row)) completed += 1;
      continue;
    }
    let response: AdServicesResponse;
    let transportFailure: string | undefined;
    try {
      response = await withRequestTimeout(requestTimeoutMs, (signal) => options.client
        ? options.client({ endpoint, token })
        : defaultClient({ endpoint, token }, signal));
    } catch (error) {
      transportFailure = error instanceof Error && error.message === "adservices_request_timeout"
        ? "request_timeout"
        : "network_failure";
      response = {
        status: 500,
        body: Buffer.from(JSON.stringify({ error: transportFailure }), "utf8"),
      };
    }
    if (response.status === 200) {
      const context = normalizeAdServicesResponse(response.body);
      if (await completeLookup(pool, payloadStore, row, context, response.body, now)) completed += 1;
      continue;
    }
    if (response.status === 400) {
      if (await completeLookup(
        pool,
        payloadStore,
        row,
        terminalContext("lookup_unavailable"),
        response.body,
        now,
      )) completed += 1;
      continue;
    }
    if (response.status === 404) {
      const attempts = row.attempts + 1;
      if (attempts >= 3) {
        if (await completeLookup(
          pool,
          payloadStore,
          row,
          terminalContext("lookup_unavailable"),
          response.body,
          now,
        )) completed += 1;
      } else {
        if (await reschedule(
          pool,
          row,
          attempts,
          new Date(now.getTime() + 5_000),
          "not_found",
        )) retried += 1;
      }
      continue;
    }
    const attempts = Math.min(3, row.attempts + 1);
    const backoffMs = Math.min(3_600_000, 60_000 * (2 ** Math.min(attempts, 3)));
    if (await reschedule(
      pool,
      row,
      attempts,
      new Date(now.getTime() + backoffMs),
      transportFailure ?? `http_${response.status}`,
    )) retried += 1;
  }
  return { completed, retried };
}
