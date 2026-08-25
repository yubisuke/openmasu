import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPLE_SKAN_PUBLIC_KEY_BASE64,
  skanSignedMessage,
  unsignedApplePostbackEvidenceNotice,
  verifyAdAttributionKitPostback,
  verifySkAdNetworkPostback,
} from "./index.js";

function keyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyBase64 = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { ...pair, publicKeyBase64 };
}

function signSkan(body: Record<string, unknown>, privateKey: ReturnType<typeof keyPair>["privateKey"], message = skanSignedMessage(body)): string {
  return sign("sha256", Buffer.from(message, "utf8"), privateKey).toString("base64");
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signJws(
  kid: string,
  claims: Record<string, unknown>,
  privateKey: ReturnType<typeof keyPair>["privateKey"],
  alg = "ES256",
): string {
  const head = encodeJson({ alg, kid });
  const payload = encodeJson(claims);
  const signature = sign("sha256", Buffer.from(`${head}.${payload}`, "ascii"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${head}.${payload}.${signature.toString("base64url")}`;
}

function skanV4(): Record<string, unknown> {
  return {
    version: "4.0",
    "ad-network-id": "synthetic.skadnetwork",
    "source-identifier": "1234",
    "app-id": 123456789,
    "transaction-id": "00000000-0000-4000-8000-000000000401",
    redownload: false,
    "source-app-id": 987654321,
    "fidelity-type": 1,
    "did-win": true,
    "postback-sequence-index": 0,
    "conversion-value": 12,
  };
}

function skanV3(): Record<string, unknown> {
  return {
    version: "3.0",
    "ad-network-id": "synthetic.skadnetwork",
    "campaign-id": 42,
    "app-id": 123456789,
    "transaction-id": "00000000-0000-4000-8000-000000000301",
    redownload: false,
    "fidelity-type": 1,
    "did-win": true,
  };
}

describe("SKAdNetwork postback verification", () => {
  it("verifies generated v3 and v4 vectors with the documented field order", () => {
    const pair = keyPair();
    for (const source of [skanV3(), skanV4()]) {
      const body = { ...source, "attribution-signature": signSkan(source, pair.privateKey) };
      assert.equal(verifySkAdNetworkPostback(body, pair).verified, true);
    }
    assert.equal(skanSignedMessage(skanV3()).split("\u2063").length, 8, "v3 omits absent source-app-id");
  });

  it("rejects changed fields, order, Boolean spelling, separators, and the wrong key", () => {
    const pair = keyPair();
    const original = skanV4();
    const signature = signSkan(original, pair.privateKey);
    const changed = { ...original, "source-identifier": "1235", "attribution-signature": signature };
    assert.deepEqual(verifySkAdNetworkPostback(changed, pair), {
      verified: false,
      reason: "signature_invalid",
      unsigned: { "conversion-value": 12 },
      signingKeyEnvironment: "production",
    });
    const wrongOrder = skanSignedMessage(original).split("\u2063").reverse().join("\u2063");
    const wrongOrderBody = { ...original, "attribution-signature": signSkan(original, pair.privateKey, wrongOrder) };
    assert.equal(verifySkAdNetworkPostback(wrongOrderBody, pair).verified, false);
    const wrongBoolean = skanSignedMessage(original).replace("true", "True");
    assert.equal(verifySkAdNetworkPostback({ ...original, "attribution-signature": signSkan(original, pair.privateKey, wrongBoolean) }, pair).verified, false);
    const wrongSeparator = skanSignedMessage(original).replaceAll("\u2063", " ");
    assert.equal(verifySkAdNetworkPostback({ ...original, "attribution-signature": signSkan(original, pair.privateKey, wrongSeparator) }, pair).verified, false);
    assert.equal(verifySkAdNetworkPostback({ ...original, "attribution-signature": signature }, { publicKeyBase64: APPLE_SKAN_PUBLIC_KEY_BASE64 }).verified, false);
  });

  it("retains conversion values as unsigned observations", () => {
    const pair = keyPair();
    const original = skanV4();
    const body = { ...original, "attribution-signature": signSkan(original, pair.privateKey) };
    const changed = { ...body, "conversion-value": 63, "country-code": "JP" };
    const result = verifySkAdNetworkPostback(changed, pair);
    assert.equal(result.verified, true);
    assert.deepEqual(result.unsigned, { "conversion-value": 63, "country-code": "JP" });
    assert.equal("country-code" in result.authenticated, false);
    assert.match(unsignedApplePostbackEvidenceNotice, /unsigned observations/);
  });
});

describe("AdAttributionKit postback verification", () => {
  it("verifies production and gated development key identifiers", () => {
    const pair = keyPair();
    const claims = { "postback-identifier": "00000000-0000-4000-8000-000000000501", "advertised-item-identifier": 123456789 };
    const keySet = {
      "apple-cas-identifier/0": pair.publicKeyBase64,
      "apple-development-identifier/0": pair.publicKeyBase64,
      "apple-development-identifier/1": pair.publicKeyBase64,
    };
    for (const kid of Object.keys(keySet)) {
      const body = { "jws-string": signJws(kid, claims, pair.privateKey) };
      const accepted = verifyAdAttributionKitPostback(body, { acceptDevelopmentPostbacks: true, keySet });
      assert.equal(accepted.verified, true);
      assert.equal(accepted.signingKeyEnvironment, kid.startsWith("apple-development") ? "development" : "production");
    }
    const development = { "jws-string": signJws("apple-development-identifier/0", claims, pair.privateKey) };
    assert.deepEqual(verifyAdAttributionKitPostback(development, { keySet }), {
      verified: false,
      reason: "development_postback_rejected",
      unsigned: {},
      signingKeyEnvironment: "development",
      unverifiedClaims: claims,
    });
  });

  it("rejects malformed, unknown, none, and HMAC JWS values", () => {
    const pair = keyPair();
    const claims = { "postback-identifier": "00000000-0000-4000-8000-000000000502" };
    assert.equal(verifyAdAttributionKitPostback({ "jws-string": "one.two" }).verified, false);
    assert.equal(verifyAdAttributionKitPostback({ "jws-string": signJws("synthetic/0", claims, pair.privateKey) }).verified, false);
    assert.equal(verifyAdAttributionKitPostback({ "jws-string": signJws("apple-cas-identifier/0", claims, pair.privateKey, "none") }).verified, false);
    const header = encodeJson({ alg: "HS256", kid: "apple-cas-identifier/0" });
    const payload = encodeJson(claims);
    const mac = createHmac("sha256", pair.publicKeyBase64).update(`${header}.${payload}`).digest("base64url");
    assert.equal(verifyAdAttributionKitPostback({ "jws-string": `${header}.${payload}.${mac}` }).verified, false);
  });

  it("retains modified outer fields as unsigned observations", () => {
    const pair = keyPair();
    const claims = { "postback-identifier": "00000000-0000-4000-8000-000000000503" };
    const body = {
      "jws-string": signJws("apple-cas-identifier/0", claims, pair.privateKey),
      "conversion-value": 7,
      "country-code": "US",
    };
    const result = verifyAdAttributionKitPostback(
      { ...body, "conversion-value": 42, "country-code": "JP" },
      { keySet: { "apple-cas-identifier/0": pair.publicKeyBase64 } },
    );
    assert.equal(result.verified, true);
    assert.deepEqual(result.unsigned, { "conversion-value": 42, "country-code": "JP" });
  });

  it("exposes decoded claims only as explicitly unverified evidence after signature failure", () => {
    const pair = keyPair();
    const claims = {
      "postback-identifier": "00000000-0000-4000-8000-000000000504",
      "advertised-item-identifier": 123456789,
    };
    const result = verifyAdAttributionKitPostback({
      "jws-string": signJws("apple-cas-identifier/0", claims, pair.privateKey),
    });
    assert.equal(result.verified, false);
    if (result.verified) assert.fail("expected signature failure");
    assert.equal(result.reason, "signature_invalid");
    assert.deepEqual(result.unverifiedClaims, claims);
    assert.equal(verifyAdAttributionKitPostback({ "jws-string": "one.two" }).verified, false);
  });
});
