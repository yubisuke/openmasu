import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { privacyResponseStatus, privacySubjectDigest } from "./privacy.js";

describe("privacy request HTTP status", () => {
  it("accepts durable processing work and creates synchronously completed work", () => {
    assert.equal(privacyResponseStatus({ status: "processing" }), 202);
    assert.equal(privacyResponseStatus({ status: "completed" }), 201);
  });
});

describe("privacy subject digest", () => {
  const key = "synthetic-private-digest-key";
  const common = {
    tenant_id: "tenant-synthetic",
    app_id: "app-synthetic",
    deletion_subject_ref: "app-synthetic",
  } as const;

  it("preserves the installation digest namespace", () => {
    const body = { ...common, deletion_scope: "installation" as const };
    const expected = createHmac("sha256", key)
      .update(`${body.tenant_id}\u0000${body.app_id}\u0000${body.deletion_subject_ref}`, "utf8")
      .digest("hex");
    assert.equal(privacySubjectDigest(key, body), expected);
  });

  it("uses private, scope-separated HMACs for app and tenant deletion", () => {
    const appDigest = privacySubjectDigest(key, { ...common, deletion_scope: "app" });
    const tenantDigest = privacySubjectDigest(key, { ...common, deletion_scope: "tenant" });
    const formerPlainDigest = createHash("sha256")
      .update(JSON.stringify([common.tenant_id, common.app_id, "app", common.deletion_subject_ref]))
      .digest("hex");
    assert.match(appDigest, /^[a-f0-9]{64}$/);
    assert.notEqual(appDigest, tenantDigest);
    assert.notEqual(appDigest, formerPlainDigest);
    assert.throws(
      () => privacySubjectDigest("", { ...common, deletion_scope: "app" }),
      /privacy_subject_digest_key_required/,
    );
  });
});
