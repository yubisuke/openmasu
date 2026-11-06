import type { previewWebhookRecovery, confirmWebhookRecovery } from "@openmasu/runtime/operator-webhook-recovery";
import { escapeHtml as e } from "./html.js";

export function renderWebhookRecovery(appId: string, csrf: string,
  result?: Awaited<ReturnType<typeof previewWebhookRecovery>> | Awaited<ReturnType<typeof confirmWebhookRecovery>>, error?: string) {
  const back = `/dashboard/apps/${encodeURIComponent(appId)}`;
  const content = error ? `<p>Recovery refused: ${e(error)}</p>` : result && "preview_id" in result
    ? `<p>No request has been sent. The reconstructed original body matches its recorded digest. Confirm within ten minutes; eligibility is checked again.</p>
      <dl><dt>Delivery</dt><dd>${e(result.delivery_id)}</dd><dt>Destination</dt><dd>${e(result.destination_id)}</dd>
      <dt>Original SHA-256</dt><dd>${e(result.request_digest)}</dd><dt>Completed attempts</dt><dd>${e(result.previous_attempt)}</dd>
      <dt>Signing revision</dt><dd>${e(result.signing_revision)}</dd><dt>Preview expires</dt><dd>${e(result.expires_at)}</dd></dl>
      <form method="post" action="${back}/operator-webhook-deliveries/${encodeURIComponent(result.delivery_id)}/recovery-confirm">
      <input type="hidden" name="csrf_token" value="${e(csrf)}"><input type="hidden" name="preview_id" value="${e(result.preview_id)}">
      <input type="hidden" name="receipt" value="${e(result.receipt)}"><button type="submit">Confirm original-body recovery</button></form>`
    : `<p>Recovery ${e(result && "status" in result ? result.status : "unavailable")}. This is not confirmation of receiver acceptance. Check delivery health for the subsequent attempt.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Webhook recovery</title><link rel="stylesheet" href="/dashboard/app.css"></head>
    <body><main><h1>Webhook recovery</h1>${content}<p>Original results remain in delivery history. No retention period or signing-key lifetime is extended.</p><a href="${back}">Return to application</a></main></body></html>`;
}
