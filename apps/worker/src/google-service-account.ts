import { createSign } from "node:crypto";

type JsonObject = Record<string, unknown>;

function object(body: Buffer, label: string): JsonObject {
  if (body.length > 64 * 1024) throw new Error(`${label}_too_large`);
  const value: unknown = JSON.parse(body.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_invalid`);
  return value as JsonObject;
}

export async function googleServiceAccountAccessToken(options: {
  credentialsJson: string;
  scope: "https://www.googleapis.com/auth/androidpublisher" | "https://www.googleapis.com/auth/datamanager";
  tokenUrl?: string;
  fetch?: typeof fetch;
  now?: Date;
  signal?: AbortSignal;
}): Promise<string> {
  const credentials = object(Buffer.from(options.credentialsJson, "utf8"), "google_credentials");
  if (typeof credentials.client_email !== "string" || typeof credentials.private_key !== "string") {
    throw new Error("google_credentials_invalid");
  }
  const tokenUrl = new URL(options.tokenUrl ?? String(credentials.token_uri ?? "https://oauth2.googleapis.com/token"));
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(tokenUrl.hostname);
  if (tokenUrl.username || tokenUrl.password || tokenUrl.search || tokenUrl.hash
    || (tokenUrl.protocol !== "https:" && !(tokenUrl.protocol === "http:" && loopback))
    || (!loopback && tokenUrl.hostname !== "oauth2.googleapis.com")) throw new Error("google_oauth_endpoint_invalid");
  const issuedAt = Math.floor((options.now ?? new Date()).valueOf() / 1000);
  const encode = (value: string): string => Buffer.from(value).toString("base64url");
  const header = encode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = encode(JSON.stringify({ iss: credentials.client_email, scope: options.scope,
    aud: tokenUrl.toString(), iat: issuedAt, exp: issuedAt + 3_600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  const assertion = `${header}.${claims}.${signer.sign(credentials.private_key).toString("base64url")}`;
  const response = await (options.fetch ?? fetch)(tokenUrl, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    redirect: "error", signal: options.signal ?? AbortSignal.timeout(10_000),
  });
  if (response.status !== 200) throw new Error("google_oauth_unavailable");
  const body = object(Buffer.from(await response.arrayBuffer()), "google_oauth_response");
  if (typeof body.access_token !== "string" || body.access_token.length < 1 || body.access_token.length > 64 * 1024) {
    throw new Error("google_access_token_missing");
  }
  return body.access_token;
}
