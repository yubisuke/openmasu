import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { googleServiceAccountAccessToken } from "./google-service-account.js";

describe("Google service-account credential boundary", () => {
  it("requests the explicit Data Manager scope without exposing credential fields", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let claims: Record<string, unknown> = {};
    const token = await googleServiceAccountAccessToken({
      credentialsJson: JSON.stringify({
        client_email: "synthetic@example.invalid",
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        token_uri: "https://oauth2.googleapis.com/token",
      }),
      scope: "https://www.googleapis.com/auth/datamanager",
      now: new Date("2026-08-24T00:00:00.000Z"),
      fetch: async (_input, init) => {
        assert.equal(init?.redirect, "error");
        const assertion = new URLSearchParams(String(init?.body)).get("assertion")!;
        claims = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString("utf8"));
        return new Response(JSON.stringify({ access_token: "synthetic-access-token" }), { status: 200 });
      },
    });
    assert.equal(token, "synthetic-access-token");
    assert.equal(claims.scope, "https://www.googleapis.com/auth/datamanager");
    assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
    assert.equal(JSON.stringify(claims).includes("private_key"), false);
  });

  it("rejects non-Google token endpoints before transport", async () => {
    await assert.rejects(googleServiceAccountAccessToken({
      credentialsJson: JSON.stringify({ client_email: "synthetic@example.invalid", private_key: "not-used" }),
      scope: "https://www.googleapis.com/auth/datamanager",
      tokenUrl: "https://example.invalid/token",
    }), /endpoint_invalid/);
  });
});
