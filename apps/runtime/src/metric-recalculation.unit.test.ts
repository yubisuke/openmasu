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

it("keeps late-input requests bounded, explicit and independent from cost receipts", () => {
  const late = { trigger_kind: "late_events", date_from: "2026-08-01", date_to: "2026-08-31",
    watermark: request.watermark, source_record_ids: ["synthetic-b", "synthetic-a", "synthetic-b"] };
  assert.deepEqual(normalizeMetricRecalculationRequest(late), { ...late, source_record_ids: ["synthetic-a", "synthetic-b"] });
  for (const mutation of [{ source_record_ids: [] }, { source_record_ids: Array(101).fill("synthetic-a") },
    { source_record_ids: ["not/an/identifier"] }, { cost_import_run_id: request.cost_import_run_id },
    { trigger_kind: "all_events" }, { date_to: "2026-09-01" }, { source_record_ids: null }]) {
    assert.throws(() => normalizeMetricRecalculationRequest({ ...late, ...mutation }), /metric_recalculation_request_invalid/);
  }
});

it("discovers input only within one explicit bounded receipt interval, never an implicit history scan", () => {
  const range = { trigger_kind: "late_events", date_from: "2026-08-01", date_to: "2026-08-31",
    watermark: request.watermark, source_received_from: "2026-08-31T00:00:00.000Z", source_received_to: request.watermark };
  assert.deepEqual(normalizeMetricRecalculationRequest(range), range);
  for (const mutation of [{ source_received_from: "2026-08-30T00:00:00.000Z" }, { source_received_to: "2026-09-02T00:00:00.000Z" },
    { source_received_from: request.watermark }, { source_record_ids: ["synthetic-a"] }, { source_received_to: "invalid" }]) {
    assert.throws(() => normalizeMetricRecalculationRequest({ ...range, ...mutation }), /metric_recalculation_request_invalid/);
  }
});
