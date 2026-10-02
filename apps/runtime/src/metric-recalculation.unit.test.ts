import assert from "node:assert/strict";
import { it } from "node:test";
import { normalizeMetricRecalculationRequest } from "./metric-recalculation.js";

const request = { cost_import_run_id: "01800000-0000-7000-8000-000000000000", date_from: "2026-08-01",
  date_to: "2026-08-31", watermark: "2026-09-01T00:00:00.000Z" };
it("normalizes bounded correction requests deterministically without accepting credentials or global history", () => {
  assert.deepEqual(normalizeMetricRecalculationRequest({ ...request, metric_names: ["d7_roas", "d1_roas", "d7_roas"] }),
    { ...request, metric_names: ["d1_roas", "d7_roas"] });
  for (const mutation of [{ date_to: "2026-09-01" }, { date_from: "2026-02-30" }, { date_to: "2026-07-31" },
    { watermark: "2026-09-01" }, { cost_import_run_id: "private-invalid-value" }, { all_history: true },
    { metric_names: [] }, { metric_names: ["private-invalid-value!"] }]) {
    assert.throws(() => normalizeMetricRecalculationRequest({ ...request, ...mutation }), error =>
      error instanceof Error && error.message === "metric_recalculation_request_invalid");
  }
});
