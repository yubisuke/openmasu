import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retryDeadlockOnce } from "./seed-safety.js";

describe("WO13 synthetic seed deadlock handling", () => {
  it("retries one PostgreSQL 40P01 failure and returns the second result", async () => {
    let attempts = 0;
    const result = await retryDeadlockOnce(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("synthetic deadlock"), { code: "40P01" });
      return "recovered";
    });
    assert.equal(result, "recovered");
    assert.equal(attempts, 2);
  });

  it("does not retry a non-deadlock database failure", async () => {
    let attempts = 0;
    await assert.rejects(retryDeadlockOnce(async () => {
      attempts += 1;
      throw Object.assign(new Error("synthetic constraint failure"), { code: "23505" });
    }), /synthetic constraint failure/);
    assert.equal(attempts, 1);
  });

  it("stops after one retry when PostgreSQL reports a second 40P01", async () => {
    let attempts = 0;
    await assert.rejects(retryDeadlockOnce(async () => {
      attempts += 1;
      throw Object.assign(new Error(`synthetic deadlock ${attempts}`), { code: "40P01" });
    }), /synthetic deadlock 2/);
    assert.equal(attempts, 2);
  });
});
