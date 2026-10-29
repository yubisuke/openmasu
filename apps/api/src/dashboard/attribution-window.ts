import type { AttributionWindowPreview, AttributionWindowRequest, attributionWindowSettings } from "../attribution-window-preview.js";
import { escapeHtml as h } from "./html.js";

function page(appId: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>First-party attribution window</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>First-party attribution window</h1>${body}<p><a href="/dashboard/apps/${encodeURIComponent(appId)}">Return to the app</a></p></main></body></html>`;
}
export function renderAttributionWindowSettings(input: { appId: string; csrfToken: string; current: Awaited<ReturnType<typeof attributionWindowSettings>> }) {
  const { current } = input;
  return page(input.appId, `<p>Only first-party Install Referrer attribution uses this choice. Imported, platform, organic and engagement results retain their existing meaning.</p>
    <dl><dt>Effective window</dt><dd>${h(current.days)} days, exclusive upper bound</dd><dt>Bundle</dt><dd>${h(current.id)} / ${h(current.version)} / ${h(current.hash)}</dd><dt>Activation</dt><dd>${h(current.activated_at ?? "Historical default; no opt-in activation")}</dd></dl>
    <h2>Preview a candidate</h2><p>Choose at most 31 UTC install-occurrence days and a fixed server receipt cutoff. The preview is bounded to 1,000 native first-party installs and 2,000 referenced clicks. Missing or removed evidence is unavailable, not zero. Counts compare policies on the same retained evidence; they are not a provider forecast or saved-metric recalculation.</p>
    <form method="post" action="/dashboard/apps/${encodeURIComponent(input.appId)}/rule-bundles/preview"><input type="hidden" name="csrf_token" value="${h(input.csrfToken)}"><input type="hidden" name="preview_kind" value="first_party_window">
    <label>Lookback days <select name="lookback_days"><option value="1">1</option><option value="7" selected>7</option><option value="30">30</option></select></label>
    <label>Install date from (inclusive) <input type="date" name="date_from" required></label><label>Install date to (exclusive) <input type="date" name="date_to" required></label>
    <label>Receipt cutoff (UTC milliseconds) <input name="watermark_at_most" placeholder="2026-10-01T00:00:00.000Z" required></label><button type="submit">Preview without changing policy</button></form>
    <p>Activation applies by each installation's original server receipt. Historical installs, late-click repair and saved metric runs keep their prior revision. Activation never starts a backfill.</p>`);
}
export function renderAttributionWindowPreview(input: { appId: string; csrfToken: string; request: AttributionWindowRequest; preview: AttributionWindowPreview }) {
  const { preview: result, request } = input;
  const activation = { rule_bundle_id: request.definition.id, rule_bundle_version: request.definition.version, definition: request.definition,
    rule_bundle_hash: result.candidate.hash, ...(result.baseline_revision_id ? { supersedes_rule_bundle_revision_id: result.baseline_revision_id } : {}),
    preview: { receipt: result.receipt, date_from: request.date_from, date_to: request.date_to, watermark_at_most: request.watermark_at_most,
      ...(result.baseline_revision_id ? { baseline_revision_id: result.baseline_revision_id } : {}) } };
  const countRows = [...new Set([...Object.keys(result.active_counts ?? {}), ...Object.keys(result.candidate_counts ?? {})])].sort()
    .map(reason => `<tr><th scope="row">${h(reason)}</th><td>${h(result.active_counts?.[reason] ?? 0)}</td><td>${h(result.candidate_counts?.[reason] ?? 0)}</td></tr>`).join("");
  return page(input.appId, `<p>Read-only counterfactual on the same retained evidence. No policy, audit or ledger state was changed. This is before fraud exclusions, not a metric value or a provider guarantee.</p>
    <dl><dt>Install occurrence range</dt><dd>[${h(result.date_from)}, ${h(result.date_to)}) UTC</dd><dt>Receipt cutoff</dt><dd>${h(result.watermark_at_most)}</dd>
    <dt>Current window</dt><dd>${h(result.active.days)} days / ${h(result.active.hash)}</dd><dt>Candidate window</dt><dd>${h(result.candidate.days)} days / ${h(result.candidate.hash)}</dd>
    <dt>First-party installs / referenced clicks / unavailable</dt><dd>${h(result.evidence.install_count)} / ${h(result.evidence.click_count)} / ${h(result.evidence.unavailable_count)}</dd>
    <dt>Changed decisions</dt><dd>${result.changed_decisions === null ? "Unavailable" : h(result.changed_decisions)}</dd><dt>Receipt</dt><dd>${h(result.receipt)}</dd></dl>
    ${result.calculation_available ? `<table><thead><tr><th scope="col">Reason</th><th scope="col">Current</th><th scope="col">Candidate</th></tr></thead><tbody>${countRows}</tbody></table>` : "<p>Comparison unavailable; no zero result is implied.</p>"}
    ${result.issues.length ? `<h2>Activation blocked</h2><ul>${result.issues.map(issue => `<li>${h(issue)}</li>`).join("")}</ul>` : ""}
    ${result.can_activate ? `<h2>Confirm future activation</h2><p>This rechecks the current revision and evidence receipt. Past installations and saved metrics are not rewritten or automatically recalculated.</p><form method="post" action="/dashboard/apps/${encodeURIComponent(input.appId)}/rule-bundles"><input type="hidden" name="csrf_token" value="${h(input.csrfToken)}"><input type="hidden" name="definition_json" value="${h(JSON.stringify(activation))}"><button type="submit">Activate this reviewed window</button></form>` : ""}`);
}
