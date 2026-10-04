import type { RecoveryItem } from "../ingest-recovery.js";
import { escapeHtml } from "./html.js";

export function renderIngestRecovery(input: { appId: string; items: readonly RecoveryItem[]; csrfToken: string; canOperate: boolean; error?: string }): string {
  const app = encodeURIComponent(input.appId);
  const rows = input.items.map(item => {
    const eligible = item.recovery === "validate_before_retry" || item.recovery === "expedite_existing_retry";
    const form = input.canOperate && eligible ? `<form method="post" action="/dashboard/apps/${app}/ingest-recovery">
      <input type="hidden" name="csrf_token" value="${escapeHtml(input.csrfToken)}"><input type="hidden" name="kind" value="${item.kind}">
      <input type="hidden" name="job_id" value="${escapeHtml(item.job_id)}"><input type="hidden" name="revision" value="${escapeHtml(item.revision)}">
      <label><input type="checkbox" name="confirmation" value="retry_once" required> I have reviewed and fixed the worker configuration or temporary failure.</label>
      <button type="submit">${item.kind === "sdk_batch" ? "Validate and queue one retry" : "Bring this existing retry forward"}</button></form>` : escapeHtml(item.recovery);
    return `<tr><th scope="row">${item.kind}</th><td>${escapeHtml(item.job_id)}</td><td>${escapeHtml(item.state)}</td><td>${escapeHtml(item.reason)}</td><td>${item.attempts}</td><td>${escapeHtml(item.next_attempt_at ?? "Next worker poll")}</td><td>${form}</td></tr>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Ingest recovery · OpenMasu</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Ingest recovery</h1>
    <p><a href="/dashboard/apps/${app}">Back to the app dashboard</a></p>${input.error ? `<p role="alert">${escapeHtml(input.error)}</p>` : ""}
    <p>Check the worker deployment's database permissions, payload-store configuration and enabled provider settings first. This page cannot verify worker secrets, provider availability or real delivery. Reasons are closed diagnostic classes, not raw errors.</p>
    <p>Up to 50 SDK failures/post-processing entries and 50 existing auxiliary entries are shown. SDK retries validate the original evidence and retain the original failure receipt; at most three manual attempts per batch are allowed. Worker claims, stale forms, missing or deleted evidence and invalid input are refused.</p>
    <p>Auxiliary recovery only brings an existing eligible retry forward for the normal worker poll. It never recreates completed verification, changes token lifetime, or replaces a verdict. After terminal failure, submit new valid evidence through the original authenticated path; do not reuse consumed tokens. Post-processing is already retried automatically.</p>
    ${rows ? `<table><caption>Scoped operational jobs (never event or device identifiers)</caption><thead><tr><th>Queue</th><th>Opaque job ID</th><th>State</th><th>Safe reason</th><th>Attempts</th><th>Next attempt</th><th>Recovery</th></tr></thead><tbody>${rows}</tbody></table>` : "<p>No recoverable work is recorded.</p>"}
    </main></body></html>`;
}
