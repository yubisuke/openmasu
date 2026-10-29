import type { TrackingLinkPreview } from "../tracking-link-preview.js";
import { escapeHtml as e } from "./html.js";

export function renderTrackingLinkPreview(appId: string, value: TrackingLinkPreview): string {
  const action = `/dashboard/apps/${encodeURIComponent(appId)}/tracking-links/${encodeURIComponent(value.tracking_link_id)}/preview`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Link preview · OpenMasu</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main>
    <h1>Preview without recording a click</h1><p><a href="/dashboard/apps/${encodeURIComponent(appId)}/tracking-links">Back to links</a></p>
    <p>This read-only calculation does not contact the destination, create a click or test an installed app, public association or store. The click ID is a fixed synthetic placeholder, not usable evidence.</p>
    <form method="get" action="${action}"><label>Platform<select name="platform">${["android", "ios", "other"].map(platform => `<option${value.platform === platform ? " selected" : ""}>${platform}</option>`).join("")}</select></label>
    <label>Optional direct path<input name="path" maxlength="256" value="${e(value.requested_path ?? "")}"></label>
    ${value.permitted_parameters.map(name => `<label>${e(name)}<input name="dlp_${e(name)}" maxlength="64" value="${e(value.bound_parameters[name] ?? "")}"></label>`).join("")}
    <button type="submit">Calculate preview</button></form>
    <dl><dt>Stored link state</dt><dd>${value.link_status}</dd><dt>Destination (not opened)</dt><dd><code>${e(value.destination)}</code></dd>
    <dt>Fallback reason</dt><dd>${e(value.fallback_reason ?? "none")}</dd><dt>Deferred payload</dt><dd>${value.deferred_status}</dd>
    <dt>Referrer budget</dt><dd>${value.referrer_characters ?? "not applicable"} / ${value.referrer_budget} encoded characters</dd>
    <dt>Referrer (placeholder only)</dt><dd><code>${e(value.referrer ?? "not carried")}</code></dd>
    <dt>Dropped parameter values</dt><dd>${value.dropped_parameter_count}</dd></dl>
    <p>Only registered parameter names are accepted. Invalid values are dropped by the same routing binder used for real requests. Custom HTTPS destinations keep their stored URL; this preview does not add new path/query forwarding.</p>
    </main></body></html>`;
}
