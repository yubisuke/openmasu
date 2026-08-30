import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privacyResponseStatus } from "./privacy.js";

describe("privacy request HTTP status", () => {
  it("accepts durable processing work and creates synchronously completed work", () => {
    assert.equal(privacyResponseStatus({ status: "processing" }), 202);
    assert.equal(privacyResponseStatus({ status: "completed" }), 201);
  });
});
