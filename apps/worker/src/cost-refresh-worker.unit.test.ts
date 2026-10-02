import assert from "node:assert/strict";
import { it } from "node:test";
import type { Pool } from "pg";
import { EnvironmentSecretStore } from "@openmasu/runtime";
import { processCostRefreshes } from "./cost-refresh-worker.js";

it("disabled cost refresh performs no database, secret or provider reads", async () => {
  const forbidden = () => { throw new Error("unexpected read"); };
  assert.deepEqual(await processCostRefreshes({ connect: forbidden } as unknown as Pool, "tenant-synthetic", {
    enabled: false, secrets: { read: forbidden, require: forbidden }, fetch: forbidden,
  }), { completed: 0, empty: 0, failed: 0, fenced: 0 });
});
it("cost refresh rejects unbounded scheduler work before touching the database", async () => {
  const forbidden = () => { throw new Error("unexpected database read"); };
  await assert.rejects(processCostRefreshes({ connect: forbidden } as unknown as Pool, "tenant-synthetic", {
    enabled: true, secrets: new EnvironmentSecretStore({}), maximumSchedules: 101,
  }), { message: "cost_refresh_limit_invalid" });
});
