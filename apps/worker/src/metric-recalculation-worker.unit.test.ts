import assert from "node:assert/strict";
import { it } from "node:test";
import type { Pool } from "pg";
import { processMetricRecalculations } from "./metric-recalculation-worker.js";
it("rejects unbounded recalculation cycles before acquiring a database connection", async () => {
  const pool = { connect: () => { throw new Error("must not connect"); } } as unknown as Pool;
  for (const maximum of [0, 11, 1.5, NaN]) await assert.rejects(processMetricRecalculations(pool, "tenant-a", maximum), /metric_recalculation_limit_invalid/);
});
