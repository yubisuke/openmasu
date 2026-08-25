import { renderSparkline } from "./svg.js";
import type { DashboardView } from "./view.js";

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function grouping(value: Readonly<Record<string, string>>): string {
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en"));
  return entries.length ? entries.map(([key, item]) => `${key}=${item}`).join(", ") : "all";
}

function differences(view: DashboardView): string {
  if (view.differences.length === 0) return "<p>No stored difference-audit rows match this filter.</p>";
  return `<table><caption>Stored difference audit</caption><thead><tr><th scope="col">Reason</th><th scope="col">Input snapshot</th><th scope="col">External snapshot</th><th scope="col">Matching keys</th><th scope="col">Candidates</th><th scope="col">Exclusions</th><th scope="col">Windows</th><th scope="col">Joins</th><th scope="col">Freshness</th></tr></thead><tbody>${view.differences.map((row) => `<tr><td>${escapeHtml(row.difference_reason_code)}</td><td>${escapeHtml(row.input_snapshot_id)}</td><td>${escapeHtml(row.external_snapshot_id)}</td><td>${escapeHtml(JSON.stringify(row.matching_keys ?? []))}</td><td>${escapeHtml(JSON.stringify(row.candidates ?? []))}</td><td>${escapeHtml(JSON.stringify(row.exclusions ?? []))}</td><td>${escapeHtml(JSON.stringify(row.windows ?? []))}</td><td>${escapeHtml(JSON.stringify(row.joins ?? []))}</td><td>${escapeHtml(row.freshness)}</td></tr>`).join("")}</tbody></table>`;
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map(escapeHtml).join(", ");
}

function trackingLinks(view: DashboardView): string {
  if (!view.selectedAppId) return "";
  if (view.trackingLinks.length === 0) {
    return "<section><h2>Measurement links</h2><p>No measurement links are registered.</p></section>";
  }
  return `<section><h2>Measurement links</h2><table><caption>Registered measurement links</caption><thead><tr><th scope="col">Measurement URL</th><th scope="col">Destination</th><th scope="col">Network</th><th scope="col">Campaign</th><th scope="col">Status</th><th scope="col">Created at</th></tr></thead><tbody>${view.trackingLinks.map((link) => `<tr><th scope="row"><a href="${escapeHtml(link.measurement_url)}">${escapeHtml(link.measurement_url)}</a></th><td>${escapeHtml(link.destination_url)}</td><td>${escapeHtml(link.network ?? "—")}</td><td>${escapeHtml(link.campaign_id ?? "—")}</td><td>${escapeHtml(link.status)}</td><td>${escapeHtml(link.created_at)}</td></tr>`).join("")}</tbody></table></section>`;
}

function metricTable(caption: string, rows: DashboardView["rows"]): string {
  if (rows.length === 0) return "";
  return `<table><caption>${escapeHtml(caption)}</caption><thead><tr><th scope="col">Metric</th><th scope="col">Grouping</th><th scope="col">Value</th><th scope="col">Freshness</th><th scope="col">Computed at</th><th scope="col">Rule bundle</th><th scope="col">Reproducibility</th></tr></thead><tbody>${rows.map((row) => {
    const value = row.value_state === "undefined"
      ? `<span class="undefined-value">—</span><small>${escapeHtml(row.undefined_reason)}</small>`
      : `<span data-metric-run-id="${escapeHtml(row.metric_run_id)}" data-value-unscaled="${escapeHtml(row.value_unscaled)}">${escapeHtml(row.value_unscaled)}</span>`;
    return `<tr><th scope="row">${escapeHtml(row.metric_name)}</th><td>${escapeHtml(grouping(row.grouping))}</td><td>${value}</td><td>${escapeHtml(row.data_freshness)}</td><td>${escapeHtml(row.computed_at)}</td><td>${escapeHtml(row.rule_bundle_id)} / ${escapeHtml(row.metric_definition_version)}</td><td>${escapeHtml(row.reproducibility_status)}${row.superseded ? " (superseded)" : ""}</td></tr>`;
  }).join("")}</tbody></table>`;
}

function chartSection(label: string, charts: DashboardView["charts"]): string {
  if (charts.length === 0) return "";
  return `<section aria-label="${escapeHtml(label)}">${charts.map((chart) => `<figure>${renderSparkline(chart.series, { label: `${chart.metric_name} trend` })}<figcaption>${escapeHtml(chart.metric_name)}</figcaption></figure>`).join("")}</section>`;
}

export function renderDashboard(view: DashboardView): string {
  const selected = view.selectedAppId;
  const appNavigation = view.apps.length
    ? `<nav aria-label="Applications"><ul>${view.apps.map((app) => `<li><a href="/dashboard/apps/${encodeURIComponent(app.app_id)}">${escapeHtml(app.app_id)}</a></li>`).join("")}</ul></nav>`
    : "<p>No applications are registered.</p>";
  const empty = selected && view.rows.length === 0
    ? "<p>No data yet; run <code>npm run seed</code>.</p>"
    : "";
  const deterministicMetrics = metricTable("Deterministic cohort metrics", view.deterministicRows);
  const appleAggregateMetrics = metricTable("Apple aggregate postback metrics", view.appleAggregateRows);
  const recordRows = view.records.length === 0 ? "" : `<table><caption>Aggregate record counts at the fixed watermark</caption><thead><tr><th scope="col">Metric</th><th scope="col">Grouping</th><th scope="col">Count</th></tr></thead><tbody>${view.records.map((row) => `<tr><th scope="row">${escapeHtml(row.metric_name)}</th><td>${escapeHtml(grouping(row.grouping))}</td><td>${escapeHtml(row.count)}</td></tr>`).join("")}</tbody></table>`;
  const deterministicCharts = chartSection("Deterministic metric charts", view.deterministicCharts);
  const appleAggregateCharts = chartSection("Apple aggregate postback charts", view.appleAggregateCharts);
  const exportLink = selected ? `<p><a href="/dashboard/apps/${encodeURIComponent(selected)}/cohorts.csv${view.query?.watermarkAtMost ? `?watermark_at_most=${encodeURIComponent(view.query.watermarkAtMost)}&export=true` : "?export=true"}">Export aggregate CSV</a></p>` : "";
  const reportNavigation = selected
    ? `<nav aria-label="Report views"><a href="/dashboard/apps/${encodeURIComponent(selected)}">Cohorts and activity</a> <a href="/dashboard/apps/${encodeURIComponent(selected)}/differences">Stored difference audit</a> <a href="/dashboard/apps/${encodeURIComponent(selected)}/tracking-links">Measurement links</a></nav>`
    : "";
  const metadata = selected ? `<section aria-label="Report metadata"><h3>Report metadata</h3><dl><dt>Fixed watermark</dt><dd>${escapeHtml(view.metadata.watermark ?? "not selected")}</dd><dt>Snapshot IDs</dt><dd>${list(view.metadata.snapshotIds)}</dd><dt>Aggregation time zones</dt><dd>${list(view.metadata.aggregationTimeZones)}</dd><dt>Metric definition versions</dt><dd>${list(view.metadata.metricDefinitionVersions)}</dd><dt>Rule bundles</dt><dd>${list(view.metadata.ruleBundles)}</dd><dt>Policy versions</dt><dd>${list(view.metadata.policyVersions)}</dd><dt>Freshness</dt><dd>${list(view.metadata.freshnessStates)}</dd></dl></section>` : "";
  const createApp = `<section><h2>Register an app</h2><form method="post" action="/dashboard/apps"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><label>App ID <input name="app_id" required pattern="[A-Za-z0-9._:-]{1,128}"></label><button type="submit">Register app and issue SDK key</button></form></section>`;
  const createTrackingLink = selected
    ? `<section><h2>Create a tracking link</h2><form method="post" action="/dashboard/apps/${encodeURIComponent(selected)}/tracking-links"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><label>Destination kind <select name="destination_kind"><option value="play_store">Play Store</option><option value="custom_https">Custom HTTPS</option></select></label><label>Destination URL <input type="url" name="destination_url" required></label><label>Play package name <input name="play_package_name"></label><label>Network <input name="network"></label><label>Campaign ID <input name="campaign_id"></label><button type="submit">Create tracking link</button></form></section>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenMasu dashboard</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><header><h1>OpenMasu dashboard</h1><p>${view.undefinedCount} undefined value${view.undefinedCount === 1 ? "" : "s"} on this page.</p></header><main>${appNavigation}${selected ? `<h2>${escapeHtml(selected)}</h2>` : "<h2>Applications</h2>"}${reportNavigation}${metadata}${empty}${exportLink}${deterministicMetrics}${appleAggregateMetrics}${recordRows}${deterministicCharts}${appleAggregateCharts}${selected ? differences(view) : ""}${trackingLinks(view)}${createTrackingLink}${createApp}<form method="post" action="/dashboard/session/delete"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><button type="submit">Sign out</button></form></main></body></html>`;
}
