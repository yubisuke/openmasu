import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sdkCanonicalString, signSdkRequest } from "./sdk-auth.js";

describe("SDK request signing", () => {
  it("M4-A20 matches the shared Android, Swift, and TypeScript vectors", () => {
    const fixture = JSON.parse(readFileSync(join(process.cwd(), "sdk", "signing-vectors.json"), "utf8")) as {
      vectors: Array<{
        body: string; canonical: string; installation_key_id: string; method: string; nonce: string;
        path: string; sdk_key_id: string; secret: string; signature: string; timestamp_ms: number;
      }>;
    };
    for (const vector of fixture.vectors) {
      const input = {
        method: vector.method,
        path: vector.path,
        sdkKeyId: vector.sdk_key_id,
        installationKeyId: vector.installation_key_id === "-" ? undefined : vector.installation_key_id,
        timestampMs: vector.timestamp_ms,
        nonce: vector.nonce,
        body: Buffer.from(vector.body, "utf8"),
      };
      assert.equal(sdkCanonicalString(input), vector.canonical);
      assert.equal(signSdkRequest(vector.secret, input), vector.signature);
    }
  });

  it("binds method, path, both key identifiers, timestamp, nonce, and raw body digest", () => {
    const input = {
      method: "POST", path: "/v1/events/batch", sdkKeyId: "sdk-key-synthetic",
      installationKeyId: "installation-key-synthetic", timestampMs: 1_787_097_600_000,
      nonce: "Nonce_abcdefghijklmnopqrstu", body: Buffer.from('{"synthetic":true}', "utf8"),
    };
    const canonical = sdkCanonicalString(input);
    assert.equal(canonical.split("\n").length, 8);
    const signature = signSdkRequest("synthetic-secret-that-is-at-least-32-bytes", input);
    for (const changed of [
      { ...input, method: "PUT" }, { ...input, path: "/v1/installations" },
      { ...input, sdkKeyId: "sdk-key-other" }, { ...input, installationKeyId: "installation-key-other" },
      { ...input, timestampMs: input.timestampMs + 1 }, { ...input, nonce: `${input.nonce}x` },
      { ...input, body: Buffer.from('{"synthetic":false}', "utf8") },
    ]) assert.notEqual(signSdkRequest("synthetic-secret-that-is-at-least-32-bytes", changed), signature);
  });
});
