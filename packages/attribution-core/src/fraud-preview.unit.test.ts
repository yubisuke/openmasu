import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { DEFAULT_FRAUD_BUNDLE, fraudBundleHash, type FraudBundle } from "@openmasu/fraud-rules";
import { evaluate, jcs } from "./evaluator.js";
import { attempts } from "./candidates.js";
import { previewAcceptedFraudEvidence } from "./fraud-preview.js";

function fixture(name: string) {return JSON.parse(readFileSync(`fixtures/v0.4/${name}/input.json`,"utf8"));}
function preview(input: any,definition: FraudBundle) {
  const noFraud = structuredClone(input);
  noFraud.server_context.fraud_enabled = false;
  const initial = evaluate(noFraud).attributions;
  return previewAcceptedFraudEvidence({attempts:attempts(input),initialAttributions:initial,metricInput:input,definition});
}
it("fraud_preview_reuses_admitted_projection_for_manual_gross_net_and_threshold_differences_without_mutation", () => {
  const input=fixture("50-gross-net-metrics"),before=jcs(input),bundle=structuredClone(DEFAULT_FRAUD_BUNDLE);
  const active=preview(input,bundle);
  const flagged=preview(input,{...bundle,version:"synthetic-all-flag",rules:bundle.rules.map(rule=>({...rule,action:"flag"}))});
  assert.equal(jcs(active.metric_runs),jcs(evaluate(input).metric_runs));
  const values=(result:typeof active)=>Object.fromEntries(result.metric_runs.map(run=>[run.metric_name,run.value_unscaled]));
  assert.deepEqual(values(active),{fraud_gross_install_count:"1",fraud_net_install_count:"0"});
  assert.deepEqual(values(flagged),{fraud_gross_install_count:"1",fraud_net_install_count:"1"});
  assert.equal(active.fraud_decisions[0].action,"exclude"); assert.equal(flagged.fraud_decisions[0].action,"flag");
  assert.equal(jcs(input),before);
  const ctit=fixture("41-click-injection-suspected");
  assert.equal(preview(ctit,bundle).fraud_decisions.filter(hit=>hit.reason_code==="click_injection_suspected").length,1);
  const changed={...bundle,version:"synthetic-threshold",layers:{...bundle.layers,base:{...bundle.layers.base,ctit_lower_bound_seconds:1}}};
  assert.equal(preview(ctit,changed).fraud_decisions.filter(hit=>hit.reason_code==="click_injection_suspected").length,0);
  const negative=structuredClone(ctit);
  const click=negative.records.find((record:any)=>record.event_name==="click");
  const install=negative.records.find((record:any)=>record.event_name==="install");
  click.payload.redirector_click_at=new Date(Date.parse(install.payload.install_begin_at_server)+1_000).toISOString();
  const anomaly=preview(negative,bundle).fraud_decisions.find(hit=>hit.reason_code==="ctit_clock_anomaly");
  assert.equal(anomaly?.decision,"clear"); assert.equal(anomaly?.action,"allow");
  // Source-only evidence must use the selected definition even without a click
  // or install from which the ordinary evaluator can recover its binding.
  const source=fixture("48-source-scoped-fraud");
  const aggregateInput={source_day_aggregates:source.source_day_aggregates,metric_evaluations:[]};
  const sourceCandidate={...bundle,version:"synthetic-source-only",rules:bundle.rules.map(rule=>({...rule,action:"flag" as const}))};
  const sourceResult=previewAcceptedFraudEvidence({attempts:[],initialAttributions:[],metricInput:aggregateInput,definition:sourceCandidate});
  assert.ok(sourceResult.fraud_decisions.length>0);
  assert.ok(sourceResult.fraud_decisions.every(hit=>hit.rule_bundle_hash===fraudBundleHash(sourceCandidate)&&hit.action==="flag"));
});
