import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalConversionSchema } from "./apple-admin.js";

describe("Apple conversion schema registration", () => {
  it("canonicalizes object keys deterministically without changing arrays", () => {
    const left = canonicalConversionSchema({
      version: "1.0.0",
      rules: [{ coarse: "low", fine: 1 }],
      enabled: true,
    });
    const right = canonicalConversionSchema({
      enabled: true,
      rules: [{ fine: 1, coarse: "low" }],
      version: "1.0.0",
    });
    assert.equal(left, right);
    assert.equal(left, '{"enabled":true,"rules":[{"coarse":"low","fine":1}],"version":"1.0.0"}');
  });

  it("rejects non-object and non-finite definitions", () => {
    assert.throws(() => canonicalConversionSchema([]), /definition_invalid/);
    assert.throws(() => canonicalConversionSchema({ fine: Number.NaN }), /non_finite_number/);
  });
});
