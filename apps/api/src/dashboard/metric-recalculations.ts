import { normalizeMetricRecalculationRequest, type CostRecalculationRequest } from "@openmasu/runtime";
import type { listMetricRecalculations } from "../metric-recalculations.js";
import { escapeHtml as escape } from "./render.js";

const fields = ["cost_import_run_id", "date_from", "date_to", "watermark", "metric_names"] as const;

/** Transport decoding only. The API normalizer and request service own limits and selection. */
export function metricRecalculationFormRequest(form: URLSearchParams): CostRecalculationRequest {
  if ([...form.keys()].some(key => !["csrf_token", ...fields].includes(key) || form.getAll(key).length !== 1)) {
    throw new Error("metric_recalculation_form_invalid");
  }
  const names = (form.get("metric_names") ?? "").trim();
  const request = normalizeMetricRecalculationRequest({
    cost_import_run_id: form.get("cost_import_run_id"), date_from: form.get("date_from"),
    date_to: form.get("date_to"), watermark: form.get("watermark"),
    ...(names ? { metric_names: names.split(/[\s,]+/) } : {}),
  });
  if (request.trigger_kind === "late_events") throw new Error("metric_recalculation_form_invalid");
  return request;
}

export function renderMetricRecalculations(
  appId: string, rows: Awaited<ReturnType<typeof listMetricRecalculations>>,
  csrfToken: string, canOperate: boolean, confirmation?: CostRecalculationRequest,
): string {
  const app = `/dashboard/apps/${encodeURIComponent(appId)}`;
  const base = `${app}/metric-recalculations`;
  const csrf = `<input type="hidden" name="csrf_token" value="${escape(csrfToken)}">`;
  const details = (id: string | null) => id ? `<a href="${app}/metrics/${encodeURIComponent(id)}/explanation">${escape(id)}</a>` : "Not recorded";
  const seen = new Set<string>();
  const history = rows.map(row => {
    const anchor = seen.has(row.recalculation_id) ? "" : ` id="${escape(row.recalculation_id)}"`;
    seen.add(row.recalculation_id);
    return `<tr${anchor}><th scope="row">${escape(row.recalculation_id)}</th><td>${escape(row.trigger_kind)}</td><td>${escape(row.cost_import_run_id ?? "not a cost import")}</td><td>${escape(row.date_from)} through ${escape(row.date_to)} (inclusive)</td><td>${escape(row.watermark)}</td><td>${escape(row.state ?? "No selected run; not a completed calculation")}</td><td>${escape(row.safe_reason ?? row.selection_status ?? "none")}</td><td>${details(row.source_metric_run_id)}</td><td>${details(row.replacement_metric_run_id)}</td></tr>`;
  }).join("");
  const values = confirmation ? { ...confirmation, metric_names: confirmation.metric_names?.join(", ") ?? "" } : undefined;
  const review = canOperate && values ? `<section><h2>Confirm the requested input range</h2><dl>${fields.map(key => `<dt>${escape(key)}</dt><dd>${escape(values[key] || "All supported metric names")}</dd>`).join("")}</dl><p>No job has been requested by this preview. The existing service will validate the completed receipt, current eligible runs and limits when you confirm. This preview does not claim a target count or provider completeness.</p><form method="post" action="${base}">${csrf}${fields.map(key => `<input type="hidden" name="${key}" value="${escape(values[key])}">`).join("")}<button type="submit">Request this recalculation</button></form><p><a href="${base}">Cancel and edit</a></p></section>` : "";
  const form = canOperate && !confirmation ? `<section><h2>Request a cost-driven recalculation</h2><p>Use a completed cost import receipt. Dates include both endpoints (maximum 31 days); at most 100 existing runs may be selected. The UTC watermark must cover the revised input. No all-history or replacement-definition option exists.</p><form method="post" action="${base}/preview">${csrf}<label>Completed cost import ID <input name="cost_import_run_id" required></label><label>First cohort date <input type="date" name="date_from" required></label><label>Last cohort date (inclusive) <input type="date" name="date_to" required></label><label>Watermark (YYYY-MM-DDTHH:mm:ss.SSSZ) <input name="watermark" required></label><label>Metric names (optional, comma separated) <input name="metric_names"></label><button type="submit">Review requested conditions</button></form></section>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Metric recalculations — OpenMasu</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Metric recalculations</h1><p>App: ${escape(appId)} · <a href="${app}">Return to reports</a></p><p>Latest 20 jobs, with up to 100 saved selections each. Refresh to observe the existing worker; reading this page does not queue work. Late-input jobs created through the API are also listed. A missing replacement is not a completed run. A changed value alone does not prove that cost was its only cause.</p>${rows.length ? `<table><caption>Recorded jobs and original/replacement results</caption><thead><tr><th scope="col">Job</th><th scope="col">Trigger</th><th scope="col">Cost receipt</th><th scope="col">Cohort range</th><th scope="col">Watermark</th><th scope="col">State</th><th scope="col">Reason</th><th scope="col">Original saved details</th><th scope="col">Replacement saved details</th></tr></thead><tbody>${history}</tbody></table>` : "<p>No recalculation jobs recorded.</p>"}${review}${form}${!canOperate ? "<p>Read-only access: the operate capability is required to request recalculation.</p>" : ""}<p>Saved details retain their own meaning and unavailable/redacted evidence. Identical normalized requests reuse the existing job; they do not force a fresh calculation.</p></main></body></html>`;
}
