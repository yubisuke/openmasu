import { escapeHtml as e } from "./html.js";
import type { readComparisons } from "@openmasu/runtime/recurring-comparisons";
import { jcs } from "@openmasu/attribution-core/canonical";
import type { ComparisonFormPreview } from "../recurring-comparison-form.js";

const input = (name: string, label: string, type = "text", attributes = "") => `<label>${e(label)} <input name="${e(name)}" type="${type}" ${attributes} required></label>`;
const file = (name: string, label: string) => input(name, label, "file", 'accept=".json,application/json"');
function forms(base: string, token: string, saved: Awaited<ReturnType<typeof readComparisons>>) {
  const start = `<form method="post" enctype="multipart/form-data" action="${base}/comparisons/preview"><input type="hidden" name="csrf_token" value="${e(token)}">`;
  const active = saved.plans.filter(row => row.active && row.privacy_state === "current");
  const options = (plans: typeof active) => plans.map(row => `<option value="${e(row.comparison_id)}">${e(row.name)} · ${e(row.comparison_id)}</option>`).join("");
  return `<h2>Register or replace a comparison</h2><p>Select two aggregate snapshot JSON files exported by Reports or the one-off comparison workflow. No command JSON is needed. Uploads are operator-supplied; hashes do not prove provider authenticity. Initial files must cover the first date and its fixed cutoff.</p>
${start}<input type="hidden" name="action" value="register">
${input("name", "Name", "text", 'maxlength="80"')}${input("first_date", "First UTC target date (inclusive)", "date")}${input("last_date", "Last UTC target date (inclusive)", "date")}
${input("watermark_lag_days", "Cutoff lag in days (1–366)", "number", 'min="1" max="366" value="9"')}${input("retention_days", "Retain stored input/result values (days)", "number", 'min="1" max="90" value="30"')}
<label>Evidence mode <select name="mode"><option value="captured">Captured definition evidence</option><option value="external_declared">Explicit external declaration</option><option value="declared_only">Declaration only (no threshold decision)</option></select></label>
${input("threshold_value_unscaled", "Absolute difference threshold: integer", "text", 'pattern="(0|[1-9][0-9]{0,99})" value="300000"')}${input("threshold_scale", "Threshold decimal scale (300000 at scale 6 = 0.30)", "number", 'min="0" max="18" value="6"')}
<label>Replace revision <select name="supersedes_id"><option value="">Create a new comparison</option>${options(active)}</select></label>
${file("left_snapshot", "Left initial aggregate snapshot")}${file("right_snapshot", "Right initial aggregate snapshot")}<button type="submit">Review definition and evidence</button></form>
<h2>Use saved server runs for the left operand</h2><p>Select one active metric schedule and one of its metrics. The schedule must have exactly one matching evaluation. The first date must already have complete, mature saved runs at the chosen cutoff. Review reads them without saving; confirmation rechecks their digest. Later dates are captured by the worker. The right operand remains an operator upload.</p>
${start}<input type="hidden" name="action" value="register_local">
${input("name", "Name", "text", 'maxlength="80"')}${input("first_date", "First UTC target date (inclusive)", "date")}${input("last_date", "Last UTC target date (inclusive)", "date")}
${input("watermark_lag_days", "Cutoff lag in days (1–366)", "number", 'min="1" max="366" value="9"')}${input("retention_days", "Retain stored input/result values (days)", "number", 'min="1" max="90" value="30"')}
<label>Evidence mode <select name="mode"><option value="captured">Captured definition evidence</option><option value="external_declared">Explicit external declaration</option><option value="declared_only">Declaration only (no threshold decision)</option></select></label>
${input("threshold_value_unscaled", "Absolute difference threshold: integer", "text", 'pattern="(0|[1-9][0-9]{0,99})" value="300000"')}${input("threshold_scale", "Threshold decimal scale (300000 at scale 6 = 0.30)", "number", 'min="0" max="18" value="6"')}
<label>Replace revision <select name="supersedes_id"><option value="">Create a new comparison</option>${options(active)}</select></label>
${input("metric_schedule_id", "Saved metric schedule ID")}${input("metric_name", "Metric name", "text", 'pattern="[a-z][a-z0-9_]{2,127}"')}
${file("right_snapshot", "Right initial aggregate snapshot")}<button type="submit">Review server selection and evidence</button></form>
<h2>Deposit a dated operand</h2><p>Choose an active revision and one side. The worker uses the same immutable date/cutoff and definition checks; changed content at an already stored side conflicts.</p>
${start}<input type="hidden" name="action" value="deposit"><label>Active revision <select name="comparison_id" required>${options(active)}</select></label>
${input("target_date", "UTC target date", "date")}<label>Side <select name="side"><option value="left">Left</option><option value="right">Right</option></select></label>
${file("snapshot", "Aggregate snapshot")}<button type="submit">Review deposit</button></form>
<h2>Delete stored comparison values</h2><p>Delete removes stored aggregate inputs and results, retaining revision metadata. Replacing a definition does not delete old results.</p>
${start}<input type="hidden" name="action" value="delete"><label>Revision <select name="comparison_id" required>${options(saved.plans)}</select></label><button type="submit">Review deletion</button></form>`;
}

export function renderComparisonFormPreview(appId: string, token: string, preview: ComparisonFormPreview): string {
  const base = `/dashboard/apps/${encodeURIComponent(appId)}/comparisons`;
  const command = jcs(preview.command);
  const registration = preview.action === "register" ? preview.command.registration as Record<string, unknown> : undefined;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Review scheduled comparison · OpenMasu</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main>
<h1>Review scheduled comparison</h1><p><a href="${base}">Back without saving</a></p><h2>${e(preview.name)}</h2>
<p>Action: ${e(preview.action)}. Preview state: <strong>${e(preview.resultState)}</strong>. No revision, input or result has been stored. This is not a provider connection, completeness assertion or verified authenticity.</p>
${registration ? `<h3>Schedule and threshold</h3><dl>${Object.entries(registration).filter(([key]) => !key.endsWith("snapshot")).map(([key, value]) => `<dt>${e(key)}</dt><dd>${e(value === null ? "New revision" : typeof value === "object" ? JSON.stringify(value) : String(value))}</dd>`).join("")}</dl>` : ""}
${preview.snapshots.map(({ side, snapshot, meaning, maturity, source }) => `<section><h3>${e(side)} evidence</h3><p>Storage source: ${e(source ?? "operator_uploaded")}. Meaning: ${e(meaning)}; maturity: ${e(maturity)}; rows: ${snapshot.rows.length}. Captured definition evidence binds supplied contents; it does not authenticate their origin.</p><dl>${Object.entries(snapshot.conditions).map(([key, value]) => `<dt>${e(key)}</dt><dd>${e(value)}</dd>`).join("")}<dt>Units and scales</dt><dd>${e([...new Set(snapshot.rows.map(row => `${row.currency || "unitless"} / scale ${row.scale}`))].slice(0, 20).join(", "))}</dd></dl></section>`).join("")}
<p>Confirming revalidates the same command with current app permissions, privacy state, revision availability and storage limits. A preview is not a reservation. Incomparable or immature evidence stays incomparable; it is never converted into zero.</p>
<form method="post" enctype="multipart/form-data" action="${base}"><input type="hidden" name="csrf_token" value="${e(token)}"><input type="hidden" name="command" value="${e(command)}"><input type="hidden" name="confirmation_digest" value="${e(preview.digest)}"><button type="submit">${preview.action === "delete" ? "Confirm deletion" : "Confirm and save"}</button></form></main></body></html>`;
}

export function renderRecurringComparisons(appId: string, saved: Awaited<ReturnType<typeof readComparisons>>, token: string, canOperate: boolean, error?: string): string {
  const base = `/dashboard/apps/${encodeURIComponent(appId)}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Scheduled comparisons · OpenMasu</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main>
<h1>Scheduled aggregate comparisons</h1><p><a href="${base}">Reports</a> · <a href="${base}/comparison">One-off comparison</a></p>
<p>The worker compares aggregate snapshots at a fixed cutoff per UTC date. A selected local schedule captures its left operand directly from saved server runs; manual operands remain operator uploads. External inputs are operator supplied; no provider is contacted and no notification is sent. Missing, unknown and incomparable are not threshold breaches.</p>
${error ? `<p role="alert">${e(error)}</p>` : ""}
<h2>Definition revisions</h2><table><thead><tr><th scope="col">Name / revision</th><th scope="col">State</th><th scope="col">Definition digest</th><th scope="col">Retention</th><th scope="col">Left input</th></tr></thead><tbody>${saved.plans.map(plan => `<tr id="comparison-${e(plan.comparison_id)}"><td>${e(plan.name)}<br>${e(plan.comparison_id)}</td><td>${e(plan.privacy_state === "suppressed" ? "privacy suppressed" : plan.active ? "active" : "replaced / inactive")}</td><td>${e(plan.definition_digest)}</td><td>${e(plan.definition.retention_days)} days</td><td>${e(plan.definition.local_selection ? `Saved schedule ${plan.definition.local_selection.metric_schedule_id} / ${plan.definition.local_selection.metric_name}` : "Operator upload")}</td></tr>`).join("")}</tbody></table>
<h2>Recent results</h2><p>At most 200 recent result summaries. Downloaded JSON preserves the stored comparison; the page does not recalculate it.</p><table><thead><tr><th scope="col">UTC target date</th><th scope="col">Revision</th><th scope="col">Result</th></tr></thead><tbody>${saved.runs.map(run => `<tr><td>${e(run.target_date)}</td><td>${e(run.comparison_id)}</td><td><a href="${base}/comparison-runs/${encodeURIComponent(run.run_id)}.json">${e(run.state)}</a></td></tr>`).join("")}</tbody></table>
${canOperate ? forms(base, token, saved) : "<p>Only operators and administrators can store or delete comparisons.</p>"}
<p>Inputs: at most 10,000 aggregate rows / 4 MiB per snapshot. Twenty active definitions per tenant, a 366-date horizon, explicit 1–90 day retention and a 64 MiB aggregate-storage budget per app. Raw CSV files, row-level events and identifying grouping dimensions are not stored.</p>
</main></body></html>`;
}
