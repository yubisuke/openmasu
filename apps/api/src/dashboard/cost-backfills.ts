import { costBackfillDates, type CostBackfillPlan } from "@openmasu/runtime";
import type { CostBackfillOverview } from "../cost-backfills.js";
import { escapeHtml as escape } from "./html.js";

export function costBackfillForm(form: URLSearchParams, confirmation: boolean): Record<string, unknown> {
  const allowed = ["csrf_token", "cost_schedule_id", "dates", "retry_of", ...(confirmation ? ["as_of", "receipt"] : [])];
  if ([...form.keys()].some(key => !allowed.includes(key) || key !== "dates" && form.getAll(key).length !== 1)) throw new Error("cost_backfill_request_invalid");
  return { cost_schedule_id: form.get("cost_schedule_id"), dates: form.getAll("dates"),
    ...(form.has("retry_of") ? { retry_of: form.get("retry_of") } : {}),
    ...(confirmation ? { as_of: form.get("as_of"), receipt: form.get("receipt") } : {}) };
}
export function costBackfillBrowseQuery(query: URLSearchParams): Record<string, unknown> | undefined {
  if (!query.size) return undefined;
  if ([...query.keys()].some(key => !["cost_schedule_id", "date_from", "date_to"].includes(key) || query.getAll(key).length !== 1)) throw new Error("cost_backfill_request_invalid");
  return { cost_schedule_id: query.get("cost_schedule_id"), dates: costBackfillDates(query.get("date_from"), query.get("date_to")) };
}
const head = (appId: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenMasu cost recovery</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Recover missing cost days</h1><p><a href="/dashboard/apps/${encodeURIComponent(appId)}">App reports</a> · <a href="/dashboard/apps/${encodeURIComponent(appId)}/metric-recalculations">Saved metric corrections</a></p>`;
const boundary = `<p>At most 31 dates per confirmation. Each day uses the registered provider, account selection, currency and acquisition limits; no new credentials are supplied here. Provider retention and complete source coverage are unknown. An absent history entry is not proof of missing cost. Empty acquisition preserves prior cost and is not a zero-spend assertion. A recorded zero cost row is different from an empty response. Fees, currency, country, timezone and detail grains are never substituted.</p><p>Acquisition is asynchronous, with a 120-second database lease, a 60-second request deadline and at most three attempts per day. Retries keep the fixed as-of, but the provider may change its response. No end-to-end exactly-once guarantee is made. A cost revision does not update stored ROAS unless the existing automatic correction policy is enabled or an operator requests a saved metric correction. Retention- or privacy-unavailable replay stays unavailable.</p>`;
const hidden = (name: string, value: unknown) => `<input type="hidden" name="${name}" value="${escape(value)}">`;

export function renderCostBackfills(appId: string, overview: CostBackfillOverview, csrf: string, canOperate: boolean,
  selection?: CostBackfillPlan, message?: string): string {
  const base = `/dashboard/apps/${encodeURIComponent(appId)}/cost-backfills`;
  const choose = canOperate && selection ? `<section><h2>Select eligible dates</h2><form method="post" action="${base}/preview">
    ${hidden("csrf_token", csrf)}${hidden("cost_schedule_id", selection.cost_schedule_id)}
    <table><caption>Recorded acquisition state, not source completeness</caption><thead><tr><th scope="col">Select</th><th scope="col">Day</th><th scope="col">State</th><th scope="col">Rows</th></tr></thead><tbody>${selection.days.map(day => `<tr><td>${day.eligible ? `<input type="checkbox" name="dates" value="${day.date}" checked aria-label="Select ${day.date}">` : "Not eligible"}</td><th scope="row">${day.date}</th><td>${escape(day.state)} ${escape(day.safe_reason ?? "")}</td><td>${day.row_count ?? "Unknown"}</td></tr>`).join("")}</tbody></table>
    <button type="submit">Preview selected dates</button></form></section>` : "";
  const jobs = overview.jobs.map(job => `<section id="${job.receipt}"><h2>Recovery ${escape(job.created_at)}</h2><dl><dt>Receipt</dt><dd>${job.receipt}</dd><dt>Schedule</dt><dd>${escape(job.cost_schedule_id)}</dd><dt>Fixed as-of</dt><dd>${job.as_of}</dd><dt>Configuration digest</dt><dd>${job.definition_digest}</dd><dt>Parent</dt><dd>${job.parent_receipt ?? "Independent request"}</dd></dl>
    <table><caption>Day results</caption><thead><tr><th scope="col">Day</th><th scope="col">State</th><th scope="col">Attempts</th><th scope="col">Rows</th><th scope="col">Reason</th><th scope="col">Cost import revision</th></tr></thead><tbody>${job.days.map(day => `<tr><th scope="row">${day.date}</th><td>${escape(day.state)}</td><td>${day.attempts}</td><td>${day.row_count ?? "Unknown"}</td><td>${escape(day.safe_reason ?? "—")}</td><td>${escape(day.import_run_id ?? "No new revision")}</td></tr>`).join("")}</tbody></table>
    ${canOperate && job.days.some(day => day.state === "failed") ? `<form method="post" action="${base}/preview">${hidden("csrf_token", csrf)}${hidden("cost_schedule_id", job.cost_schedule_id)}${hidden("retry_of", job.receipt)}<fieldset><legend>Retry only these failed days</legend>${job.days.filter(day => day.state === "failed").map(day => `<label><input type="checkbox" name="dates" value="${day.date}" checked>${day.date}</label>`).join("")}</fieldset><button type="submit">Preview failed-day recovery</button></form>` : ""}</section>`).join("");
  return `${head(appId)}${message ? `<p role="status">${escape(message)}</p>` : ""}${boundary}
    <form method="get" action="${base}"><label>Registered cost schedule <select name="cost_schedule_id" required>${overview.schedules.filter(schedule => schedule.status === "active").map(schedule => `<option value="${escape(schedule.cost_schedule_id)}">${escape(schedule.backfill_configuration.provider)} · ${escape(schedule.cost_schedule_id)}</option>`).join("")}</select></label><label>From <input type="date" name="date_from" required></label><label>Through <input type="date" name="date_to" required></label><button type="submit">Inspect day range</button></form>
    ${choose}<h2>Recent recovery history</h2><p>Up to 20 recent requests are shown. Completed and empty days are not included in a failed-day retry. Earlier daily range history was not recorded per day; it is not reconstructed as zero or success.</p>${jobs || "<p>No recovery requests recorded.</p>"}</main></body></html>`;
}

export function renderCostBackfillPreview(appId: string, plan: CostBackfillPlan, csrf: string): string {
  const base = `/dashboard/apps/${encodeURIComponent(appId)}/cost-backfills`;
  const fields = Object.entries(plan.confirmation).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map(item => hidden(name, item))).join("");
  return `${head(appId)}<p><a href="${base}">Recovery history</a></p><h2>Confirm fixed recovery plan</h2>${boundary}
    <dl><dt>Provider</dt><dd>${escape(plan.configuration.provider)} / ${escape(plan.configuration.api_version)}</dd><dt>Currency</dt><dd>${escape(plan.configuration.currency)}</dd><dt>Configuration digest</dt><dd>${plan.definition_digest}</dd><dt>Fixed as-of</dt><dd>${plan.as_of}</dd><dt>Receipt</dt><dd>${plan.receipt}</dd><dt>Acquisition limits per day</dt><dd>${escape(JSON.stringify(plan.configuration.limits))}</dd></dl>
    <table><caption>Only eligible dates will be queued</caption><thead><tr><th scope="col">Day</th><th scope="col">Recorded state</th><th scope="col">Action</th></tr></thead><tbody>${plan.days.map(day => `<tr><th scope="row">${day.date}</th><td>${escape(day.state)}</td><td>${day.eligible ? "Acquire this day" : "Keep recorded result; do not acquire"}</td></tr>`).join("")}</tbody></table>
    ${plan.days.some(day => day.eligible) ? `<form method="post" action="${base}">${hidden("csrf_token", csrf)}${fields}<button type="submit">Confirm recovery</button></form>` : "<p>No eligible dates. Nothing will be queued.</p>"}</main></body></html>`;
}
