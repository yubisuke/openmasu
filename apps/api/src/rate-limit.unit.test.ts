import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TokenBucket } from "./rate-limit.js";

describe("in-process token bucket", () => {
  it("rejects a burst and refills from a monotonic clock", () => {
    const bucket = new TokenBucket(2, 2, 0);
    assert.equal(bucket.allow(0), true);
    assert.equal(bucket.allow(0), true);
    assert.equal(bucket.allow(0), false);
    assert.equal(bucket.allow(500), true);
  });
});
