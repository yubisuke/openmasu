import { escapeHtml as e } from "./html.js";
import { reportFields } from "./report-controls.js";
import type { SavedAnalysis } from "../saved-analysis.js";
import { visibleAnalysisRows, type AnalysisObservation, type PeriodAnalysis } from "../period-analysis.js";
import { acquisitionPeriodRows, type AcquisitionPeriodSide, type AcquisitionPeriodValue } from "../acquisition-period.js";

const shell = (title: string, content: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(title)} · OpenMasu</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>${e(title)}</h1>${content}</main></body></html>`;
const input = (name: string, label: string, value: string, required = false) => `<label>${e(label)} <input name="${e(name)}" value="${e(value)}"${required ? " required" : ""}></label>`;
const csrf = (token: string) => `<input type="hidden" name="csrf_token" value="${e(token)}">`;
export function renderSavedAnalyses(appId: string, views: readonly SavedAnalysis[], token: string, canSave: boolean, params: URLSearchParams): string {
  const base = `/dashboard/apps/${encodeURIComponent(appId)}/analyses`;
  const fields = reportFields.filter(([key]) => !["grouping_cohort_date", "grouping_metric_date", "difference_reason_code"].includes(key));
  return shell("Saved daily analyses", `<p><a href="/dashboard/apps/${encodeURIComponent(appId)}">Back to cohort and activity reports</a></p>
<p>App-scoped, shared report filters only. Opening a view reads current stored runs; it neither schedules calculations nor saves their values.</p>
<ul>${views.map(view => `<li><a href="${base}/${encodeURIComponent(view.view_id)}">${e(view.name)}</a>${canSave ? `<form method="post" action="${base}/${encodeURIComponent(view.view_id)}/delete">${csrf(token)}<button type="submit">Delete saved filters</button></form>` : ""}</li>`).join("")}</ul>
${canSave ? `<section><h2>Save an analysis</h2><form method="post" action="${base}">${csrf(token)}${input("name", "View name", "", true)}
${fields.map(([key, label]) => input(key, label, params.get(key) ?? "", ["date_from", "date_to", "watermark_at_most"].includes(key))).join("")}
${[...(params.getAll("metric_name")), ""].map(value => input("metric_name", "Metric (blank selects standard D7 acquisition KPIs and D1/D3/D7/D14/D30 retention)", value)).join("")}
<label>Display <select name="display"><option value="all">All aligned observations</option><option value="exceptions">Incomparable observations only</option></select></label><button type="submit">Save filters</button></form></section>` : "<p>Operators and administrators can save or delete shared filters.</p>"}
<p>Dates are inclusive/exclusive, at most 366 days. The previous period has the same number of dates. Up to 100 views per app. Unsupported or mismatched meanings remain incomparable; no cross-app totals or ratio averages.</p>`);
}

function observations(values: readonly AnalysisObservation[]): string {
  if (!values.length) return "— (missing)";
  return values.map(value => `<div data-analysis-run-id="${e(value.run_id)}"${value.value_unscaled !== null ? ` data-value-unscaled="${e(value.value_unscaled)}"` : ""}>
${e(value.label)}<details><summary>Saved evidence</summary><p>Run ${e(value.run_id)}; input snapshot ${e(value.snapshot_id)}; receipt cutoff ${e(value.watermark)}; freshness ${e(value.freshness)}; source observation ${e(value.source_observation)}; import completion ${e(value.import_completion)}</p></details></div>`).join("");
}
function periodValue(side: AcquisitionPeriodSide, value: AcquisitionPeriodValue | null): string {
  return `<div${value?.value_unscaled !== null && value?.value_unscaled !== undefined ? ` data-value-unscaled="${e(value.value_unscaled)}"` : ""}>${e(value?.label ?? `— (${side.reason})`)}</div>`;
}
function periodEvidence(side: AcquisitionPeriodSide): string {
  return `<details><summary>Period ${e(side.date_from)}–${e(side.date_to)} (${side.observed_days}/${side.expected_days} dates)</summary><p>Exclusive end; ${e(side.state)}${side.reason ? `: ${e(side.reason)}` : ""}; selection digest ${e(side.selection_digest)}; meaning digest ${e(side.meaning_digest ?? "unverified")}</p><ul>${side.sources.map(source => `<li>${e(source.date)}; set keys ${e(source.set_keys.join(", "))}<ul>${source.runs.map(run => `<li>${e(run.role)}: run ${e(run.run_id)}; snapshot ${e(run.snapshot_id)}; receipt cutoff ${e(run.watermark)}; grouping digest ${e(run.grouping_digest)}</li>`).join("")}</ul></li>`).join("")}</ul></details>`;
}
export function renderPeriodAnalysis(appId: string, saved: SavedAnalysis, analysis: PeriodAnalysis): string {
  const base = `/dashboard/apps/${encodeURIComponent(appId)}/analyses`, params = new URLSearchParams({
    date_from: analysis.current_from, date_to: analysis.current_to, watermark_at_most: analysis.watermark_at_most });
  const shown = visibleAnalysisRows(analysis, saved.display);
  const summaries = acquisitionPeriodRows(analysis.summaries, saved.display);
  return shell(saved.name, `<p><a href="${base}">Saved analyses</a> · <a href="${base}/${encodeURIComponent(saved.view_id)}.csv?${e(params.toString())}">Export this selection as CSV</a></p>
<form method="get">${input("date_from", "From (inclusive)", analysis.current_from, true)}${input("date_to", "To (exclusive)", analysis.current_to, true)}${input("watermark_at_most", "Saved receipt cutoff at most", analysis.watermark_at_most, true)}<button type="submit">Read another period</button></form>
<p>Current ${e(analysis.current_from)}–${e(analysis.current_to)} versus previous ${e(analysis.previous_from)}–${e(analysis.previous_to)} (exclusive ends). All ${analysis.current_count} current and ${analysis.previous_count} previous saved runs were acquired in one privacy-fenced repeatable read. No page is omitted. Source completeness remains unknown.</p>
<p>Daily observations align by cohort-date or activity-date offset and identical non-date dimensions. Differences use the stored integer scale; ratio differences are not percentage growth. Daily active installations are not people, and daily distinct counts are never summed into period-unique users. Retention and re-engagement are not aggregated. A closed window does not prove all events arrived.</p>
<p>Showing ${shown.length} of ${analysis.rows.length} aligned entries (${e(saved.display)}). Selection digest: ${e(analysis.selection_digest)}. Each GET, including CSV, reads again; source changes can produce a new digest. This is not a durable report snapshot.</p>
<section><h2>Acquisition period summaries</h2><p>One complete, mature acquisition set per date within the same horizon and identical non-date dimensions is required. Integer operands are summed first; CPI is total cost / total installs, and ROAS is total revenue / total cost, using half-even rounding. Daily ratios are never averaged. Missing dates, duplicate sets, pending corrections or mixed meanings block a side. Different meanings between otherwise valid periods preserve both totals but block their comparison. Source completeness remains unknown.</p>
${summaries.length ? `<table><caption>Period totals and weighted acquisition ratios (not saved metric runs)</caption><thead><tr><th scope="col">Metric / dimensions</th><th scope="col">Current period</th><th scope="col">Previous period</th><th scope="col">Comparison</th><th scope="col">Unscaled current − previous</th></tr></thead><tbody>${summaries.map(row => `<tr data-analysis-summary-metric="${e(row.metric_name)}"><th scope="row">${e(row.metric_name)}<br>${e(JSON.stringify(row.summary.dimensions))}</th><td>${periodValue(row.summary.current, row.current)}</td><td>${periodValue(row.summary.previous, row.previous)}</td><td>${e(row.status)}${row.reason ? `: ${e(row.reason)}` : ""}</td><td>${row.delta_current_minus_previous === null ? "—" : e(row.delta_current_minus_previous)}</td></tr>`).join("")}</tbody></table>${[...new Set(summaries.map(row => row.summary))].map(summary => `<details><summary>Period source evidence: ${e(JSON.stringify(summary.dimensions))}</summary>${periodEvidence(summary.current)}${periodEvidence(summary.previous)}</details>`).join("")}` : "<p>No acquisition period summaries in this selection.</p>"}</section>
<table><caption>Saved daily observations, not aggregated period totals</caption><thead><tr><th scope="col">Metric / dimensions</th><th scope="col">Current date / value</th><th scope="col">Previous date / value</th><th scope="col">Comparison</th><th scope="col">Unscaled current − previous</th></tr></thead><tbody>${shown.map(row => `<tr><th scope="row">${e(row.metric_name)}<br>${e(JSON.stringify(row.dimensions))}</th><td>${e(row.current_date)}${observations(row.current)}</td><td>${e(row.previous_date)}${observations(row.previous)}</td><td>${e(row.status)}${row.reason ? `: ${e(row.reason)}` : ""}</td><td>${row.delta_current_minus_previous === null ? "—" : e(row.delta_current_minus_previous)}</td></tr>`).join("")}</tbody></table>`);
}
export const renderAnalysisError = (reason: string) => shell("Analysis unavailable", `<p>${e(reason)}</p><p>No partial result was published. Narrow the period or filters when a selection limit was exceeded.</p>`);
