import { createHash, createHmac } from "node:crypto";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { resolveWebhookEndpoint, type WebhookLookup } from "./webhook-security.js";

export type S3Credentials = Readonly<{
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}>;

export type AwsV4SignedRequest = Readonly<{
  authorization: string;
  canonicalRequest: string;
  headers: Readonly<Record<string, string>>;
  signature: string;
  signedHeaders: string;
  stringToSign: string;
}>;

export type S3PutResult =
  | Readonly<{ outcome: "stored" | "already_present"; httpStatus: number; digest: string }>
  | Readonly<{ outcome: "retry"; reason: string; httpStatus?: number }>
  | Readonly<{ outcome: "terminal"; reason: string; httpStatus?: number }>;

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string): Buffer => createHmac("sha256", key).update(value).digest();

function isoBasic(now: Date): string {
  if (!Number.isFinite(now.valueOf())) throw new Error("s3_signing_time_invalid");
  return now.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalUri(url: URL): string {
  return url.pathname.split("/").map((segment) => {
    try { return encodeRfc3986(decodeURIComponent(segment)); } catch { throw new Error("s3_object_path_invalid"); }
  }).join("/") || "/";
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams.entries()]
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey, "en") || leftValue.localeCompare(rightValue, "en"))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function normalizedHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function hostHeader(url: URL): string {
  const defaultPort = (url.protocol === "https:" && (url.port === "" || url.port === "443"))
    || (url.protocol === "http:" && (url.port === "" || url.port === "80"));
  return defaultPort ? url.hostname : url.host;
}

export function signAwsV4Request(input: Readonly<{
  method: string;
  url: URL;
  region: string;
  service?: string;
  credentials: S3Credentials;
  payloadHash: string;
  now: Date;
  headers?: Readonly<Record<string, string>>;
}>): AwsV4SignedRequest {
  if (!/^[A-Z]+$/.test(input.method) || !/^[a-z0-9-]{1,63}$/.test(input.region)
    || !/^[A-Za-z0-9/+=]{16,256}$/.test(input.credentials.secretAccessKey)
    || !/^[A-Za-z0-9]{8,128}$/.test(input.credentials.accessKeyId)
    || !/^[a-f0-9]{64}$/.test(input.payloadHash)) {
    throw new Error("s3_signing_input_invalid");
  }
  const service = input.service ?? "s3";
  const amzDate = isoBasic(input.now);
  const dateStamp = amzDate.slice(0, 8);
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const normalizedName = name.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(normalizedName) || normalizedName === "authorization") {
      throw new Error("s3_signing_header_invalid");
    }
    headers.set(normalizedName, normalizedHeaderValue(value));
  }
  headers.set("host", hostHeader(input.url));
  headers.set("x-amz-content-sha256", input.payloadHash);
  headers.set("x-amz-date", amzDate);
  if (input.credentials.sessionToken) headers.set("x-amz-security-token", input.credentials.sessionToken);
  const ordered = [...headers.entries()].sort(([left], [right]) => left.localeCompare(right, "en"));
  const canonicalHeaders = ordered.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaders = ordered.map(([name]) => name).join(";");
  const canonicalRequest = [
    input.method,
    canonicalUri(input.url),
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const dateKey = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, input.region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return {
    authorization,
    canonicalRequest,
    headers: Object.fromEntries([...ordered, ["authorization", authorization]]),
    signature,
    signedHeaders,
    stringToSign,
  };
}

export function s3ObjectUrl(endpoint: URL, bucket: string, key: string): URL {
  if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash || endpoint.username || endpoint.password
    || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    || key.length < 1 || Buffer.byteLength(key, "utf8") > 1024 || key.startsWith("/") || key.includes("\0")) {
    throw new Error("s3_object_location_invalid");
  }
  const url = new URL(endpoint.href);
  url.pathname = `/${encodeRfc3986(bucket)}/${key.split("/").map(encodeRfc3986).join("/")}`;
  return url;
}

type Response = Readonly<{ status: number; headers: Readonly<Record<string, string | string[] | undefined>> }>;

async function signedRequest(input: Readonly<{
  method: "PUT" | "HEAD";
  url: URL;
  resolvedAddress: string;
  resolvedFamily: 4 | 6;
  credentials: S3Credentials;
  region: string;
  now: Date;
  timeoutMilliseconds: number;
  body?: Buffer;
  digest: string;
}>): Promise<Response | { error: "timeout" | "transport_error" }> {
  const body = input.body ?? Buffer.alloc(0);
  const extraHeaders: Record<string, string> = input.method === "PUT" ? {
    "content-encoding": "gzip",
    "content-length": String(body.length),
    "content-type": "application/x-ndjson",
    "if-none-match": "*",
    "x-amz-meta-openmasu-sha256": input.digest,
  } : {};
  const signed = signAwsV4Request({
    method: input.method,
    url: input.url,
    region: input.region,
    credentials: input.credentials,
    payloadHash: input.method === "PUT" ? sha256(body) : EMPTY_SHA256,
    now: input.now,
    headers: extraHeaders,
  });
  const requestFactory = input.url.protocol === "https:" ? httpsRequest : httpRequest;
  const lookup: LookupFunction = (_hostname, _options, callback) =>
    callback(null, input.resolvedAddress, input.resolvedFamily);
  const options: RequestOptions = {
    protocol: input.url.protocol,
    hostname: input.url.hostname,
    port: input.url.port || undefined,
    path: `${input.url.pathname}${input.url.search}`,
    method: input.method,
    agent: false,
    lookup,
    headers: { ...signed.headers, "user-agent": "OpenMasu-Bulk-Export/1" },
  };
  return new Promise((resolve) => {
    const request = requestFactory(options, (response) => {
      const responseHeaders = response.headers;
      const status = response.statusCode ?? 0;
      response.destroy();
      resolve({ status, headers: responseHeaders });
    });
    request.setTimeout(input.timeoutMilliseconds, () => request.destroy(new Error("s3_timeout")));
    request.once("error", (error) => resolve({
      error: error instanceof Error && error.message === "s3_timeout" ? "timeout" : "transport_error",
    }));
    request.end(body);
  });
}

function headerValue(headers: Readonly<Record<string, string | string[] | undefined>>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function putS3Object(input: Readonly<{
  endpointUrl: string;
  bucket: string;
  key: string;
  region: string;
  credentials: S3Credentials;
  body: Buffer;
  expectedDigest: string;
  destinationAllowlist: readonly string[];
  allowSyntheticLoopback?: boolean;
  timeoutMilliseconds?: number;
  maximumObjectBytes?: number;
  lookup?: WebhookLookup;
  now?: Date;
}>): Promise<S3PutResult> {
  const timeoutMilliseconds = input.timeoutMilliseconds ?? 5_000;
  const maximumObjectBytes = input.maximumObjectBytes ?? 10 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 100 || timeoutMilliseconds > 30_000
    || !Number.isSafeInteger(maximumObjectBytes) || maximumObjectBytes < 1 || maximumObjectBytes > 64 * 1024 * 1024
    || input.body.length > maximumObjectBytes || sha256(input.body) !== input.expectedDigest) {
    return { outcome: "terminal", reason: "object_invalid" };
  }
  let resolved;
  try {
    resolved = await resolveWebhookEndpoint(input.endpointUrl, input.destinationAllowlist, {
      allowSyntheticLoopback: input.allowSyntheticLoopback,
      lookup: input.lookup,
      resolutionTimeoutMilliseconds: timeoutMilliseconds,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "s3_endpoint_rejected";
    if (reason.endsWith("dns_empty") || reason.endsWith("dns_timeout")) {
      return { outcome: "retry", reason: "dns_unavailable" };
    }
    return { outcome: "terminal", reason: "endpoint_rejected" };
  }
  let objectUrl: URL;
  try { objectUrl = s3ObjectUrl(new URL(resolved.url.origin), input.bucket, input.key); }
  catch { return { outcome: "terminal", reason: "object_location_invalid" }; }
  const common = {
    url: objectUrl,
    resolvedAddress: resolved.address,
    resolvedFamily: resolved.family,
    credentials: input.credentials,
    region: input.region,
    now: input.now ?? new Date(),
    timeoutMilliseconds,
    digest: input.expectedDigest,
  } as const;
  const response = await signedRequest({ ...common, method: "PUT", body: input.body });
  if ("error" in response) return { outcome: "retry", reason: response.error };
  if (response.status >= 200 && response.status < 300) {
    return { outcome: "stored", httpStatus: response.status, digest: input.expectedDigest };
  }
  if (response.status === 412) {
    const head = await signedRequest({ ...common, method: "HEAD" });
    if ("error" in head) return { outcome: "retry", reason: head.error };
    if (head.status >= 200 && head.status < 300
      && headerValue(head.headers, "x-amz-meta-openmasu-sha256") === input.expectedDigest) {
      return { outcome: "already_present", httpStatus: head.status, digest: input.expectedDigest };
    }
    return { outcome: "terminal", reason: "object_conflict", httpStatus: head.status || response.status };
  }
  if ([408, 409, 425, 429].includes(response.status) || response.status >= 500) {
    return { outcome: "retry", reason: response.status === 429 ? "rate_limited" : "storage_unavailable", httpStatus: response.status };
  }
  if (response.status >= 300 && response.status < 400) {
    return { outcome: "terminal", reason: "redirect_rejected", httpStatus: response.status };
  }
  return { outcome: "terminal", reason: "storage_rejected", httpStatus: response.status || undefined };
}
