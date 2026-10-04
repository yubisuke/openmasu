import { recentMeasurementNotices, type RecentMeasurementHealth } from "../measurement-notices.js";
import { escapeHtml } from "./html.js";

export function renderRecentMeasurementHealth(recent: RecentMeasurementHealth, appId?: string): string {
  const value = (input: string | null) => escapeHtml(input ?? "Not observed");
  const base = appId ? `/dashboard/apps/${encodeURIComponent(appId)}/measurement-health` : undefined;
  const windows = base ? `<nav aria-label="Receipt window">${([1,24,168] as const).map(hours =>
    `<a href="${base}?window_hours=${hours}"${recent.window_hours === hours ? ' aria-current="page"' : ""}>${hours} hours</a>`).join(" · ")}</nav>` : "";
  const notices = recentMeasurementNotices(recent).map(notice =>
    `<li data-measurement-state="${escapeHtml(notice.state)}"><strong>${escapeHtml(notice.message)}</strong> ${escapeHtml(notice.next)}</li>`).join("");
  const rows = recent.groups.flatMap(group => (["current", "previous"] as const).map(period => {
    const counts = group[period];
    return `<tr><th scope="row">${value(group.producer)} / ${value(group.producer_version)} / ${value(group.event_name)}</th><td>${period}</td><td>${value(counts.accepted)}</td><td>${value(counts.rejected)}</td><td>${value(counts.duplicate)}</td><td>${value(counts.late)}</td><td>${value(counts.metadata_not_recorded)}</td><td>${value(counts.latest_received_at)}</td></tr>`;
  })).join("");
  const pending = recent.pending_groups.map(group =>
    `<tr><th scope="row">${value(group.producer)} / ${value(group.producer_version)} / ${value(group.event_name)}</th><td>${value(group.pending)}</td><td>${value(group.post_processing_pending)}</td><td>${value(group.oldest_received_at)}</td></tr>`).join("");
  return `<section aria-label="Recent measurement"><h2>Recent measurement</h2>${windows}
    <p>Current receipt window: ${value(recent.received_from)} ≤ server receipt &lt; ${value(recent.received_to)}. The preceding equal window starts at ${value(recent.previous_from)}. These windows do not use event occurrence time or report filters.</p>
    <p>SDK versions are client-reported public versions, not attested device identities. Unknown values are grouped as other. Legacy rows without recorded header metadata are not reconstructed from protected payloads.</p>
    <ul>${notices}</ul>
    ${rows ? `<table><caption>Delivery attempts by closed event and SDK-version class</caption><thead><tr><th scope="col">Producer / SDK version / event</th><th scope="col">Window</th><th scope="col">Accepted</th><th scope="col">Rejected</th><th scope="col">Duplicate</th><th scope="col">Late (overlapping)</th><th scope="col">Metadata not recorded</th><th scope="col">Latest receipt</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No attempts recorded in either window.</p>"}
    ${pending ? `<table><caption>Unfinished submitted events in the current window (not unique events)</caption><thead><tr><th scope="col">Producer / SDK version / event</th><th scope="col">Pending</th><th scope="col">Of these: post-processing</th><th scope="col">Oldest receipt</th></tr></thead><tbody>${pending}</tbody></table>` : "<p>No unfinished submissions recorded in this window.</p>"}
    <p>Accepted, rejected and duplicate counts are exclusive delivery outcomes; late is an overlapping property. Post-processing may remain pending after admission. SDK queue diagnostics stay on the device and are not received by this server; compare them locally. Missing receipts, rejection counts and small samples do not prove an outage, live delivery or an SLA.</p></section>`;
}

export function renderMeasurementHealthPage(recent: RecentMeasurementHealth, appId: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Recent measurement · OpenMasu</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Measurement health</h1><p><a href="/dashboard/apps/${encodeURIComponent(appId)}">Back to the app dashboard</a></p>${renderRecentMeasurementHealth(recent, appId)}</main></body></html>`;
}
