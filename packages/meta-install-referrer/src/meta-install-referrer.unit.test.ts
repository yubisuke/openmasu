import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { decryptMetaInstallReferrer } from "./index.js";

function vector(key: Buffer, value: unknown): { data_hex: string; nonce_hex: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.alloc(0));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { data_hex: ciphertext.toString("hex"), nonce_hex: nonce.toString("hex") };
}

describe("Meta Install Referrer decryption", () => {
  it("decrypts every typed field with a synthetic current key", () => {
    const key = randomBytes(32);
    const context = {
      campaign_group_id: "cg-synthetic", campaign_id: "campaign-synthetic",
      adgroup_id: "adgroup-synthetic", ad_id: "ad-synthetic", account_id: "account-synthetic",
      ad_objective_name: "APP_INSTALLS", is_instagram: false,
      publisher_platform: "facebook", platform_position: "feed",
      is_ct: 1, actual_timestamp: 1_787_097_600,
    };
    assert.deepEqual(decryptMetaInstallReferrer(vector(key, context), [{ key_id: "current", key_hex: key.toString("hex") }]), {
      status: "decrypted", key_id: "current",
      context: Object.fromEntries(Object.entries(context).filter(([name]) => name !== "is_ct" && name !== "actual_timestamp")),
      is_ct: 1,
      actual_timestamp: 1_787_097_600,
    });
  });

  it("tries the previous synthetic key after the current key fails", () => {
    const current = randomBytes(32);
    const previous = randomBytes(32);
    const result = decryptMetaInstallReferrer(vector(previous, { campaign_id: "campaign-previous" }), [
      { key_id: "current", key_hex: current.toString("hex") },
      { key_id: "previous", key_hex: previous.toString("hex") },
    ]);
    assert.equal(result.status, "decrypted");
    if (result.status === "decrypted") assert.equal(result.key_id, "previous");
  });

  it("fails closed for wrong keys, tampering, truncation, empty input, and pseudo-JSON", () => {
    const key = randomBytes(32);
    const encrypted = vector(key, { campaign_id: "campaign-synthetic" });
    assert.equal(decryptMetaInstallReferrer(encrypted, [{ key_id: "wrong", key_hex: randomBytes(32).toString("hex") }]).status, "auth_failed");
    const flipped = Buffer.from(encrypted.data_hex, "hex");
    flipped[0] ^= 1;
    assert.equal(decryptMetaInstallReferrer({ ...encrypted, data_hex: flipped.toString("hex") }, [{ key_id: "current", key_hex: key.toString("hex") }]).status, "auth_failed");
    assert.equal(decryptMetaInstallReferrer({ data_hex: encrypted.data_hex.slice(0, 20), nonce_hex: encrypted.nonce_hex }, [{ key_id: "current", key_hex: key.toString("hex") }]).status, "malformed");
    assert.equal(decryptMetaInstallReferrer(undefined, []).status, "absent");
    assert.equal(decryptMetaInstallReferrer(vector(key, "campaign_id=synthetic"), [{ key_id: "current", key_hex: key.toString("hex") }]).status, "malformed");
  });
});
