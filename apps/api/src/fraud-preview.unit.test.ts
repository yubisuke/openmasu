import assert from "node:assert/strict";
import { it } from "node:test";
import { DEFAULT_FRAUD_BUNDLE } from "@openmasu/fraud-rules";
import { parseFraudPreviewRequest,type FraudPreview } from "./fraud-preview.js";
import { renderFraudPreview } from "./dashboard/fraud-preview.js";

it("fraud_preview_request_is_closed_canonical_bounded_and_never_accepts_an_implicit_cutoff",()=>{
  const body={definition:DEFAULT_FRAUD_BUNDLE,watermark_at_most:"2026-08-22T00:00:00.000Z"};
  assert.deepEqual(parseFraudPreviewRequest(body),parseFraudPreviewRequest(body));
  for (const bad of [{...body,watermark_at_most:undefined},{...body,watermark_at_most:"2026-08-22"},
    {...body,watermark_at_most:"9999-01-01T00:00:00.000Z"},{...body,baseline_revision_id:123},
    {...body,definition:{...DEFAULT_FRAUD_BUNDLE,id:"not-fraud"}},{...body,record_id:"forbidden"}]) {
    assert.throws(()=>parseFraudPreviewRequest(bad),/fraud_preview_/);
  }
});
it("fraud_preview_HTML_is_zero_JS_escapes_candidate_text_and_never_renders_unknown_impact_as_zero",()=>{
  const request={definition:{...DEFAULT_FRAUD_BUNDLE,version:"synthetic-<script>"},watermark_at_most:"2026-08-22T00:00:00.000Z"};
  const model:FraudPreview={receipt:"a".repeat(64),watermark_at_most:request.watermark_at_most,baseline_revision_id:"revision:synthetic",
    active:{id:"fraud-conservative",version:"1.0.0",hash:"b".repeat(64)},candidate:{id:"fraud-conservative",version:request.definition.version,hash:"c".repeat(64)},
    calculation_available:false,changed_decisions:null,metrics:[],evidence:{available_records:1,excluded_unavailable_records:2,source_days:0,evidence_digest:"d".repeat(64)},
    issues:["historical_fraud_inputs_missing"],can_activate:false,writes:false,basis:"counterfactual_actions_enabled_on_same_available_evidence"};
  const html=renderFraudPreview({appId:"app-synthetic",csrfToken:"synthetic-csrf",request,preview:model});
  assert.doesNotMatch(html,/<script|javascript:|\son[a-z]+\s*=/i);
  assert.match(html,/synthetic-&lt;script&gt;/);assert.match(html,/Unavailable/);
  assert.match(html,/not a fraud detection rate/);assert.doesNotMatch(html,/Activate this reviewed candidate/);
  assert.match(html,/historical_fraud_inputs_missing/);
});
