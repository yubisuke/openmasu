import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { M1B_METRIC_DEFINITIONS, SELECTED_COMMERCE_METRIC_DEFINITIONS, validateEventPayload, validateMetricDefinition } from "@openmasu/contracts";
import { evaluate, sha256 } from "./evaluator.js";

type Any = Record<string, any>;
const source = (): Any => JSON.parse(readFileSync("fixtures/v0.4/60-selected-commerce/input.json", "utf8"));
const values = (value: Any) => Object.fromEntries(evaluate(value).metric_runs.map(r => [r.metric_name, r.value_unscaled]));

describe("selected acquisition commerce cohorts", () => {
  it("binds all existing commerce windows to an explicit new definition and hand-calculated net values", () => {
    const value = source();
    for (const r of value.records) assert.equal(validateEventPayload(r.event_name, r.payload).valid, true);
    value.metric_definitions = structuredClone(SELECTED_COMMERCE_METRIC_DEFINITIONS);
    value.metric_evaluations[0].metric_names = value.metric_definitions.map((d: Any) => d.metric_name);
    for (const d of value.metric_definitions) assert.equal(validateMetricDefinition(d), true);
    for (const run of evaluate(value).metric_runs) assert.equal(run.value_unscaled,
      run.metric_name.includes("purchase") ? "6000000" : run.value_type === "ratio" ? "2600000" : "26000000");
    const bad = structuredClone(value.metric_definitions.find((d: Any) => d.value_type === "ratio"));
    delete bad.cost_selection_policy;
    assert.equal(validateMetricDefinition(bad), false);
    assert.throws(() => evaluate({ ...value, metric_definitions: [bad] }), /metric_definition_series_mismatch/);
    const legacy = source();
    legacy.metric_definitions = M1B_METRIC_DEFINITIONS.filter(d => legacy.metric_evaluations[0].metric_names.includes(d.metric_name));
    assert.equal(values(legacy).cohort_purchase_net_revenue_d30_usd, "0");
  });

  for (const excluded of ["unbound", "other-installation", "pending", "reversed"]) {
    it(`does not include ${excluded} commerce or its ineligible refund in a selected campaign`, () => {
      const value = source();
      const purchase = value.records.find((r: Any) => r.event_name === "purchase");
      if (excluded === "unbound") delete purchase.payload.installation_id;
      else if (excluded === "other-installation") purchase.payload.installation_id = "synthetic-other-installation";
      else purchase.payload.financial_status = excluded;
      assert.equal(values(value).cohort_purchase_net_revenue_d30_usd, "0");
      assert.equal(values(value).d30_total_net_roas, "2000000");
    });
  }

  it("deduplicates commerce retries and keeps refund caps and elapsed boundaries", () => {
    const value = source();
    const original = evaluate(value).metric_runs;
    for (const record of value.records.filter((r: Any) => ["purchase", "refund"].includes(r.event_name))) {
      value.records.push({ ...structuredClone(record), record_id: `${record.record_id}-retry`, delivery_id: `${record.delivery_id}-retry` });
    }
    assert.deepEqual(evaluate(value).metric_runs, original);
    const overCap = source();
    overCap.records.find((r: Any) => r.event_name === "refund").payload.amount_unscaled = "11000000";
    assert.equal(values(overCap).cohort_purchase_net_revenue_d30_usd, "10000000");
    assert.ok(evaluate(overCap).rejections.some(r => r.reason_code === "refund_target_invalid"));
    const boundary = source();
    boundary.records.find((r: Any) => r.event_name === "refund").occurred_at = "2026-09-06T00:00:00.000Z";
    boundary.server_context.received_at = "2026-09-07T00:00:00.000Z";
    for (const r of boundary.records) r.received_at = boundary.server_context.received_at;
    boundary.metric_evaluations[0].input_received_at_watermark = boundary.server_context.received_at;
    assert.equal(values(boundary).cohort_purchase_net_revenue_d30_usd, "10000000");
  });

  for (const field of ["tenant_id", "app_id"] as const) it(`keeps commerce inside its ${field} scope`, () => {
    const value = source();
    const foreign = { ...value.server_context, [field]: `${value.server_context[field]}-other` };
    value.batches = [
      { server_context: value.server_context, records: value.records.slice(0, 3) },
      { server_context: foreign, records: value.records.slice(3).map((r: Any) => ({ ...r, [field]: foreign[field] })) },
    ];
    delete value.records;
    assert.equal(values(value).cohort_purchase_net_revenue_d30_usd, "0");
    assert.equal(values(value).d30_total_net_roas, "2000000");
  });

  it("does not replace unknown acquisition or ambiguous costs with a guessed value", () => {
    const value = source();
    value.records[0].payload.campaign_id = "synthetic-other-campaign";
    assert.equal(values(value).cohort_purchase_net_revenue_d30_usd, "0");
    const overlap = source();
    overlap.cost_records.push({ ...overlap.cost_records[0], cost_record_id: "cost60-other-grain", country: "US",
      dimension_digest: "unused" });
    // The contract digest must describe the exact additional dimensions.
    overlap.cost_records[1].dimension_digest = sha256({ network: "synthetic-network", campaign_id: "campaign-a", country: "US" });
    const run = evaluate(overlap).metric_runs.find(r => r.metric_name === "d30_total_net_roas")!;
    assert.equal(run.undefined_reason, "overlapping_cost_grains");
    assert.equal(Object.hasOwn(run, "value_unscaled"), false);
  });

  it("keeps late commerce outside the earlier watermark and does not resurrect a redacted selected click", () => {
    const value = source();
    const original = evaluate(value).metric_runs;
    const late = "2026-08-13T00:00:00.000Z";
    value.batches = [
      { server_context: value.server_context, records: value.records.slice(0, 3) },
      { server_context: { ...value.server_context, received_at: late }, records: value.records.slice(3).map((r: Any) => ({ ...r, received_at: late })) },
    ];
    delete value.records;
    assert.equal(values(value).d30_total_net_roas, "2000000");
    value.metric_evaluations[0].input_received_at_watermark = late;
    assert.equal(values(value).d30_total_net_roas, "2600000");
    const privacy = JSON.parse(readFileSync("fixtures/v0.4/17-redaction-recalculation/input.json", "utf8"));
    value.privacy_requests = [{ ...privacy.privacy_requests[0], affected_records: [{ record_id: "click-1", lifecycle_status: "redacted" }] }];
    value.metric_evaluations[0].privacy_state = "after";
    assert.equal(values(value).cohort_purchase_net_revenue_d30_usd, "0");
    assert.equal(evaluate(value).metric_runs[0].reproducibility_status, "redaction_affected");
    assert.deepEqual(evaluate(source()).metric_runs, original);
  });
});
