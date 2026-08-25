import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyIntegrityProviderResponse,
  normalizeIntegrityResponse,
} from "./integrity-verifier.js";

const binding = "a".repeat(64);

describe("M6b platform integrity verifier", () => {
  it("F-A-14 verifies synthetic server responses against their request binding", () => {
    const play = Buffer.from(JSON.stringify({
      requestDetails: { requestHash: binding },
      appIntegrity: { appRecognitionVerdict: "PLAY_RECOGNIZED" },
      deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_DEVICE_INTEGRITY"] },
    }));
    assert.equal(normalizeIntegrityResponse("play_integrity", play, binding).verdict, "verified");
    assert.equal(normalizeIntegrityResponse("play_integrity", play, "b".repeat(64)).verdict, "failed");

    const appAttest = Buffer.from(JSON.stringify({
      binding_digest: binding,
      app_id_valid: true,
      signature_valid: true,
      counter_valid: true,
    }));
    assert.equal(normalizeIntegrityResponse("app_attest", appAttest, binding).verdict, "verified");
    assert.equal(normalizeIntegrityResponse("app_attest", Buffer.from(JSON.stringify({
      binding_digest: binding,
      app_id_valid: true,
      signature_valid: true,
      counter_valid: false,
    })), binding).verdict, "failed");
  });

  it("F-A-15 keeps timeout, 429, 5xx, and unsupported clients unavailable without evidence", () => {
    for (const status of [429, 500, 503]) {
      assert.deepEqual(classifyIntegrityProviderResponse(
        "play_integrity",
        { status, body: Buffer.from("provider unavailable") },
        binding,
      ), { verdict: "unavailable", retainEvidence: false });
    }
    assert.deepEqual(classifyIntegrityProviderResponse(
      "app_attest",
      { status: 400, body: Buffer.from('{"error":"invalid_assertion"}') },
      binding,
    ), { verdict: "failed", retainEvidence: true });
  });
});
