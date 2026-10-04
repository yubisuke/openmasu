import { metricProfileMetadata, standardRetentionMetricDefinitions } from "@openmasu/contracts/definitions";
import type { MetricScheduleRecord } from "../metric-schedules.js";
import { metricScheduleRequestDefinition } from "../metric-schedule-definition.js";
import type { MetricScheduleReplacementPreview } from "../metric-schedule-replacements.js";
import { escapeHtml as escape } from "./html.js";
import { recommendedMetricScheduleFormRequest, renderMeasurementSetup } from "./measurement-setup.js";
import type { MeasurementHealth } from "../measurement-notices.js";

/** Decode transport only; registerMetricSchedule owns all definition validation. */
export function metricScheduleFormRequest(form: URLSearchParams, disable = false): Record<string, unknown> {
  if (!disable && form.has("recommended_profile")) return recommendedMetricScheduleFormRequest(form);
  if (!disable && form.has("standard_retention_day")) {
    const allowed = ["csrf_token", "standard_retention_day", "acquisition_basis", "import_provider", "fraud_policy", "lag_days", "start_date"];
    if ([...form.keys()].some(key => !allowed.includes(key) || key !== "standard_retention_day" && form.getAll(key).length !== 1)) {
      throw new Error("metric_schedule_form_invalid");
    }
    const days = form.getAll("standard_retention_day");
    if (days.some(day => !["3", "14", "30"].includes(day)) || new Set(days).size !== days.length
        || !/^\d{1,3}$/.test(form.get("lag_days") ?? "32") || !["gross", "net"].includes(form.get("fraud_policy") ?? "gross")) {
      throw new Error("standard_retention_selection_invalid");
    }
    const basis = form.get("acquisition_basis") ?? "selected_first_party_click";
    if (!["selected_first_party_click", "selected_verified_platform", "selected_imported_provider"].includes(basis)) throw new Error("standard_retention_basis_invalid");
    const definitions = standardRetentionMetricDefinitions(basis as Parameters<typeof standardRetentionMetricDefinitions>[0],
      form.get("import_provider") || undefined).filter(definition => days.includes(String(definition.definition.window.day)))
      .map(definition => ({ ...definition, fraud_policy: (form.get("fraud_policy") ?? "gross") as "gross" | "net" }));
    return { lag_days: Number(form.get("lag_days") ?? "32"), ...(form.get("start_date") ? { start_date: form.get("start_date") } : {}),
      fx_policy: { policy_version: "retention-no-money-v1", target_currency: "USD", target_scale: 6,
        rounding_mode: "half_even", rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0,
          source: "identity-not-used-for-retention", as_of: "1970-01-01T00:00:00.000Z" }] },
      metric_definitions: definitions, evaluations: [{ metric_names: definitions.map(definition => definition.metric_name),
        date_dimension: "cohort_date", grouping: {} }] };
  }
  if (!disable && form.has("custom_conversion_event_keys")) {
    const allowed = ["csrf_token", "custom_conversion_event_keys", "lag_days", "start_date"];
    if ([...form.keys()].some(key => !allowed.includes(key)
        || key !== "custom_conversion_event_keys" && form.getAll(key).length !== 1)) {
      throw new Error("metric_schedule_form_invalid");
    }
    if (!/^\d{1,3}$/.test(form.get("lag_days") ?? "9")) throw new Error("custom_conversion_lag_days_invalid");
    return { custom_conversion_event_keys: form.getAll("custom_conversion_event_keys"),
      lag_days: Number(form.get("lag_days") ?? "9"),
      ...(form.get("start_date") ? { start_date: form.get("start_date") } : {}) };
  }
  const allowed = disable ? ["csrf_token"] : ["csrf_token", "request_json"];
  if ([...form.keys()].some(key => !allowed.includes(key) || form.getAll(key).length !== 1)) {
    throw new Error("metric_schedule_form_invalid");
  }
  if (disable) return {};
  let body: unknown;
  try { body = JSON.parse(form.get("request_json") ?? ""); }
  catch { throw new Error("metric_schedule_json_invalid"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("metric_schedule_json_invalid");
  return body as Record<string, unknown>;
}

function renderMetricProfiles(definitions: MetricScheduleRecord["definition"]["metric_definitions"]): string {
  if (!definitions.length) return "";
  return `<ul aria-label="Supplied metric profiles">${definitions.map(definition => {
    const metadata = metricProfileMetadata(definition);
    return `<li>${escape(definition.metric_name)}: ${escape(metadata?.label ?? "Unregistered bundle identity (legacy or external declaration)")}</li>`;
  }).join("")}</ul>`;
}

export function metricScheduleReplacementFormRequest(form: URLSearchParams): Record<string, unknown> {
  const allowed = ["csrf_token", "request_json", "preview_digest", "supersession"];
  if ([...form.keys()].some(key => !allowed.includes(key) || (key !== "supersession" && form.getAll(key).length !== 1))) {
    throw new Error("metric_schedule_form_invalid");
  }
  const body = metricScheduleFormRequest(new URLSearchParams({ request_json: form.get("request_json") ?? "" }));
  if (form.has("preview_digest")) body.preview_digest = form.get("preview_digest");
  if (form.has("supersession")) {
    try { body.supersessions = form.getAll("supersession").map(value => JSON.parse(value)); }
    catch { throw new Error("metric_schedule_supersessions_invalid"); }
  }
  return body;
}

export function renderMetricScheduleReplacement(appId: string, preview: MetricScheduleReplacementPreview, csrfToken: string): string {
  const base = `/dashboard/apps/${encodeURIComponent(appId)}/metric-schedules`;
  const request = { mode: preview.mode, schedule: preview.schedule, supersessions: [] };
  const rows = preview.source_runs.map(run => `<tr><th scope="row">${escape(run.source_metric_run_id)}</th><td>${escape(run.target_date)}</td><td><code>${escape(run.calculation_key_digest)}</code><details><summary>Complete saved calculation keys</summary><pre>${escape(JSON.stringify(run.calculation_key, null, 2))}</pre></details></td><td>${run.can_supersede ? `<label><input type="checkbox" name="supersession" value="${escape(JSON.stringify({ source_metric_run_id: run.source_metric_run_id, calculation_key_digest: run.calculation_key_digest }))}">Explicitly supersede this run</label>` : "History only; not eligible for this replacement"}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenMasu schedule replacement preview</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Review schedule replacement</h1><p><a href="${base}">Back to schedules</a></p><dl><dt>Source schedule</dt><dd>${escape(preview.source_metric_schedule_id)}</dd><dt>Mode</dt><dd>${escape(preview.mode)}</dd><dt>Effective start date</dt><dd>${escape(preview.effective_start_date)}</dd><dt>Complete definition unchanged</dt><dd>${escape(preview.definition_matches)}</dd><dt>Pending target date</dt><dd>${escape(preview.in_flight.pending_target_date ?? "none")}</dd><dt>In-flight policy</dt><dd>Wait for the claimed date to finish; never cancel or delete it.</dd></dl><h2>Definition and scheduling differences</h2>${preview.definition_changes.length ? `<pre>${escape(JSON.stringify(preview.definition_changes, null, 2))}</pre>` : "<p>No definition or scheduling fields changed.</p>"}<p>Meaning changes start a separate series. Same-meaning replacements supersede only the runs you explicitly select below, after full-key validation. Other history remains unchanged. Opening this preview has not replaced a schedule or calculated a metric.</p><form method="post" action="${base}/${encodeURIComponent(preview.source_metric_schedule_id)}/replace"><input type="hidden" name="csrf_token" value="${escape(csrfToken)}"><input type="hidden" name="preview_digest" value="${escape(preview.preview_digest)}"><input type="hidden" name="request_json" value="${escape(JSON.stringify(request))}">${rows ? `<table><caption>Saved source runs and explicit handoffs</caption><thead><tr><th scope="col">Run</th><th scope="col">Target date</th><th scope="col">Calculation keys</th><th scope="col">Handoff</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No source runs with complete calculation keys are available for handoff.</p>"}${preview.in_flight.can_replace ? '<button type="submit">Confirm atomic replacement</button>' : "<p>Replacement is blocked: finish the pending date or refresh the schedule state and preview again.</p>"}</form></main></body></html>`;
}

function renderCustomConversionScheduleForm(base: string, csrf: string, keys: readonly string[]): string {
  return `<section><h2>Schedule custom outcomes</h2><p>Select from the first 100 available observed event keys for this app, ordered by key. Each key owns independent D7 count/rate series. This uses the existing worker and calculator; no event payload or installation ID is displayed. The app-wide cohort is used, and a nine-day lag covers the complete elapsed window.</p>${keys.length ? `<form method="post" action="${base}">${csrf}<fieldset><legend>Observed outcome keys (select up to 50)</legend>${keys.map(key => `<label><input type="checkbox" name="custom_conversion_event_keys" value="${escape(key)}">${escape(key)}</label>`).join("")}</fieldset><label>Lag days <input type="number" name="lag_days" min="9" max="365" value="9" required></label><label>Start cohort date (optional) <input type="date" name="start_date"></label><button type="submit">Register selected outcomes</button></form>` : "<p>No available custom-event keys have been observed yet. Send a consented SDK custom event before registering this convenience schedule. Advanced definitions remain available below.</p>"}</section>`;
}

function renderStandardRetentionForm(base: string, csrf: string): string {
  return `<section><h2>Schedule D3 / D14 / D30 retention</h2><p>Opt in to distinct retained installations, not unique people. Each activity day is [install + N days, install + (N + 1) days). The 32-day default covers D30 for the full cohort date. Before that window ends, values are undefined, not 0%. Late receipts still require an explicit correction; elapsed time is not provider completeness. Existing D1/D7 schedules are unchanged.</p><form method="post" action="${base}">${csrf}<fieldset><legend>Activity days</legend>${[3, 14, 30].map(day => `<label><input type="checkbox" name="standard_retention_day" value="${day}" checked>D${day}</label>`).join("")}</fieldset><label>Acquisition basis <select name="acquisition_basis"><option value="selected_first_party_click">Native selected first-party</option><option value="selected_verified_platform">Verified platform (separate)</option><option value="selected_imported_provider">Imported provider (separate)</option></select></label><label>Imported provider code (only for imported basis)<input name="import_provider" maxlength="64"></label><label>Fraud population <select name="fraud_policy"><option value="gross">Gross</option><option value="net">Net</option></select></label><label>Lag days <input type="number" name="lag_days" min="5" max="365" value="32" required></label><label>Start cohort date (optional)<input type="date" name="start_date"></label><button type="submit">Register selected retention days</button></form></section>`;
}

export function renderMetricSchedules(appId: string, schedules: readonly MetricScheduleRecord[], csrfToken: string, keys: readonly string[] = [], health?: MeasurementHealth): string {
  const base = `/dashboard/apps/${encodeURIComponent(appId)}/metric-schedules`;
  const csrf = `<input type="hidden" name="csrf_token" value="${escape(csrfToken)}">`;
  const rows = schedules.map(schedule => {
    const replacementRequest = { mode: "new_series", schedule: { lag_days: schedule.lag_days,
      start_date: schedule.start_date, ...metricScheduleRequestDefinition(schedule.definition) } };
    const selection = new URLSearchParams({ metric_schedule_id: schedule.metric_schedule_id,
      supersession: schedule.status === "active" ? "latest" : "all" });
    return `<tr data-metric-schedule-id="${escape(schedule.metric_schedule_id)}"><th scope="row">${escape(schedule.metric_schedule_id)}<p><a href="/dashboard/apps/${encodeURIComponent(appId)}?${escape(selection)}">Read this schedule series</a></p></th><td>${escape(schedule.status)}</td><td>${escape(schedule.lag_days)}</td><td>${escape(schedule.start_date)}</td><td>${escape(schedule.last_target_date ?? "not processed")}</td><td>${escape(schedule.pending_target_date ?? "none")}</td><td>${escape(schedule.safe_reason ?? "none")}</td><td><p>Date zone: ${escape(schedule.definition.cohort_time_zone ?? "UTC")}</p><code>${escape(schedule.definition_digest)}</code>${renderMetricProfiles(schedule.definition.metric_definitions)}<details><summary>Immutable definition</summary><pre>${escape(JSON.stringify(schedule.definition, null, 2))}</pre></details>${schedule.latest_discovery ? `<details><summary>Latest discovery receipt (not provider completeness)</summary><pre>${escape(JSON.stringify(schedule.latest_discovery, null, 2))}</pre></details>` : ""}${schedule.replacement ? `<details><summary>Explicit replacement receipt</summary><pre>${escape(JSON.stringify(schedule.replacement, null, 2))}</pre></details>` : ""}</td><td>${schedule.status === "active" ? `<form method="post" action="${base}/${encodeURIComponent(schedule.metric_schedule_id)}/disable">${csrf}<button type="submit">Disable</button></form><details><summary>Replace with an explicitly reviewed schedule</summary><form method="post" action="${base}/${encodeURIComponent(schedule.metric_schedule_id)}/preview-replacement">${csrf}<label>Replacement request JSON (same_meaning or new_series)<textarea name="request_json" rows="12" required spellcheck="false">${escape(JSON.stringify(replacementRequest, null, 2))}</textarea></label><button type="submit">Preview replacement</button></form></details>` : "Disabled; retained for history"}</td></tr>`;
  }).join("");
return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenMasu metric schedules</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Daily metric schedules</h1><p>App: ${escape(appId)} · <a href="/dashboard/apps/${encodeURIComponent(appId)}">Back to cohort reports</a></p><p>These are the same immutable schedules used by the admin API and existing durable worker. Refresh this page to read progress; opening it does not start a calculation.</p>${renderMeasurementSetup(appId, csrfToken, keys, health)}${renderCustomConversionScheduleForm(base, csrf, keys)}${renderStandardRetentionForm(base, csrf)}${schedules.length ? `<table><caption>Saved schedule state and target-date checkpoints</caption><thead><tr><th scope="col">Schedule</th><th scope="col">Status</th><th scope="col">Lag days</th><th scope="col">Start date</th><th scope="col">Last completed target date</th><th scope="col">Pending target date</th><th scope="col">Safe reason</th><th scope="col">Definition digest and evidence</th><th scope="col">Action</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No metric schedules are registered for this app.</p>"}<section><h2>Register a schedule</h2><p>Start with <a href="https://github.com/yubisuke/openmasu/blob/main/examples/synthetic/metric-schedule.json">the synthetic schedule JSON</a>. Paste the complete API request, including fx_policy and evaluations, and optional metric_definitions. Set lag_days (1–365) and an optional YYYY-MM-DD start_date in that JSON; do not add static dates to evaluation grouping. When omitted, lag_days defaults to 1 and start_date to the currently eligible date in the definition zone (UTC for historical schedules). The request is validated by the same service as the API.</p><p>The synthetic FX snapshot is an example, not a production rate feed. Use a deliberate lag long enough for the selected metric window. Registration does not assert source completeness or execute a run immediately.</p><form method="post" action="${base}">${csrf}<label>Complete schedule request JSON <textarea name="request_json" rows="18" required spellcheck="false"></textarea></label><button type="submit">Register daily calculation</button></form></section><p>A metric name may belong to only one active schedule per app. Definitions, lag and start date cannot be edited. Preview an explicit replacement to change them atomically, or disable and register an independent series. There is no resume or run-now action. Disablement prevents new claims, but an already claimed date may finish; replacement waits for that date to settle. Existing definitions, checkpoints and metric runs remain stored. Select a schedule series above to avoid combining different meanings. A missing checkpoint is not a successful run.</p></main></body></html>`;
}
