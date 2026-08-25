import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { verifyGooglePushToken } from "./google-play-rtdn-receiver.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const key = { ...publicKey.export({ format: "jwk" }), kid: "synthetic-key", alg: "RS256", use: "sig" };
const now = new Date("2026-08-24T08:00:00.000Z");

function token(overrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "synthetic-key" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: "https://accounts.google.com",
    aud: "https://synthetic.invalid/v1/google-play/rtdn",
    email: "synthetic-rtdn@synthetic-project.iam.gserviceaccount.com",
    email_verified: true,
    iat: Math.floor(now.getTime() / 1_000) - 60,
    exp: Math.floor(now.getTime() / 1_000) + 3_000,
    ...overrides,
  })).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${signer.sign(privateKey).toString("base64url")}`;
}

const fetchJwks = async () => new Response(JSON.stringify({ keys: [key] }), {
  status: 200, headers: { "content-type": "application/json" },
});

describe("Google Play RTDN push authentication", () => {
  it("accepts a signed token only for the configured audience and verified service account", async () => {
    await verifyGooglePushToken(`Bearer ${token()}`, {
      audience: "https://synthetic.invalid/v1/google-play/rtdn",
      serviceAccountEmail: "synthetic-rtdn@synthetic-project.iam.gserviceaccount.com",
      now,
      fetch: fetchJwks,
      jwksUrl: "http://127.0.0.1/synthetic-jwks",
    });
  });

  it("rejects wrong audience, unverified email, expiry, and altered signatures", async () => {
    const base = {
      audience: "https://synthetic.invalid/v1/google-play/rtdn",
      serviceAccountEmail: "synthetic-rtdn@synthetic-project.iam.gserviceaccount.com",
      now,
      fetch: fetchJwks,
      jwksUrl: "http://127.0.0.1/synthetic-jwks",
    };
    await assert.rejects(verifyGooglePushToken(`Bearer ${token({ aud: "https://other.invalid" })}`, base), /rtdn_jwt_claims_invalid/);
    await assert.rejects(verifyGooglePushToken(`Bearer ${token({ email_verified: false })}`, base), /rtdn_jwt_claims_invalid/);
    await assert.rejects(verifyGooglePushToken(`Bearer ${token({ exp: Math.floor(now.getTime() / 1_000) - 400 })}`, base), /rtdn_jwt_claims_invalid/);
    const parts = token().split(".");
    parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    const altered = parts.join(".");
    await assert.rejects(verifyGooglePushToken(`Bearer ${altered}`, base), /rtdn_jwt_signature_invalid/);
  });
});
