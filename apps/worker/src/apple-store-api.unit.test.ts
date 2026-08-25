import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { callAppleStoreApi, createAppleStoreApiToken } from "./apple-store-api.js";

function credentials() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    issuerId: "00000000-0000-4000-8000-000000000019",
    keyId: "SYNTHETIC1",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    bundleId: "com.example.synthetic",
    environment: "Sandbox" as const,
  };
}

describe("App Store Server API client", () => {
  it("creates a bounded ES256 provider token without exposing the private key", () => {
    const config = credentials();
    const token = createAppleStoreApiToken(config, new Date("2026-08-25T00:00:00.000Z"));
    const [header, claims] = token.split(".").slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
    assert.deepEqual(header, { alg: "ES256", kid: "SYNTHETIC1", typ: "JWT" });
    assert.equal(claims.exp - claims.iat, 300);
    assert.equal(token.includes(config.privateKey), false);
  });

  it("uses ascending revision pagination and rejects credential-bearing or foreign endpoints", async () => {
    let requested = "";
    const result = await callAppleStoreApi({
      operation: "transaction_history",
      transactionId: "transaction.synthetic.19",
      revision: "revision-synthetic-2",
      credentials: credentials(),
      baseUrl: "http://127.0.0.1:8999",
      fetch: async (request, init) => {
        requested = String(request);
        assert.match(String(new Headers(init?.headers).get("authorization")), /^Bearer [^.]+\.[^.]+\.[^.]+$/);
        return new Response('{"hasMore":false,"revision":"revision-synthetic-3","signedTransactions":[]}', { status: 200 });
      },
    });
    assert.equal(result.status, 200);
    assert.match(requested, /revision=revision-synthetic-2/);
    assert.match(requested, /sort=ASCENDING/);
    await assert.rejects(callAppleStoreApi({
      operation: "refund_history", transactionId: "transaction.synthetic.19", credentials: credentials(),
      baseUrl: "https://credential@example.invalid", fetch: async () => new Response(),
    }), /endpoint/);
  });
});
