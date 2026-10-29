import type { OperatorBulkExportDestination } from "../operator-bulk-exports-admin.js";
import { escapeHtml } from "./html.js";

export function renderBulkExportCredentials(destination: OperatorBulkExportDestination, csrf: string): string {
  const path = `/dashboard/apps/${encodeURIComponent(destination.app_id)}/operator-bulk-exports/${encodeURIComponent(destination.destination_id)}/credentials`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Replace bulk export credentials</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main>
<h1>Replace bulk export credentials</h1><p>Destination: ${escapeHtml(destination.destination_id)}</p>
<p>This replaces the complete credential tuple. The endpoint, bucket, prefix, reference key and checkpoint stay unchanged. No probe is sent. A batch waiting for credentials resumes with the same object key and bytes.</p>
<p>Current revision: ${escapeHtml(destination.credential_revision)}. Changed: ${escapeHtml(destination.credential_changed_at)}.</p>
<form method="post" action="${escapeHtml(path)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrf)}"><input type="hidden" name="expected_revision" value="${escapeHtml(destination.credential_revision)}">
<label>New access key ID <input type="password" name="access_key_id" autocomplete="off" required></label>
<label>New secret access key <input type="password" name="secret_access_key" autocomplete="new-password" required></label>
<label>New session token (blank clears the old token) <input type="password" name="session_token" autocomplete="off"></label>
<button type="submit">Confirm credential replacement</button></form>
<p>Existing credentials are never displayed. Superseded credentials remain encrypted until the destination is disabled; revoke the old key at your storage provider after the replacement succeeds.</p>
<p><a href="/dashboard/apps/${encodeURIComponent(destination.app_id)}">Return to app</a></p></main></body></html>`;
}
