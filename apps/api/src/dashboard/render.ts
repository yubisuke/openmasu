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

function continuationHref(view: DashboardView, suffix: string, cursor: string): string | undefined {
  if (!view.selectedAppId || !view.query) return undefined;
  const params = new URLSearchParams();
  for (const metricName of view.query.metricNames ?? []) params.append("metric_name", metricName);
  if (view.query.metricDefinitionVersion) params.set("metric_definition_version", view.query.metricDefinitionVersion);
  for (const [dimension, value] of Object.entries(view.query.grouping ?? {})) {
    params.set(`grouping_${dimension}`, value);
  }
  if (view.query.dateFrom) params.set("date_from", view.query.dateFrom);
  if (view.query.dateTo) params.set("date_to", view.query.dateTo);
  if (view.query.watermarkAtMost) params.set("watermark_at_most", view.query.watermarkAtMost);
  if (view.query.differenceReasonCode) params.set("difference_reason_code", view.query.differenceReasonCode);
  params.set("supersession", view.query.supersession);
  params.set("limit", String(view.query.limit));
  params.set("after", cursor);
  return `/dashboard/apps/${encodeURIComponent(view.selectedAppId)}${suffix}?${params.toString()}`;
}

function continuation(view: DashboardView, suffix: string, cursor: string | undefined, label: string): string {
  if (!cursor) return "";
  const href = continuationHref(view, suffix, cursor);
  return href
    ? `<p class="pagination"><a rel="next" href="${escapeHtml(href)}">${escapeHtml(label)}</a></p>`
    : `<p class="pagination">${escapeHtml(label)} is available through the paginated API.</p>`;
}

function differences(view: DashboardView): string {
  if (view.differences.length === 0) return "<p>No stored difference-audit rows match this filter.</p>";
  return `<table><caption>Stored difference audit</caption><thead><tr><th scope="col">Reason</th><th scope="col">Input snapshot</th><th scope="col">External snapshot</th><th scope="col">Matching keys</th><th scope="col">Candidates</th><th scope="col">Exclusions</th><th scope="col">Windows</th><th scope="col">Joins</th><th scope="col">Freshness</th></tr></thead><tbody>${view.differences.map((row) => `<tr><td>${escapeHtml(row.difference_reason_code)}</td><td>${escapeHtml(row.input_snapshot_id)}</td><td>${escapeHtml(row.external_snapshot_id)}</td><td>${escapeHtml(JSON.stringify(row.matching_keys ?? []))}</td><td>${escapeHtml(JSON.stringify(row.candidates ?? []))}</td><td>${escapeHtml(JSON.stringify(row.exclusions ?? []))}</td><td>${escapeHtml(JSON.stringify(row.windows ?? []))}</td><td>${escapeHtml(JSON.stringify(row.joins ?? []))}</td><td>${escapeHtml(row.freshness)}</td></tr>`).join("")}</tbody></table>${continuation(view, "/differences", view.differenceNextCursor, "Next difference-audit page")}`;
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.map(escapeHtml).join(", ");
}

function trackingLinks(view: DashboardView): string {
  if (!view.selectedAppId) return "";
  if (view.trackingLinks.length === 0) {
    return "<section><h2>Measurement links</h2><p>No measurement links are registered.</p></section>";
  }
  return `<section><h2>Measurement links</h2><table><caption>Registered measurement links</caption><thead><tr><th scope="col">Measurement URL</th><th scope="col">Destination</th><th scope="col">Network</th><th scope="col">Campaign</th><th scope="col">Status</th><th scope="col">Created at</th><th scope="col">Lifecycle</th></tr></thead><tbody>${view.trackingLinks.map((link) => {
    const base = `/dashboard/apps/${encodeURIComponent(view.selectedAppId!)}/tracking-links/${encodeURIComponent(link.tracking_link_id)}`;
    const actions = !view.canOperate || link.status === "archived" ? "—" : [
      link.status === "active" ? `<form method="post" action="${base}/pause"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><button type="submit">Pause</button></form>` : "",
      `<form method="post" action="${base}/archive"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><button type="submit">Archive</button></form>`,
    ].join("");
    return `<tr><th scope="row"><a href="${escapeHtml(link.measurement_url)}">${escapeHtml(link.measurement_url)}</a></th><td>${escapeHtml(link.destination_url)}</td><td>${escapeHtml(link.network ?? "—")}</td><td>${escapeHtml(link.campaign_id ?? "—")}</td><td>${escapeHtml(link.status)}</td><td>${escapeHtml(link.created_at)}</td><td>${actions}</td></tr>`;
  }).join("")}</tbody></table><p>Allowed transitions: active to paused or archived; paused to archived; archived is terminal.</p></section>`;
}

function sdkKeys(view: DashboardView): string {
  if (!view.selectedAppId || !view.canAdminister) return "";
  const rows = view.sdkKeys.length === 0 ? "<p>No SDK keys are registered.</p>" : `<table><caption>SDK key metadata (secrets are never listed)</caption><thead><tr><th scope="col">Key ID</th><th scope="col">Platform</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Lifecycle</th></tr></thead><tbody>${view.sdkKeys.map((key) => `<tr><th scope="row">${escapeHtml(key.sdk_key_id)}</th><td>${escapeHtml(key.platform)}</td><td>${escapeHtml(key.status)}</td><td>${escapeHtml(key.created_at)}</td><td>${key.status === "active" ? `<form method="post" action="/dashboard/apps/${encodeURIComponent(view.selectedAppId!)}/sdk-keys/${encodeURIComponent(key.sdk_key_id)}/retire"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><button type="submit">Retire</button></form>` : "—"}</td></tr>`).join("")}</tbody></table>`;
  return `<section><h2>SDK keys</h2>${rows}<p>At most two active keys are allowed during rotation. The last active key cannot be retired.</p><form method="post" action="/dashboard/apps/${encodeURIComponent(view.selectedAppId)}/sdk-keys"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><label>Platform <select name="platform"><option value="android">Android</option><option value="ios">iOS</option></select></label><button type="submit">Issue successor key</button></form></section>`;
}

function serverKeys(view: DashboardView): string {
  if (!view.selectedAppId || !view.canAdminister) return "";
  const app = encodeURIComponent(view.selectedAppId);
  const rows = view.serverKeys.length === 0
    ? "<p>No server keys are registered.</p>"
    : `<table><caption>Server key metadata (secrets are never listed)</caption><thead><tr><th scope="col">Key ID</th><th scope="col">Producer</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Lifecycle</th></tr></thead><tbody>${view.serverKeys.map((key) => `<tr><th scope="row">${escapeHtml(key.server_key_id)}</th><td>${escapeHtml(key.producer)}</td><td>${escapeHtml(key.status)}</td><td>${escapeHtml(key.created_at)}</td><td>${key.status === "active" ? `<form method="post" action="/dashboard/apps/${app}/server-keys/${encodeURIComponent(key.server_key_id)}/retire"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><button type="submit">Retire</button></form>` : "—"}</td></tr>`).join("")}</tbody></table>`;
  return `<section><h2>Server-to-server keys</h2>${rows}<p>Each key has an immutable producer. At most two active keys per producer are allowed during rotation, and the last active key cannot be retired.</p><form method="post" action="/dashboard/apps/${app}/server-keys"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><label>Producer <input name="producer" value="postback:first-party" required pattern="postback:[a-z0-9-]+"></label><button type="submit">Issue successor key</button></form></section>`;
}

function operatorWebhooks(view: DashboardView): string {
  if (!view.selectedAppId || !view.canAdminister) return "";
  const app = encodeURIComponent(view.selectedAppId);
  const rows = view.operatorWebhooks.length === 0
    ? "<p>No operator webhooks are registered.</p>"
    : `<table><caption>Operator webhook metadata (signing secrets are never listed)</caption><thead><tr><th scope="col">Destination ID</th><th scope="col">Endpoint</th><th scope="col">Events</th><th scope="col">Status</th><th scope="col">Created</th><th scope="col">Lifecycle</th></tr></thead><tbody>${view.operatorWebhooks.map((destination) => `<tr><th scope="row">${escapeHtml(destination.destination_id)}</th><td>${escapeHtml(destination.endpoint_url)}</td><td>${escapeHtml(destination.events.join(", "))}</td><td>${escapeHtml(destination.status)}</td><td>${escapeHtml(destination.created_at)}</td><td>${destination.status === "active" ? `<form method="post" action="/dashboard/apps/${app}/operator-webhooks/${encodeURIComponent(destination.destination_id)}/disable"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><button type="submit">Disable</button></form>` : "—"}</td></tr>`).join("")}</tbody></table>`;
  const csrf = `<input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}">`;
  return `<section><h2>Operator event webhooks</h2>${rows}<p>Only selected accepted first-party down-funnel events are eligible. The signing secret is shown once, and disabled destinations cannot be re-enabled.</p><form method="post" action="/dashboard/apps/${app}/operator-webhooks">${csrf}<label>HTTPS endpoint <input type="url" name="endpoint_url" required></label><fieldset><legend>Events</legend><label><input type="checkbox" name="events" value="session_start"> Session start</label><label><input type="checkbox" name="events" value="custom_event"> Custom event</label><label><input type="checkbox" name="events" value="purchase"> Purchase</label><label><input type="checkbox" name="events" value="refund"> Refund</label><label><input type="checkbox" name="events" value="ad_revenue"> Ad revenue</label></fieldset><button type="submit">Register webhook</button></form></section>`;
}

function operatorBulkExports(view: DashboardView): string {
  if (!view.selectedAppId || !view.canAdminister) return "";
  const app = encodeURIComponent(view.selectedAppId);
  const rows = view.operatorBulkExports.length === 0
    ? "<p>No operator bulk exports are registered.</p>"
    : `<table><caption>Operator-owned S3-compatible export destinations (credentials are never listed)</caption><thead><tr><th scope="col">Destination ID</th><th scope="col">Endpoint</th><th scope="col">Bucket / prefix</th><th scope="col">Events</th><th scope="col">Start</th><th scope="col">Status</th><th scope="col">Lifecycle</th></tr></thead><tbody>${view.operatorBulkExports.map((destination) => `<tr><th scope="row">${escapeHtml(destination.destination_id)}</th><td>${escapeHtml(destination.endpoint_url)}</td><td>${escapeHtml(`${destination.bucket_name}/${destination.object_prefix}`)}</td><td>${escapeHtml(destination.events.join(", "))}</td><td>${escapeHtml(destination.start_at)}</td><td>${escapeHtml(destination.status)}</td><td>${destination.status === "active" ? `<form method="post" action="/dashboard/apps/${app}/operator-bulk-exports/${encodeURIComponent(destination.destination_id)}/disable"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><button type="submit">Disable</button></form>` : "—"}</td></tr>`).join("")}</tbody></table>`;
  const csrf = `<input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}">`;
  return `<section><h2>Operator bulk event exports</h2>${rows}<p>Exports are deterministic gzip NDJSON objects. Use a dedicated, least-privilege S3-compatible credential. Secrets are encrypted and never displayed after submission.</p><form method="post" action="/dashboard/apps/${app}/operator-bulk-exports">${csrf}<label>S3-compatible HTTPS origin <input type="url" name="endpoint_url" required placeholder="https://account.r2.cloudflarestorage.com"></label><label>Bucket <input name="bucket_name" required></label><label>Object prefix <input name="object_prefix" placeholder="openmasu/events"></label><label>Region <input name="region" value="auto" required></label><label>Start at (canonical UTC) <input name="start_at" required placeholder="2026-08-30T00:00:00.000Z"></label><label>Access key ID <input name="access_key_id" required autocomplete="off"></label><label>Secret access key <input type="password" name="secret_access_key" required autocomplete="new-password"></label><label>Session token (optional) <input type="password" name="session_token" autocomplete="new-password"></label><fieldset><legend>Events</legend><label><input type="checkbox" name="events" value="session_start"> Session start</label><label><input type="checkbox" name="events" value="custom_event"> Custom event</label><label><input type="checkbox" name="events" value="purchase"> Purchase</label><label><input type="checkbox" name="events" value="refund"> Refund</label><label><input type="checkbox" name="events" value="ad_revenue"> Ad revenue</label></fieldset><button type="submit">Register bulk export</button></form></section>`;
}

function configurationForms(view: DashboardView): string {
  if (!view.selectedAppId || !view.canAdminister) return "";
  const app = encodeURIComponent(view.selectedAppId);
  const csrf = `<input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}">`;
  return `<section><h2>App configuration</h2><p>Each submission is validated by the same service used by the admin API.</p>
  <h3>App link identity</h3><form method="post" action="/dashboard/apps/${app}/link-identity">${csrf}<label>Android package <input name="android_package_name"></label><label>Android SHA-256 fingerprints (comma-separated) <input name="android_sha256_fingerprints"></label><label>Apple team ID <input name="apple_team_id"></label><label>Apple bundle ID <input name="apple_bundle_id"></label><button type="submit">Register link identity</button></form>
  <h3>Apple app</h3><form method="post" action="/dashboard/apps/${app}/apple-registration">${csrf}<label>Apple app Adam ID <input name="apple_app_adam_id" required inputmode="numeric"></label><label>Apple bundle ID <input name="apple_bundle_id"></label><button type="submit">Register Apple app</button></form>
  <h3>Conversion schema</h3><form method="post" action="/dashboard/apps/${app}/conversion-schemas">${csrf}<label>Schema version <input name="schema_version" required placeholder="1.0.0"></label><label>Definition JSON <textarea name="definition_json" required></textarea></label><button type="submit">Register conversion schema</button></form>
  <h3>Fraud rule bundle</h3><form method="post" action="/dashboard/apps/${app}/rule-bundles">${csrf}<label>Complete activation request JSON <textarea name="definition_json" required></textarea></label><button type="submit">Activate rule bundle</button></form>
  <h3>Google Data Manager</h3><form method="post" action="/dashboard/apps/${app}/google-data-manager">${csrf}<label>Operating account ID <input name="operating_account_id" required inputmode="numeric"></label><label>Conversion action ID <input name="conversion_action_id" required inputmode="numeric"></label><label>App audience <select name="app_audience"><option value="general">General</option><option value="mixed">Mixed</option><option value="child_directed">Child directed</option></select></label><label>Enabled <select name="enabled"><option value="false">No</option><option value="true">Yes</option></select></label><button type="submit">Save destination</button></form></section>`;
}

function fraudAudit(view: DashboardView): string {
  if (view.fraudRows.length === 0) return "";
  return `<section><h2>Fraud audit</h2><table><caption>Source-day fraud evidence</caption><thead><tr><th scope="col">Date</th><th scope="col">Campaign</th><th scope="col">Network</th><th scope="col">Site</th><th scope="col">Remote references</th><th scope="col">Clicks</th><th scope="col">Installs</th><th scope="col">Suspected</th><th scope="col">Confirmed</th><th scope="col">Excluded</th><th scope="col">Quarantined</th></tr></thead><tbody>${view.fraudRows.map((row) => `<tr><td>${escapeHtml(row.metric_date)}</td><td>${escapeHtml(row.campaign_id)}</td><td>${escapeHtml(row.network)}</td><td>${escapeHtml(row.site_id)}</td><td>${escapeHtml(row.remote_click_refs.join(", "))}</td><td>${escapeHtml(row.clicks)}</td><td>${escapeHtml(row.installs)}</td><td>${escapeHtml(row.suspected)}</td><td>${escapeHtml(row.confirmed)}</td><td>${escapeHtml(row.excluded)}</td><td>${escapeHtml(row.quarantined)}</td></tr>`).join("")}</tbody></table></section>`;
}

function googleDeliveryHealthSection(view: DashboardView): string {
  const health = view.googleDeliveryHealth;
  if (!view.selectedAppId || !health) return "";
  const destination = health.destination.configured
    ? `${health.destination.enabled ? "enabled" : "disabled"}; next request ${health.destination.next_request_at ?? "not scheduled"}`
    : "not configured";
  const states = Object.entries(health.summary.by_state)
    .map(([state, count]) => `<dt>${escapeHtml(state)}</dt><dd>${escapeHtml(count)}</dd>`)
    .join("");
  const rows = health.deliveries.length === 0
    ? "<p>No Google conversion deliveries are recorded.</p>"
    : `<table><caption>Most recently updated Google conversion deliveries (maximum ${escapeHtml(health.maximum_rows)})</caption><thead><tr><th scope="col">Delivery</th><th scope="col">State</th><th scope="col">Attempts</th><th scope="col">Next activity</th><th scope="col">Diagnostics deadline</th><th scope="col">Reason</th><th scope="col">Updated</th></tr></thead><tbody>${health.deliveries.map((delivery) => `<tr><th scope="row">${escapeHtml(delivery.delivery_id)}</th><td>${escapeHtml(delivery.state)}</td><td>${escapeHtml(delivery.attempts)}</td><td>${escapeHtml(delivery.next_attempt_at)}</td><td>${escapeHtml(delivery.diagnostics_deadline_at ?? "—")}</td><td>${escapeHtml(delivery.safe_reason ?? "—")}</td><td>${escapeHtml(delivery.updated_at)}</td></tr>`).join("")}</tbody></table>`;
  return `<section><h2>Google Data Manager delivery health</h2><p>Destination: ${escapeHtml(destination)}. This is OpenMasu operational state, not provider-side exactly-once proof.</p><dl><dt>Total</dt><dd>${escapeHtml(health.summary.total)}</dd><dt>Due now</dt><dd>${escapeHtml(health.summary.due_now)}</dd><dt>Scheduled</dt><dd>${escapeHtml(health.summary.scheduled)}</dd>${states}</dl>${rows}</section>`;
}

function operatorDeliveryHealthSection(view: DashboardView): string {
  const health = view.operatorDeliveryHealth;
  if (!view.selectedAppId || !health) return "";
  const summary = (label: string, value: typeof health.webhooks.summary) => {
    const states = Object.entries(value.by_state)
      .map(([state, count]) => `<dt>${escapeHtml(state)}</dt><dd>${escapeHtml(count)}</dd>`)
      .join("");
    return `<h3>${escapeHtml(label)}</h3><dl><dt>Total</dt><dd>${escapeHtml(value.total)}</dd><dt>Due now</dt><dd>${escapeHtml(value.due_now)}</dd><dt>Scheduled</dt><dd>${escapeHtml(value.scheduled)}</dd>${states}</dl>`;
  };
  const webhookRows = health.webhooks.deliveries.length === 0
    ? "<p>No operator webhook deliveries are recorded.</p>"
    : `<table><caption>Most recently updated webhook deliveries</caption><thead><tr><th scope="col">Delivery</th><th scope="col">Destination</th><th scope="col">Event</th><th scope="col">State</th><th scope="col">Attempts</th><th scope="col">HTTP</th><th scope="col">Next activity</th><th scope="col">Reason</th><th scope="col">Updated</th></tr></thead><tbody>${health.webhooks.deliveries.map((delivery) => `<tr><th scope="row">${escapeHtml(delivery.delivery_id)}</th><td>${escapeHtml(delivery.destination_id)}</td><td>${escapeHtml(delivery.event_name)}</td><td>${escapeHtml(delivery.state)}</td><td>${escapeHtml(delivery.attempts)}</td><td>${escapeHtml(delivery.last_http_status ?? "—")}</td><td>${escapeHtml(delivery.next_attempt_at)}</td><td>${escapeHtml(delivery.safe_reason ?? "—")}</td><td>${escapeHtml(delivery.updated_at)}</td></tr>`).join("")}</tbody></table>`;
  const bulkRows = health.bulk_exports.batches.length === 0
    ? "<p>No operator bulk-export batches are recorded.</p>"
    : `<table><caption>Most recently updated bulk-export batches</caption><thead><tr><th scope="col">Batch</th><th scope="col">Destination</th><th scope="col">Rows</th><th scope="col">State</th><th scope="col">Attempts</th><th scope="col">HTTP</th><th scope="col">Next activity</th><th scope="col">Reason</th><th scope="col">Updated</th></tr></thead><tbody>${health.bulk_exports.batches.map((batch) => `<tr><th scope="row">${escapeHtml(batch.batch_id)}</th><td>${escapeHtml(batch.destination_id)}</td><td>${escapeHtml(batch.row_count)}</td><td>${escapeHtml(batch.state)}</td><td>${escapeHtml(batch.attempts)}</td><td>${escapeHtml(batch.last_http_status ?? "—")}</td><td>${escapeHtml(batch.next_attempt_at)}</td><td>${escapeHtml(batch.safe_reason ?? "—")}</td><td>${escapeHtml(batch.updated_at)}</td></tr>`).join("")}</tbody></table>`;
  return `<section><h2>Operator delivery health</h2><p>Operational state is bounded to the most recent ${escapeHtml(health.maximum_rows_per_channel)} rows per channel. Credentials, payload references, object paths, record identifiers, digests, and stored payload details are never displayed.</p>${summary("Event webhooks", health.webhooks.summary)}${webhookRows}${summary("Bulk event exports", health.bulk_exports.summary)}${bulkRows}</section>`;
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
  const empty = selected && view.rows.length === 0 && view.records.length === 0 && view.differences.length === 0
    ? "<p>No report data match this view.</p>"
    : "";
  const deterministicMetrics = metricTable("Deterministic cohort metrics", view.deterministicRows);
  const appleAggregateMetrics = metricTable("Apple aggregate postback metrics", view.appleAggregateRows);
  const recordRows = view.records.length === 0 ? "" : `<table><caption>Aggregate record counts at the fixed watermark</caption><thead><tr><th scope="col">Metric</th><th scope="col">Grouping</th><th scope="col">Count</th></tr></thead><tbody>${view.records.map((row) => `<tr><th scope="row">${escapeHtml(row.metric_name)}</th><td>${escapeHtml(grouping(row.grouping))}</td><td>${escapeHtml(row.count)}</td></tr>`).join("")}</tbody></table>${continuation(view, "/records", view.recordNextCursor, "Next aggregate-record page")}`;
  const deterministicCharts = chartSection("Deterministic metric charts", view.deterministicCharts);
  const appleAggregateCharts = chartSection("Apple aggregate postback charts", view.appleAggregateCharts);
  const exportLink = selected ? `<p><a href="/dashboard/apps/${encodeURIComponent(selected)}/cohorts.csv${view.query?.watermarkAtMost ? `?watermark_at_most=${encodeURIComponent(view.query.watermarkAtMost)}&export=true` : "?export=true"}">Export aggregate CSV</a></p>` : "";
  const reportNavigation = selected
    ? `<nav aria-label="Report views"><a href="/dashboard/apps/${encodeURIComponent(selected)}">Cohorts and activity</a> <a href="/dashboard/apps/${encodeURIComponent(selected)}/records">Aggregate record counts</a> <a href="/dashboard/apps/${encodeURIComponent(selected)}/differences">Stored difference audit</a> <a href="/dashboard/apps/${encodeURIComponent(selected)}/fraud">Fraud audit</a> <a href="/dashboard/apps/${encodeURIComponent(selected)}/tracking-links">Measurement links</a></nav>`
    : "";
  const metadata = selected ? `<section aria-label="Report metadata"><h3>Report metadata</h3><dl><dt>Fixed watermark</dt><dd>${escapeHtml(view.metadata.watermark ?? "not selected")}</dd><dt>Snapshot IDs</dt><dd>${list(view.metadata.snapshotIds)}</dd><dt>Aggregation time zones</dt><dd>${list(view.metadata.aggregationTimeZones)}</dd><dt>Metric definition versions</dt><dd>${list(view.metadata.metricDefinitionVersions)}</dd><dt>Rule bundles</dt><dd>${list(view.metadata.ruleBundles)}</dd><dt>Policy versions</dt><dd>${list(view.metadata.policyVersions)}</dd><dt>Freshness</dt><dd>${list(view.metadata.freshnessStates)}</dd></dl></section>` : "";
  const createApp = view.canAdminister ? `<section><h2>Register an app</h2><form method="post" action="/dashboard/apps"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><label>App ID <input name="app_id" required pattern="[A-Za-z0-9._:-]{1,128}"></label><button type="submit">Register app and issue SDK key</button></form></section>` : "";
  const createLinkDomain = view.canAdminister ? `<section><h2>Register a link domain</h2><form method="post" action="/dashboard/link-domain"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><label>Host <input name="host" required placeholder="links.example.test"></label><button type="submit">Register domain</button></form></section>` : "";
  const createTrackingLink = selected && view.canOperate
    ? `<section><h2>Create a tracking link</h2><form method="post" action="/dashboard/apps/${encodeURIComponent(selected)}/tracking-links"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><label>Destination kind <select name="destination_kind"><option value="play_store">Play Store</option><option value="custom_https">Custom HTTPS</option></select></label><label>Destination URL <input type="url" name="destination_url" required></label><label>Play package name <input name="play_package_name"></label><label>Network <input name="network"></label><label>Campaign ID <input name="campaign_id"></label><button type="submit">Create tracking link</button></form></section>`
    : "";
  const metricContinuation = continuation(view, "", view.nextCursor, "Next metric page");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenMasu dashboard</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><header><h1>OpenMasu dashboard</h1><p>${view.undefinedCount} undefined value${view.undefinedCount === 1 ? "" : "s"} on this page.</p></header><main>${appNavigation}${selected ? `<h2>${escapeHtml(selected)}</h2>` : "<h2>Applications</h2>"}${reportNavigation}${metadata}${empty}${exportLink}${deterministicMetrics}${appleAggregateMetrics}${metricContinuation}${recordRows}${deterministicCharts}${appleAggregateCharts}${fraudAudit(view)}${googleDeliveryHealthSection(view)}${operatorDeliveryHealthSection(view)}${selected ? differences(view) : ""}${trackingLinks(view)}${createTrackingLink}${sdkKeys(view)}${serverKeys(view)}${operatorWebhooks(view)}${operatorBulkExports(view)}${configurationForms(view)}${createLinkDomain}${createApp}<form method="post" action="/dashboard/session/delete"><input type="hidden" name="csrf_token" value="${escapeHtml(view.csrfToken)}"><button type="submit">Sign out</button></form></main></body></html>`;
}
