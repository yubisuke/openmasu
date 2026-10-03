import assert from "node:assert/strict";
import { it } from "node:test";
import { correctionCutoff, normalizeMetricCorrectionPolicy } from "./metric-correction-policy.js";

it("bounds opt-in automatic correction period, page and cycle budgets without all-history defaults",()=>{
  const request={enabled:true,date_from:"2026-08-01",date_to:"2026-08-31",metric_names:["d0_roas","d0_roas"]};
  assert.deepEqual(normalizeMetricCorrectionPolicy(request),{...request,metric_names:["d0_roas"],
    receipts_per_cycle:5,runs_per_page:20,maximum_runs_per_receipt:200});
  for (const change of [{enabled:undefined},{date_to:"2026-09-01"},{date_from:"2026-02-30"},
    {runs_per_page:101},{receipts_per_cycle:21},{maximum_runs_per_receipt:1001},{all_history:true},{metric_names:[]}]) {
    assert.throws(()=>normalizeMetricCorrectionPolicy({...request,...change}),/metric_correction_policy_invalid/);
  }
  assert.equal(normalizeMetricCorrectionPolicy({...request,enabled:false}).enabled,false);
});

it("covers microsecond receipt cutoffs without silently truncating them backwards",()=>{
  assert.equal(correctionCutoff("2026-08-01T00:00:00.000001Z"),"2026-08-01T00:00:00.001Z");
  assert.equal(correctionCutoff("2026-08-01T23:59:59.999999Z"),"2026-08-02T00:00:00.000Z");
  assert.equal(correctionCutoff("2026-08-01T00:00:00.123000Z"),"2026-08-01T00:00:00.123Z");
  assert.throws(()=>correctionCutoff("untrusted source"),/input_unavailable/);
});
