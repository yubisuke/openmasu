import type { googleDestinationHistory } from "../google-data-manager-admin.js";
import type { previewGoogleDestination } from "../google-destination-readiness.js";
import { escapeHtml as e } from "./html.js";

export function googleDestinationForm(form: URLSearchParams): Record<string, unknown> {
  return { operating_account_id: form.get("operating_account_id"), conversion_action_id: form.get("conversion_action_id"),
    enabled: form.get("enabled") === "true", app_audience: form.get("app_audience"),
    readiness: Object.fromEntries(["source", "action_type", "action_status", "action_owner_account_id", "conversion_action_id", "access_model", "permission", "purpose"]
      .map(key => [key, form.get(`review_${key}`) ?? "unknown"])) };
}
export function renderGoogleDestination(appId: string, csrf: string, history: Awaited<ReturnType<typeof googleDestinationHistory>>,
  preview?: ReturnType<typeof previewGoogleDestination>) {
  const base = `/dashboard/apps/${encodeURIComponent(appId)}/google-data-manager`;
  const definition = preview?.definition ?? history[0]?.definition ?? {};
  const readiness = (definition.readiness ?? {}) as Record<string, unknown>;
  const input = (name: string, value: unknown = "") => `<label>${e(name)} <input name="${name}" value="${e(String(value ?? ""))}" maxlength="64" required></label>`;
  const select = (name: string, options: string[], value: unknown) => `<label>${e(name)} <select name="${name}">${options.map(option => `<option${option === value ? " selected" : ""}>${option}</option>`).join("")}</select></label>`;
  const token = `<input type="hidden" name="csrf_token" value="${e(csrf)}">`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Google delivery readiness — OpenMasu</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Google delivery readiness</h1><a href="/dashboard/apps/${encodeURIComponent(appId)}">Back to app</a>
    <p>Direct advertiser access and UPLOAD_CLICKS only. This is operator-reviewed configuration, not a Google permission check or App Campaign integration. Do not paste credentials or provider response bodies. Unknown or denied evidence blocks activation. No additional identifiers are collected. Refund restatement is not sent.</p>
    <form method="post" action="${base}/preview">${token}${input("operating_account_id", definition.operating_account_id)}${input("conversion_action_id", definition.conversion_action_id)}
    ${select("app_audience", ["general", "mixed", "child_directed"], definition.app_audience)}${select("enabled", ["false", "true"], String(definition.enabled ?? false))}
    <fieldset><legend>Sanitized operator review of the exact action and credential access</legend>
    ${select("review_source", ["unknown", "operator_review"], readiness.source)}${input("review_action_type", readiness.action_type ?? "unknown")}
    ${select("review_action_status", ["unknown", "ENABLED", "DISABLED"], readiness.action_status)}
    ${input("review_action_owner_account_id", readiness.action_owner_account_id ?? "unknown")}${input("review_conversion_action_id", readiness.conversion_action_id ?? "unknown")}
    ${select("review_access_model", ["unknown", "direct", "manager", "partner"], readiness.access_model)}${select("review_permission", ["unknown", "granted", "denied"], readiness.permission)}
    ${select("review_purpose", ["unknown", "click_import", "app_campaign_optimization"], readiness.purpose)}</fieldset><button type="submit">Preview without contacting Google</button></form>
    ${preview ? `<h2>Preview</h2><p>Ready: ${preview.ready}. Live access verified: false.</p><p>${e(preview.boundary)}</p><ul>${preview.blockers.map(reason => `<li>${e(reason)}</li>`).join("")}</ul><pre>${e(JSON.stringify(preview.definition, null, 2))}</pre>
      ${preview.ready || !preview.definition.enabled ? `<form method="post" action="${base}">${token}<input type="hidden" name="definition" value="${e(JSON.stringify(preview.definition))}"><input type="hidden" name="preview_digest" value="${e(preview.preview_digest)}"><input type="hidden" name="expected_revision" value="${history[0]?.revision ?? 0}"><button type="submit">${preview.definition.enabled ? "Activate reviewed revision" : "Save disabled revision"}</button></form>` : ""}` : ""}
    <h2>Immutable history (latest 50)</h2><ul>${history.map(row => `<li>Revision ${row.revision}; ${e(row.created_at)}; ready ${row.ready}; digest ${e(row.definition_digest)}<pre>${e(JSON.stringify(row.definition))}</pre></li>`).join("")}</ul>
    <p>Replacement stops old queued ingestion; it never moves old events to a new action. Requests already started may complete, and their diagnostics retain the original revision. Disabling stops further provider calls. Old definitions are retained for audit.</p></main></body></html>`;
}
