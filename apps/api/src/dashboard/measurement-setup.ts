import { metricProfileMetadata } from "@openmasu/contracts/definitions";
import type { RecommendedMetricSchedulePreview } from "../metric-schedules.js";
import { measurementNotices, type MeasurementHealth } from "../measurement-notices.js";
import { escapeHtml as escape } from "./html.js";

export function recommendedMetricScheduleFormRequest(form: URLSearchParams): Record<string, unknown> {
  const allowed = ["csrf_token", "recommended_profile", "acquisition_basis", "target_currency", "cutoff_policy",
    "lag_days", "start_date", "include_retention", "custom_conversion_event_keys", "preview_digest"];
  if ([...form.keys()].some(key => !allowed.includes(key)
      || key !== "custom_conversion_event_keys" && form.getAll(key).length !== 1)) {
    throw new Error("metric_schedule_form_invalid");
  }
  if (!/^\d{1,3}$/.test(form.get("lag_days") ?? "")) throw new Error("recommended_lag_days_invalid");
  if (form.has("include_retention") && !["true", "false"].includes(form.get("include_retention")!)) {
    throw new Error("recommended_retention_invalid");
  }
  return { recommended_profile: form.get("recommended_profile"), acquisition_basis: form.get("acquisition_basis"),
    target_currency: form.get("target_currency"), cutoff_policy: form.get("cutoff_policy"),
    lag_days: Number(form.get("lag_days")), include_retention: form.get("include_retention") === "true",
    custom_conversion_event_keys: form.getAll("custom_conversion_event_keys"),
    ...(form.get("start_date") ? { start_date: form.get("start_date") } : {}),
    ...(form.has("preview_digest") ? { preview_digest: form.get("preview_digest") } : {}) };
}

export function renderMeasurementSetup(appId: string, csrf: string, keys: readonly string[], health?: MeasurementHealth): string {
  const app = `/dashboard/apps/${encodeURIComponent(appId)}`;
  const progress = health ? `<section><h2>Measurement setup progress</h2><p>Retained history observed at ${escape(health.observed_at)}. These are separate evidence counts, not a conversion funnel or source-completeness proof.</p><ol>
    <li>SDK configuration: ${escape(health.sdk.active_keys)} active keys; ${escape(health.sdk.batches)} received batches. A key is not a verified device connection. <a href="${app}">App and SDK settings</a></li>
    <li>Accepted logical events: ${escape(health.events.logical_events)}; imports: ${escape(health.imports.runs)}. <a href="${app}/records">Inspect safe record counts</a></li>
    <li>Daily calculation: ${escape(health.metrics.active_schedules)} active schedules; ${escape(health.metrics.pending_schedules)} pending targets; ${escape(health.metrics.runs)} stored runs. <a href="#recommended-set">Configure a recommended set</a></li>
    <li>Comparison: stored runs may be compared only with compatible definitions and input conditions. <a href="${app}/comparison">Open saved comparison</a></li></ol><ul>${measurementNotices(health).map(notice => `<li data-measurement-state="${escape(notice.state)}">${escape(notice.message)} ${escape(notice.next)}</li>`).join("")}</ul></section>` : "";
  return `${progress}<section id="recommended-set"><h2>Enable a recommended measurement set</h2><p>No handwritten definition JSON is needed. Preview the exact immutable definitions before registering. Only the capabilities below are supported by this convenience form; other bases, currencies and windows remain explicit advanced configurations, never silently substituted.</p>
    <form method="post" action="${app}/metric-schedules/preview-recommended"><input type="hidden" name="csrf_token" value="${escape(csrf)}">
    <label>Metric set <select name="recommended_profile"><option value="native_d7_v1">D7 installs, cost, CPI, advertising and purchase net revenue, total net revenue and ROAS</option></select></label>
    <label>Acquisition basis <select name="acquisition_basis"><option value="selected_first_party_click">Selected first-party click (native acquisition)</option></select></label>
    <label>Reporting currency <select name="target_currency"><option value="USD">USD, scale 6 (same-currency identity; no FX feed)</option></select></label>
    <label>Cutoff <select name="cutoff_policy"><option value="utc_start_of_worker_day">UTC midnight at worker claim; elapsed D7 cohort window</option></select></label>
    <label>Lag days <input type="number" name="lag_days" min="9" max="365" value="9" required></label>
    <label>Start cohort date (optional) <input type="date" name="start_date"></label>
    <label><input type="checkbox" name="include_retention" value="true" checked> Include D1 and D7 session-start retention</label>
    ${keys.length ? `<fieldset><legend>Optional observed custom outcomes (up to 20)</legend>${keys.map(key => `<label><input type="checkbox" name="custom_conversion_event_keys" value="${escape(key)}">${escape(key)}</label>`).join("")}</fieldset>` : "<p>Optional custom outcomes become selectable after consented custom events are observed.</p>"}
    <button type="submit">Preview recommended set</button></form>
    <p>Campaign discovery is capped at 20 targets per date. Organic and unattributed remain separate. Missing cost is undefined with a reason, not zero. Currency/FX mismatches fail calculation rather than inventing a conversion. Zero observed sessions does not prove complete activity delivery. Revenue conversion is USD identity only; non-USD inputs require deliberate advanced FX configuration. Preview and page reads never calculate or register a run.</p></section>`;
}

export function renderRecommendedMetricSchedulePreview(appId: string, preview: RecommendedMetricSchedulePreview, csrf: string): string {
  const base = `/dashboard/apps/${encodeURIComponent(appId)}/metric-schedules`;
  const selection = { ...preview.selection, preview_digest: preview.preview_digest };
  const fields = Object.entries(selection).flatMap(([name, value]) => (Array.isArray(value) ? value : [value])
    .map(item => `<input type="hidden" name="${escape(name)}" value="${escape(item)}">`)).join("");
  const rows = preview.definition.metric_definitions.map(definition => `<tr><th scope="row">${escape(definition.metric_name)}</th><td>${escape(metricProfileMetadata(definition)?.label ?? "Unregistered profile")}</td><td>${escape(definition.value_type)}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenMasu recommended measurement preview</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Review recommended measurement</h1><p><a href="${base}">Back to schedules</a></p><dl><dt>Start cohort date</dt><dd>${escape(preview.startDate)}</dd><dt>Lag days</dt><dd>${escape(preview.lagDays)}</dd><dt>Immutable definition digest</dt><dd>${escape(preview.definitionDigest)}</dd></dl><table><caption>Existing validated metric definitions</caption><thead><tr><th scope="col">Metric</th><th scope="col">Profile</th><th scope="col">Value type</th></tr></thead><tbody>${rows}</tbody></table><details><summary>Complete saved definition</summary><pre>${escape(JSON.stringify(preview.definition, null, 2))}</pre></details><p>This preview has not registered a schedule or computed a metric. Confirmation rechecks available keys, definition digest and active ownership. Existing runs are not changed.</p><p>UTC elapsed D7, native first-party acquisition, gross fraud policy, USD identity only, 20 discovered targets per date. Missing cost yields undefined with a reason. Currency/FX mismatches fail calculation; zero observed sessions does not prove complete activity delivery. A nine-day lag closes the selected window but does not guarantee source completeness. Other acquisition bases and currencies are not converted into this profile.</p><form method="post" action="${base}"><input type="hidden" name="csrf_token" value="${escape(csrf)}">${fields}<button type="submit">Confirm recommended schedule</button></form></main></body></html>`;
}
