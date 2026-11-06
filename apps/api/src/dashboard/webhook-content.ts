import { defaultWebhookContentPolicy, parseWebhookContentPolicy, type previewWebhookContent } from "@openmasu/runtime/webhook-content";
import type { readWebhookContent } from "../webhook-content-admin.js";
import { escapeHtml as e } from "./html.js";

export function contentPolicyFromForm(form: URLSearchParams) {
  const dictionary = (key: string) => {
    if (form.getAll(key).length !== 1) throw Error("operator_webhook_content_invalid");
    const lines = (form.get(key) ?? "").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const pairs = lines.map(line => line.split("=").map(part => part.trim()));
    if (pairs.some(pair => pair.length !== 2) || new Set(pairs.map(pair => pair[0])).size !== pairs.length) throw Error("operator_webhook_content_invalid");
    return Object.fromEntries(pairs);
  };
  if (form.getAll("share_money").length > 1 || (form.has("share_money") && form.get("share_money") !== "yes")) throw Error("operator_webhook_content_invalid");
  return parseWebhookContentPolicy({ mode: "explicit_v1", custom_events: dictionary("custom_events"), event_names: dictionary("event_names"), share_money: form.has("share_money") });
}
export function renderWebhookContent(appId: string, token: string, history: Awaited<ReturnType<typeof readWebhookContent>>,
  preview?: ReturnType<typeof previewWebhookContent>, error?: string) {
  const base = `/dashboard/apps/${encodeURIComponent(appId)}/operator-webhooks/${encodeURIComponent(history.destination_id)}/content-policy`;
  const current = history.revisions[0], policy = preview?.policy ?? (current?.definition.mode === "explicit_v1" ? current.definition : defaultWebhookContentPolicy);
  const csrf = `<input type="hidden" name="csrf_token" value="${e(token)}">`;
  const pairs = (value: Record<string, string>) => e(Object.entries(value).map(([key, name]) => `${key}=${name}`).join("\n"));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Webhook content — OpenMasu</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Webhook content policy</h1><p><a href="/dashboard/apps/${encodeURIComponent(appId)}">Back to app</a></p>
    <p>Selected event classes: ${e(history.events.join(", "))}. Preview is synthetic only: no provider calls, secrets, raw identifiers or outbox writes. A content change affects events received after activation; already queued requests keep their bytes. Deletion and comparison notices are separate.</p>
    ${error ? `<p role="alert">${e(error)}</p>` : ""}
    <form method="post" action="${base}/preview">${csrf}<label>Custom-event allowlist and names (one source_key=receiver_key per line, maximum 20)<textarea name="custom_events" maxlength="2600">${pairs(policy.custom_events)}</textarea></label><label>Event-class names (optional source=receiver lines for the five supported classes)<textarea name="event_names" maxlength="650">${pairs(policy.event_names)}</textarea></label><label><input type="checkbox" name="share_money" value="yes"${policy.share_money ? " checked" : ""}> Share exact amount, scale and currency</label><button type="submit">Preview without sending</button></form>
    ${preview ? `<h2>Synthetic preview</h2><table><thead><tr><th>Source</th><th>Send?</th><th>Projected fields (references omitted)</th></tr></thead><tbody>${preview.examples.map(row => `<tr><td>${e(row.source_name)} ${e(row.source_key ?? "")}</td><td>${row.send ? "yes" : "no"}</td><td><pre>${e(JSON.stringify(row.event ?? null))}</pre></td></tr>`).join("")}</tbody></table>${history.status === "active" ? `<form method="post" action="${base}">${csrf}<input type="hidden" name="policy" value="${e(JSON.stringify(preview.policy))}"><input type="hidden" name="preview_digest" value="${e(preview.preview_digest)}"><input type="hidden" name="expected_revision" value="${current.policy_revision}"><button type="submit">Activate reviewed policy</button></form>` : ""}` : ""}
    <h2>Immutable history (latest 50)</h2><ul>${history.revisions.map(row => `<li>Revision ${row.policy_revision}, ${e(row.created_at)}, ${e(row.definition_digest)}<pre>${e(JSON.stringify(row.definition))}</pre></li>`).join("")}</ul>
    <p>Legacy policies preserve the original all-custom-key and money-sharing behavior until explicitly replaced. New destinations default to no custom keys and no money. No arbitrary templates or additional attributes are supported.</p></main></body></html>`;
}
