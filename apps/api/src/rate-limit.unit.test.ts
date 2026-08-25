import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeyedTokenBucket, TokenBucket } from "./rate-limit.js";

describe("in-process token bucket", () => {
  it("rejects a burst and refills from a monotonic clock", () => {
    const bucket = new TokenBucket(2, 2, 0);
    assert.equal(bucket.allow(0), true);
    assert.equal(bucket.allow(0), true);
    assert.equal(bucket.allow(0), false);
    assert.equal(bucket.allow(500), true);
  });

  it("bounds per-principal keys and expires idle entries", () => {
    const bucket = new KeyedTokenBucket(1, 1, 2, 100);
    assert.equal(bucket.allow("a", 0), true);
    assert.equal(bucket.allow("a", 0), false);
    assert.equal(bucket.allow("b", 1), true);
    assert.equal(bucket.allow("c", 2), true);
    assert.equal(bucket.size, 2);
    assert.equal(bucket.allow("d", 200), true);
    assert.equal(bucket.size, 1);
  });
});
