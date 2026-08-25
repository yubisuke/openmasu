import { createSign } from "node:crypto";

export type AppleStoreApiOperation = "transaction_history" | "refund_history";

export type AppleStoreApiCredentials = {
  readonly issuerId: string;
  readonly keyId: string;
  readonly privateKey: string;
  readonly bundleId: string;
  readonly environment: "Sandbox" | "Production";
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function createAppleStoreApiToken(credentials: AppleStoreApiCredentials, now = new Date()): string {
  if (!/^[0-9a-f-]{36}$/i.test(credentials.issuerId) || !/^[A-Z0-9]{10}$/.test(credentials.keyId)
    || !/^[A-Za-z0-9.-]{3,255}$/.test(credentials.bundleId)) throw new Error("apple_store_api_credentials_invalid");
  const issuedAt = Math.floor(now.getTime() / 1000);
  const header = encode({ alg: "ES256", kid: credentials.keyId, typ: "JWT" });
  const claims = encode({
    iss: credentials.issuerId,
    iat: issuedAt,
    exp: issuedAt + 300,
    aud: "appstoreconnect-v1",
    bid: credentials.bundleId,
  });
  const signer = createSign("sha256");
  signer.update(`${header}.${claims}`);
  signer.end();
  const signature = signer.sign({ key: credentials.privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

export async function callAppleStoreApi(input: {
  readonly operation: AppleStoreApiOperation;
  readonly transactionId: string;
  readonly revision?: string;
  readonly credentials: AppleStoreApiCredentials;
  readonly fetch?: typeof fetch;
  readonly now?: Date;
  readonly baseUrl?: string;
}): Promise<{ readonly status: number; readonly body: Buffer }> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.transactionId)) throw new Error("apple_store_transaction_id_invalid");
  if (input.revision !== undefined && !/^[A-Za-z0-9._~-]{1,4096}$/.test(input.revision)) throw new Error("apple_store_revision_invalid");
  const defaultHost = input.credentials.environment === "Sandbox"
    ? "api.storekit-sandbox.itunes.apple.com"
    : "api.storekit.itunes.apple.com";
  const base = new URL(input.baseUrl ?? `https://${defaultHost}`);
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash
    || (base.protocol !== "https:" && !(base.protocol === "http:" && loopback))
    || (!loopback && base.hostname !== defaultHost)) throw new Error("apple_store_api_endpoint_invalid");
  const path = input.operation === "transaction_history" ? "inApps/v2/history" : "inApps/v2/refund/lookup";
  const url = new URL(`${path}/${encodeURIComponent(input.transactionId)}`, `${base.toString().replace(/\/$/, "")}/`);
  if (input.revision) url.searchParams.set("revision", input.revision);
  if (input.operation === "transaction_history") url.searchParams.set("sort", "ASCENDING");
  const response = await (input.fetch ?? fetch)(url, {
    headers: { authorization: `Bearer ${createAppleStoreApiToken(input.credentials, input.now)}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > 1024 * 1024) throw new Error("apple_store_api_response_too_large");
  return { status: response.status, body };
}
