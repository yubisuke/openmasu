import type { FraudPreview,FraudPreviewRequest } from "../fraud-preview.js";
import { escapeHtml as h } from "./html.js";

export function renderFraudPreview(input:{appId:string;csrfToken:string;request:FraudPreviewRequest;preview:FraudPreview}):string {
  const {preview,request}=input;
  const activation={rule_bundle_id:request.definition.id,rule_bundle_version:request.definition.version,rule_bundle_hash:preview.candidate.hash,
    definition:request.definition,supersedes_rule_bundle_revision_id:preview.baseline_revision_id,
    preview:{receipt:preview.receipt,watermark_at_most:preview.watermark_at_most,baseline_revision_id:preview.baseline_revision_id}};
  const value=(side:any)=>side?.value_state==="present" && typeof side.value_unscaled==="string" ? h(side.value_unscaled)
    : `— (${h(side?.undefined_reason ?? side?.value_state ?? "unavailable")})`;
  const rows=preview.metrics.map(row=>`<tr><th scope="row">${h(row.metric_name)}</th><td>${h(row.fraud_policy)}</td><td>${h(JSON.stringify(row.grouping?.dimensions ?? {}))}</td><td>${value(row.active)}</td><td>${value(row.candidate)}</td><td>${row.delta_unscaled === undefined ? "—":h(row.delta_unscaled)}</td><td>${h(row.active?.currency ?? row.active?.value_type ?? row.reason ?? "unavailable")}; scale ${h(row.active?.amount_scale ?? row.active?.ratio_scale ?? "n/a")}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Fraud bundle preview</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main>
    <h1>Fraud bundle preview</h1><p>Read-only counterfactual comparison. No rule, decision, metric, capability or audit state was changed.</p>
    <p>Fraud actions are enabled in this what-if. These are counts on the same available evidence, not a fraud detection rate, precision estimate or live forecast.</p>
    <dl><dt>Evidence cutoff</dt><dd>${h(preview.watermark_at_most)}</dd><dt>Available records</dt><dd>${h(preview.evidence.available_records)}</dd><dt>Excluded unavailable records</dt><dd>${h(preview.evidence.excluded_unavailable_records)}</dd>
    <dt>Baseline</dt><dd>${h(preview.active.id)} ${h(preview.active.version)} / ${h(preview.active.hash)}</dd><dt>Candidate</dt><dd>${h(preview.candidate.id)} ${h(preview.candidate.version)} / ${h(preview.candidate.hash)}</dd>
    <dt>Changed decisions</dt><dd>${preview.changed_decisions === null ? "Unavailable":h(preview.changed_decisions)}</dd>
    <dt>Baseline actions</dt><dd>${preview.calculation_available ? h(JSON.stringify(preview.active.by_action)):"Unavailable"}</dd>
    <dt>Candidate actions</dt><dd>${preview.calculation_available ? h(JSON.stringify(preview.candidate.by_action)):"Unavailable"}</dd><dt>Receipt</dt><dd>${h(preview.receipt)}</dd></dl>
    <h2>Gross and net metric effects</h2><p>Counterfactual values use the saved profiles at this cutoff, not a rewrite of saved metric runs. Integer values retain the displayed scale.</p>
    <table><thead><tr><th scope="col">Metric</th><th scope="col">Policy</th><th scope="col">Grouping</th><th scope="col">Baseline</th><th scope="col">Candidate</th><th scope="col">Delta</th><th scope="col">Unit</th></tr></thead><tbody>${rows}</tbody></table>
    ${preview.issues.length ? `<h2>Activation blocked</h2><ul>${preview.issues.map(issue=>`<li>${h(issue)}</li>`).join("")}</ul>`:""}
    ${preview.can_activate ? `<h2>Confirm activation</h2><p>Activation rechecks the definition, predecessor and captured evidence receipt. It never rewrites past decisions.</p><form method="post" action="/dashboard/apps/${encodeURIComponent(input.appId)}/rule-bundles"><input type="hidden" name="csrf_token" value="${h(input.csrfToken)}"><input type="hidden" name="definition_json" value="${h(JSON.stringify(activation))}"><button type="submit">Activate this reviewed candidate</button></form>`:""}
    <p><a href="/dashboard/apps/${encodeURIComponent(input.appId)}">Return to the app</a></p></main></body></html>`;
}
