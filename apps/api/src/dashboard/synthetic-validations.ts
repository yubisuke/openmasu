import { SYNTHETIC_VALIDATION_EVENTS } from "@openmasu/runtime";
import type { SyntheticValidationCreated, SyntheticValidationStatus } from "../synthetic-validations.js";
import { escapeHtml as e } from "./html.js";

export function renderSyntheticValidation(input: { appId: string; csrfToken: string; canAdminister: boolean;
  created?: SyntheticValidationCreated; status?: SyntheticValidationStatus; error?: string }): string {
  const base = `/dashboard/apps/${encodeURIComponent(input.appId)}/synthetic-validations`;
  const csrf = `<input type="hidden" name="csrf_token" value="${e(input.csrfToken)}">`;
  const form = input.canAdminister && !input.created && !input.status && !input.error ? `<form method="post" action="${base}">${csrf}
    <fieldset><legend>Expected synthetic event classes</legend>${SYNTHETIC_VALIDATION_EVENTS.map(event => `<label><input type="checkbox" name="expected_events" value="${event}"${["install", "session_start"].includes(event) ? " checked" : ""}>${event}</label>`).join(" ")}</fieldset>
    <label>Exact expected custom-event keys, comma-separated (optional; select custom_event)<input name="expected_custom_keys" maxlength="1040"></label>
    <label>Lifetime in seconds (60–1800)<input name="ttl_seconds" type="number" min="60" max="1800" value="600" required></label>
    <button type="submit">Create disposable validation session</button></form>` : "";
  const created = input.created ? `<h2>Session token — shown once</h2><p>Set this token explicitly in the synthetic app's SDK validation configuration. It does not enable collection, enroll an installation or prove delivery. Never use real data.</p>
    <p><code>${e(input.created.session_token)}</code></p><p>Expires: ${e(input.created.expires_at)}</p>
    <p><a href="${base}/${e(input.created.session_id)}">Read this session's receipts</a></p>` : "";
  const status = input.status ? `<h2>Recorded validation evidence</h2><p>Expires: ${e(input.status.expires_at)}. ${input.status.batch_count}/50 batches; ${input.status.event_count}/200 submitted events.</p>
    <table><caption>Declared expectations; zeros are not proof of correct SDK behavior</caption><thead><tr><th>Event / exact custom key</th><th>Accepted</th><th>Rejected</th><th>Duplicate</th><th>Unresolved</th></tr></thead><tbody>${input.status.expectations.map(row => `<tr><th>${e(row.event_name)}${row.custom_key ? ` / ${e(row.custom_key)}` : ""}</th><td>${row.accepted}</td><td>${row.rejected}</td><td>${row.duplicate}</td><td>${row.unresolved}</td></tr>`).join("")}</tbody></table>
    <table><caption>Opaque receipts from this session only</caption><thead><tr><th>Receipt</th><th>Processing</th><th>Accepted / rejected / duplicate / unresolved</th><th>Safe rejection reasons</th><th>Saved metric input reference</th></tr></thead><tbody>${input.status.receipts.map(row => `<tr><th>${e(row.validation_receipt)}</th><td>${row.processing_state}</td><td>${row.accepted} / ${row.rejected} / ${row.duplicate} / ${row.unresolved}</td><td>${row.rejection_reasons.map(reason => `${e(reason.reason)}: ${reason.count}`).join(", ") || "None observed"}</td><td>${row.metric_state} (${row.saved_input_references})</td></tr>`).join("")}</tbody></table>
    <p>Input references are not proof that an event contributed to a metric's numeric value. Only the latest 100 saved runs are inspected; unknown_limit is not zero. Reload this page to observe later work; GET never runs jobs.</p>
    ${input.canAdminister ? `<form method="post" action="${base}/${e(input.status.session_id)}/close">${csrf}<button type="submit">Close and remove validation associations</button></form>` : ""}` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Synthetic validation · OpenMasu</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Synthetic SDK validation</h1>
    <p><a href="/dashboard/apps/${encodeURIComponent(input.appId)}/measurement-health">Back to measurement health</a></p>
    <p>Only an isolated database created as synthetic_disposable can use this feature. It does not turn a persistent deployment into a test environment. No real devices, data, credentials or provider requests are required.</p>
    <p>A queued receipt is HTTP admission, not accepted ledger evidence. Expectations are declarations, not an automatic success verdict. Expiry or close removes the association, not the underlying synthetic ledger.</p>
    ${input.error ? `<p role="alert">${e(input.error)}</p>` : ""}${form}${created}${status}</main></body></html>`;
}
