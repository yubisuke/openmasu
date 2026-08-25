import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { uuidV7, withTenant, type PayloadStore } from "@openmasu/runtime";

type JsonObject = Record<string, unknown>;
export type IntegrityProvider = "play_integrity" | "app_attest";
export type IntegrityVerdict = "verified" | "failed" | "unavailable";

export type PendingIntegrityVerification = {
  readonly tenantId: string;
  readonly appId: string;
  readonly subjectRecordId: string;
  readonly provider: IntegrityProvider;
  readonly tokenRef: string;
  readonly bindingDigest: string;
  readonly requestedAt: string;
};

type VerificationRow = {
  verification_id: string;
  tenant_id: string;
  app_id: string;
  provider: IntegrityProvider;
  token_ref: string;
  subject_record_id: string;
  challenge_digest: string;
};

export type IntegrityProviderResponse = { readonly status: number; readonly body: Buffer };
export type IntegrityProviderClient = (input: {
  readonly provider: IntegrityProvider;
  readonly endpoint: string;
  readonly token: string;
  readonly bindingDigest: string;
}) => Promise<IntegrityProviderResponse>;

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function object(body: Buffer): JsonObject {
  if (body.length > 64 * 1024) throw new Error("integrity_response_too_large");
  const parsed: unknown = JSON.parse(body.toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("integrity_response_invalid");
  return parsed as JsonObject;
}

/** Normalize only provider-verified server responses; a device-authored parsed verdict never reaches here. */
export function normalizeIntegrityResponse(
  provider: IntegrityProvider,
  body: Buffer,
  bindingDigest: string,
): { readonly verdict: "verified" | "failed"; readonly details: JsonObject } {
  const value = object(body);
  if (provider === "play_integrity") {
    const requestDetails = value.requestDetails as JsonObject | undefined;
    const appIntegrity = value.appIntegrity as JsonObject | undefined;
    const deviceIntegrity = value.deviceIntegrity as JsonObject | undefined;
    const binding = requestDetails?.requestHash ?? requestDetails?.nonce;
    const deviceVerdicts = deviceIntegrity?.deviceRecognitionVerdict;
    const verified = binding === bindingDigest
      && appIntegrity?.appRecognitionVerdict === "PLAY_RECOGNIZED"
      && Array.isArray(deviceVerdicts)
      && deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY");
    return {
      verdict: verified ? "verified" : "failed",
      details: {
        binding_matched: binding === bindingDigest,
        app_recognized: appIntegrity?.appRecognitionVerdict === "PLAY_RECOGNIZED",
        device_integrity_met: Array.isArray(deviceVerdicts) && deviceVerdicts.includes("MEETS_DEVICE_INTEGRITY"),
      },
    };
  }
  const verified = value.binding_digest === bindingDigest
    && value.app_id_valid === true
    && value.signature_valid === true
    && value.counter_valid === true;
  return {
    verdict: verified ? "verified" : "failed",
    details: {
      binding_matched: value.binding_digest === bindingDigest,
      app_id_valid: value.app_id_valid === true,
      signature_valid: value.signature_valid === true,
      counter_valid: value.counter_valid === true,
    },
  };
}

export function classifyIntegrityProviderResponse(
  provider: IntegrityProvider,
  response: IntegrityProviderResponse,
  bindingDigest: string,
): { readonly verdict: IntegrityVerdict; readonly retainEvidence: boolean } {
  if (response.status === 429 || response.status >= 500) {
    return { verdict: "unavailable", retainEvidence: false };
  }
  if (response.status !== 200) return { verdict: "failed", retainEvidence: true };
  try {
    return {
      verdict: normalizeIntegrityResponse(provider, response.body, bindingDigest).verdict,
      retainEvidence: true,
    };
  } catch {
    return { verdict: "failed", retainEvidence: true };
  }
}

export async function queueIntegrityVerification(pool: Pool, input: PendingIntegrityVerification): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(input.bindingDigest)) throw new Error("integrity_binding_digest_invalid");
  const verificationId = uuidV7(Date.parse(input.requestedAt));
  await withTenant(pool, input.tenantId, (client) => client.query(
    `INSERT INTO ephemeral.integrity_verifications (
      verification_id, tenant_id, app_id, provider, token_ref, subject_record_id,
      attempts, next_attempt_at, challenge_digest
    )
    SELECT $1::uuid,$2::control.identifier,$3::control.identifier,$4::text,$5::text,
      $6::control.identifier,0,$7::timestamptz,$8::text
    WHERE NOT EXISTS (
      SELECT 1 FROM ledger.integrity_verification_results result
      WHERE result.tenant_id=$2::control.identifier AND result.app_id=$3::control.identifier
        AND result.provider=$4::text AND result.binding_digest=$8::text
    )
    ON CONFLICT (tenant_id, app_id, provider, challenge_digest) DO NOTHING`,
    [verificationId, input.tenantId, input.appId, input.provider, input.tokenRef,
      input.subjectRecordId, input.requestedAt, input.bindingDigest],
  ).then(() => undefined));
}

async function tokenFor(payloadStore: PayloadStore, row: VerificationRow): Promise<string> {
  const body = JSON.parse((await payloadStore.read(row.token_ref)).toString("utf8")) as JsonObject;
  if (!Array.isArray(body.records)) throw new Error("integrity_token_batch_invalid");
  const record = body.records.find((candidate: unknown) =>
    !!candidate && typeof candidate === "object"
      && (candidate as JsonObject).record_id === row.subject_record_id,
  ) as JsonObject | undefined;
  const payload = record?.payload as JsonObject | undefined;
  const extensions = payload?.extensions as JsonObject | undefined;
  const token = extensions?.integrity_token_protected;
  if (typeof token !== "string" || token.length < 1 || Buffer.byteLength(token, "utf8") > 64 * 1024) {
    throw new Error("integrity_token_missing");
  }
  return token;
}

function checkedEndpoint(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("integrity_endpoint_must_be_https_or_loopback");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("integrity_endpoint_invalid");
  return url.toString();
}

async function defaultClient(input: {
  provider: IntegrityProvider;
  endpoint: string;
  token: string;
  bindingDigest: string;
}): Promise<IntegrityProviderResponse> {
  const response = await fetch(input.endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: input.provider, token: input.token, binding_digest: input.bindingDigest }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
}

async function complete(
  pool: Pool,
  payloadStore: PayloadStore,
  row: VerificationRow,
  verdict: IntegrityVerdict,
  responseBody: Buffer | undefined,
  now: Date,
): Promise<void> {
  const responseDigest = responseBody && verdict !== "unavailable" ? sha256(responseBody) : undefined;
  const evidenceRef = responseBody && verdict !== "unavailable"
    ? await payloadStore.write(
      { tenantId: row.tenant_id, appId: row.app_id, objectId: `integrity-result-${row.verification_id}` },
      responseBody,
    )
    : undefined;
  try {
    const resultId = uuidV7(now.getTime());
    const integrityVerdict = {
      provider: row.provider,
      verdict,
      ...(evidenceRef ? { evidence_ref: evidenceRef } : {}),
    };
    const artifact = {
      verification_result_id: resultId,
      tenant_id: row.tenant_id,
      app_id: row.app_id,
      subject_record_id: row.subject_record_id,
      integrity_verdict: integrityVerdict,
      binding_digest: row.challenge_digest,
      decided_at: now.toISOString(),
      observation_mode: true,
    };
    await withTenant(pool, row.tenant_id, async (client) => {
      await client.query(
        `INSERT INTO ledger.integrity_verification_results (
          verification_result_id, tenant_id, app_id, subject_record_id, provider,
          verdict, evidence_ref, response_digest, binding_digest, decided_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT (tenant_id, app_id, provider, binding_digest) DO NOTHING`,
        [resultId, row.tenant_id, row.app_id, row.subject_record_id, row.provider,
          verdict, evidenceRef ?? null, responseDigest ?? null, row.challenge_digest,
          now.toISOString(), JSON.stringify(artifact)],
      );
      await client.query(
        "DELETE FROM ephemeral.integrity_verifications WHERE tenant_id=$1 AND app_id=$2 AND verification_id=$3",
        [row.tenant_id, row.app_id, row.verification_id],
      );
    });
  } catch (error) {
    if (evidenceRef) await payloadStore.purge(evidenceRef);
    throw error;
  }
}

export async function processIntegrityVerifications(
  pool: Pool,
  payloadStore: PayloadStore,
  tenantId: string,
  options: {
    readonly providerMode?: "off" | IntegrityProvider | "both";
    readonly playEndpoint?: string;
    readonly appAttestEndpoint?: string;
    readonly client?: IntegrityProviderClient;
    readonly now?: () => Date;
  } = {},
): Promise<{ readonly completed: number; readonly unavailable: number }> {
  const mode = options.providerMode ?? "off";
  if (mode === "off") return { completed: 0, unavailable: 0 };
  const now = options.now?.() ?? new Date();
  const rows = await withTenant(pool, tenantId, (client) => client.query<VerificationRow>(
    `SELECT verification_id::text, tenant_id, app_id, provider, token_ref,
            subject_record_id, challenge_digest
     FROM ephemeral.integrity_verifications
     WHERE tenant_id=$1 AND next_attempt_at <= $2
       AND ($3='both' OR provider=$3)
     ORDER BY next_attempt_at, verification_id
     LIMIT 100`,
    [tenantId, now.toISOString(), mode],
  ));
  let completed = 0;
  let unavailable = 0;
  for (const row of rows.rows) {
    const endpointValue = row.provider === "play_integrity" ? options.playEndpoint : options.appAttestEndpoint;
    if (!endpointValue) {
      await complete(pool, payloadStore, row, "unavailable", undefined, now);
      completed += 1;
      unavailable += 1;
      continue;
    }
    let token: string;
    try {
      token = await tokenFor(payloadStore, row);
    } catch {
      await complete(pool, payloadStore, row, "unavailable", undefined, now);
      completed += 1;
      unavailable += 1;
      continue;
    }
    let response: IntegrityProviderResponse;
    try {
      response = await (options.client ?? defaultClient)({
        provider: row.provider,
        endpoint: checkedEndpoint(endpointValue),
        token,
        bindingDigest: row.challenge_digest,
      });
    } catch {
      response = { status: 503, body: Buffer.alloc(0) };
    }
    const outcome = classifyIntegrityProviderResponse(row.provider, response, row.challenge_digest);
    await complete(pool, payloadStore, row, outcome.verdict, outcome.retainEvidence ? response.body : undefined, now);
    if (outcome.verdict === "unavailable") unavailable += 1;
    completed += 1;
  }
  return { completed, unavailable };
}
