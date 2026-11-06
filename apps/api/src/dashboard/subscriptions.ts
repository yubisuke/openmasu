import type { SubscriptionReport } from "../subscription-reporting.js";
import { escapeHtml as escape } from "./html.js";

export function renderSubscriptions(appId: string, report?: SubscriptionReport, error?: string): string {
  const base = `/dashboard/apps/${encodeURIComponent(appId)}`;
  const field = (name: "date_from" | "date_to" | "watermark_at_most", label: string, type = "text") =>
    `<label>${label} <input name="${name}" type="${type}" value="${escape(report?.selection[name] ?? "")}" required></label>`;
  const observations = report ? `<h2>Last observed states, not current entitlement</h2>
    <table><caption>Uniquely bound Google Play token series</caption><thead><tr><th>State</th><th>Series</th><th>Oldest observation</th><th>Newest observation</th></tr></thead><tbody>${report.last_observed_states.map(row => `<tr><td>${escape(row.state)}</td><td>${row.series_count}</td><td>${escape(row.oldest_observed_at)}</td><td>${escape(row.newest_observed_at)}</td></tr>`).join("")}</tbody></table>
    <p>Unknown-series read-back observations: ${report.unknown_series_observations}. Unknown observations are not subscriber counts.</p>
    <dl>${Object.entries(report.evidence_times).map(([key, value]) => `<dt>${escape(key)}</dt><dd>${escape(value ?? "not_observed")}</dd>`).join("")}</dl>
    <h2>Daily recorded activity (UTC)</h2><table><caption>Distinct verified renewals and observed expiry boundaries; notification signals are separate</caption><thead><tr><th>Date</th><th>Verified renewals</th><th>Observed expiries</th><th>Notification signals</th><th>Unknown-series signals</th></tr></thead><tbody>${report.daily.map(row => `<tr><td>${row.date}</td><td>${row.verified_renewals}</td><td>${row.observed_expiries}</td><td>${row.notification_signals}</td><td>${row.unknown_series_signals}</td></tr>`).join("")}</tbody></table>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Subscription observations — OpenMasu</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Subscription observations</h1><p><a href="${base}">Back to app reports</a></p>
    ${error ? `<p role="alert">${escape(error)}. No partial report was published.</p>` : ""}
    <form method="get" action="${base}/subscriptions">${field("date_from", "Daily activity from (inclusive UTC)", "date")}${field("date_to", "To (exclusive UTC)", "date")}${field("watermark_at_most", "Fixed evidence cutoff (UTC milliseconds)")}<button type="submit">Read observations</button></form>
    <p>Cancel does not mean expired. State is the last retained authoritative read-back, never a period-end subscriber count, current entitlement or churn rate. Renewals require verified order purchases; expiries require a single-item expired read-back and its expiry boundary, not a notification alone.</p>${observations}
    <p>States use all retained evidence through the cutoff; the date range filters daily activity only. Current privacy applies even to historical cutoffs. Late verification can change a later-cutoff report; no saved metric run is rewritten. Completeness is unknown; zero means no qualifying retained evidence, not zero provider activity. Maximum 31 days and 10,000 retained source rows across history; oversized reads fail closed.</p>
    <p>Replacement-token chains and multiple line items remain unknown. Apple subscription analytics, trial conversion, MRR, entitlement and future churn are not provided.</p></main></body></html>`;
}
