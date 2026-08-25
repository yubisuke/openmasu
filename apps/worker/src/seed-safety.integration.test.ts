import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import type { Pool } from "pg";
import { createSeedPool } from "@openmasu/runtime";
import { withSyntheticSeedLock } from "./seed-safety.js";

describe("WO13 synthetic seed serialization", { concurrency: false }, () => {
  let pool: Pool;

  before(() => {
    pool = createSeedPool();
  });

  after(async () => {
    await pool.end();
  });

  it("serializes concurrent synthetic seed jobs with one session advisory lock", async () => {
    const order: string[] = [];
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>((resolve) => { enterFirst = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withSyntheticSeedLock(pool, async () => {
      order.push("first-enter");
      enterFirst();
      await release;
      order.push("first-exit");
    });
    await entered;
    const second = withSyntheticSeedLock(pool, async () => {
      order.push("second-enter");
    });
    try {
      await delay(100);
      assert.deepEqual(order, ["first-enter"]);
    } finally {
      releaseFirst();
    }
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
  });
});
