import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { expectedMaxTokenAll } from "../apps/api/src/max-receiver.js";
import { signSdkRequest } from "../apps/api/src/sdk-auth.js";

type InstallationCredential = {
  readonly installation_id: string;
  readonly installation_key_id: string;
  readonly installation_secret: string;
};

type Sample = { readonly status: number; readonly duration_ms: number };

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing M5 load variable ${name}`);
  return value;
};
const positiveInteger = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
};
const nonce = (value: string): string => createHash("sha256").update(value).digest("base64url").slice(0, 24);
const percentile = (samples: readonly number[], ratio: number): number => {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)].toFixed(3));
};
const summary = (samples: readonly Sample[], acceptedStatus: number, startedAt: number) => ({
  requests: samples.length,
  accepted: samples.filter((sample) => sample.status === acceptedStatus).length,
  errors: samples.filter((sample) => sample.status !== acceptedStatus).length,
  p50_ms: percentile(samples.map((sample) => sample.duration_ms), 0.5),
  p95_ms: percentile(samples.map((sample) => sample.duration_ms), 0.95),
  p99_ms: percentile(samples.map((sample) => sample.duration_ms), 0.99),
  throughput_rps: Number((samples.length / Math.max(0.001, (performance.now() - startedAt) / 1000)).toFixed(3)),
});

async function concurrentMap<T, R>(values: readonly T[], concurrency: number, task: (value: T, index: number) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      output[index] = await task(values[index], index);
    }
  }));
  return output;
}

const eventCount = positiveInteger("OPENMASU_M5_LOAD_EVENTS", 100_000);
const maxPostbackCount = positiveInteger("OPENMASU_M5_LOAD_MAX_POSTBACKS", 10_000);
const concurrency = positiveInteger("OPENMASU_M5_LOAD_CONCURRENCY", 40);
const batchSize = 100;
const batchCount = Math.ceil(eventCount / batchSize);
const baseUrl = process.env.OPENMASU_M5_LOAD_BASE_URL ?? "http://127.0.0.1:8080";
const sdkKeyId = required("OPENMASU_SDK_KEY_ID");
const sdkSecret = required("OPENMASU_SDK_KEY");
const maxPathSecret = required("OPENMASU_MAX_PATH_SECRET");
const maxEventKey = required("OPENMASU_MAX_EVENT_KEY");
const run = nonce(`${Date.now()}-${process.pid}`).slice(0, 12);

async function signedPost(
  path: string,
  value: unknown,
  sequence: string,
  installation?: InstallationCredential,
): Promise<Response> {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const timestampMs = Date.now();
  const requestNonce = nonce(`${run}:${sequence}:${timestampMs}`);
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openmasu-sdk-key-id": sdkKeyId,
      "x-openmasu-installation-key-id": installation?.installation_key_id ?? "-",
      "x-openmasu-timestamp-ms": String(timestampMs),
      "x-openmasu-nonce": requestNonce,
      "x-openmasu-signature": signSdkRequest(installation?.installation_secret ?? sdkSecret, {
        method: "POST",
        path,
        sdkKeyId,
        installationKeyId: installation?.installation_key_id,
        timestampMs,
        nonce: requestNonce,
        body,
      }),
    },
    body,
  });
}

const installationIndexes = Array.from({ length: batchCount }, (_, index) => index);
const enrollmentStartedAt = performance.now();
const credentials = await concurrentMap(installationIndexes, concurrency, async (index) => {
  const installationId = `installation:m5-load:${run}:${index}`;
  const startedAt = performance.now();
  const response = await signedPost("/v1/installations", { installation_id: installationId }, `enroll:${index}`);
  const duration_ms = performance.now() - startedAt;
  if (response.status !== 201) return { sample: { status: response.status, duration_ms } as Sample };
  const value = await response.json() as Omit<InstallationCredential, "installation_id">;
  return { sample: { status: response.status, duration_ms } as Sample, credential: { installation_id: installationId, ...value } };
});
const enrollmentSamples = credentials.map((value) => value.sample);
if (credentials.some((value) => !value.credential)) throw new Error("M5 enrollment load recorded a non-201 response");

const ingestionStartedAt = performance.now();
const ingestSamples = await concurrentMap(credentials, concurrency, async (value, batchIndex): Promise<Sample> => {
  const credential = value.credential!;
  const remaining = eventCount - batchIndex * batchSize;
  const records = Array.from({ length: Math.min(batchSize, remaining) }, (_, recordIndex) => {
    const sequence = batchIndex * batchSize + recordIndex;
    return {
      producer_version: "m5-load-synthetic-v1",
      event_id: `event:m5-load:${run}:${sequence}`,
      event_name: "session_start",
      occurred_at: new Date().toISOString(),
      occurred_at_source: "device",
      processing_purpose_id: "analytics",
      processing_sequence: sequence + 1,
      payload: {
        event_name: "session_start",
        installation_id: credential.installation_id,
        session_id: `session:m5-load:${run}:${sequence}`,
      },
    };
  });
  const startedAt = performance.now();
  const response = await signedPost("/v1/events/batch", { records }, `batch:${batchIndex}`, credential);
  return { status: response.status, duration_ms: performance.now() - startedAt };
});

const maxStartedAt = performance.now();
const maxSamples = await concurrentMap(
  Array.from({ length: maxPostbackCount }, (_, index) => index),
  concurrency,
  async (index): Promise<Sample> => {
    const parameters = new URLSearchParams({
      event_id: `event:m5-max:${run}:${index}`,
      revenue: "0.000001",
      ts: String(1_787_097_600 + index),
      ad_unit_id: "synthetic-load-unit",
      network: "synthetic-load-network",
      cc: "US",
    });
    parameters.set("event_token_all", expectedMaxTokenAll(parameters, maxEventKey));
    const startedAt = performance.now();
    const response = await fetch(`${baseUrl}/v1/ingest/max/${maxPathSecret}?${parameters}`);
    return { status: response.status, duration_ms: performance.now() - startedAt };
  },
);

const report = {
  benchmark: "openmasu_m5_synthetic_http_load_v1",
  environment: {
    runtime: "GitHub hosted ubuntu-24.04 compatible Compose",
    node: process.version,
    postgres: "17",
    concurrency,
  },
  sdk_enrollment: summary(enrollmentSamples, 201, enrollmentStartedAt),
  sdk_ingestion: {
    events: eventCount,
    batches: batchCount,
    ...summary(ingestSamples, 202, ingestionStartedAt),
  },
  max_postback: summary(maxSamples, 204, maxStartedAt),
  budgets_are_informational: true,
};
if (report.sdk_ingestion.errors > 0 || report.max_postback.errors > 0) {
  throw new Error("M5 synthetic load recorded HTTP errors");
}
const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (process.env.OPENMASU_M5_LOAD_OUTPUT) writeFileSync(process.env.OPENMASU_M5_LOAD_OUTPUT, rendered, "utf8");
process.stdout.write(rendered);
