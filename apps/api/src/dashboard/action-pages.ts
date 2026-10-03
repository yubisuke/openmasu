import { escapeHtml } from "./html.js";

export function loginPage(error?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenMasu login</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>OpenMasu</h1>${error ? `<p role="alert">${escapeHtml(error)}</p>` : ""}<form method="post" action="/dashboard/session"><label>Admin key <input name="admin_key" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form></main></body></html>`;
}

export function renderForbidden(): string {
  return "<!doctype html><html lang=\"en\"><body><h1>Forbidden</h1></body></html>";
}

export function renderRegisteredAppKey(input: { readonly appId: string; readonly sdkKeyId: string; readonly sdkKey: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SDK key issued</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>SDK key issued</h1><p>Copy this secret now. It cannot be retrieved again.</p><dl><dt>App</dt><dd>${escapeHtml(input.appId)}</dd><dt>SDK key ID</dt><dd>${escapeHtml(input.sdkKeyId)}</dd><dt>SDK key</dt><dd><code>${escapeHtml(input.sdkKey)}</code></dd></dl><p><a href="/dashboard/apps/${encodeURIComponent(input.appId)}">Continue to the app dashboard</a></p></main></body></html>`;
}

export function renderAppRegistrationFailed(input: { readonly reason: string }): string {
  return `<!doctype html><html lang="en"><body><h1>App registration failed</h1><p>${escapeHtml(input.reason)}</p></body></html>`;
}

export function renderLinkDomainRegistrationFailed(input: { readonly reason: string }): string {
  return `<!doctype html><html lang="en"><body><h1>Link domain registration failed</h1><p>${escapeHtml(input.reason)}</p></body></html>`;
}

export function renderConfigurationFailed(input: { readonly reason: string }): string {
  return `<!doctype html><html lang="en"><body><h1>Configuration failed</h1><p>${escapeHtml(input.reason)}</p></body></html>`;
}

export function renderRecalculationRequestRejected(input: { readonly reason: string; readonly appId: string }): string {
  return `<!doctype html><html lang="en"><body><h1>Recalculation request rejected</h1><p>${escapeHtml(input.reason)}</p><p><a href="/dashboard/apps/${encodeURIComponent(input.appId)}/metric-recalculations">Return to recalculations</a></p></body></html>`;
}

export function renderMetricScheduleOperationFailed(input: { readonly reason: string; readonly appId: string }): string {
  return `<!doctype html><html lang="en"><body><h1>Metric schedule operation failed</h1><p>${escapeHtml(input.reason)}</p><p><a href="/dashboard/apps/${encodeURIComponent(input.appId)}/metric-schedules">Return to metric schedules</a></p></body></html>`;
}

export function renderAttributionReportNotCompleted(input: { readonly code: string }): string {
  return `<!doctype html><html lang="en"><body><h1>Attribution report not completed</h1><p>${escapeHtml(input.code)}</p><p>No partial counts were returned. Narrow the selection or check the service state.</p></body></html>`;
}

export function renderComparisonNotCompleted(input: { readonly code: string }): string {
  return `<!doctype html><html lang="en"><body><h1>Comparison not completed</h1><p>${escapeHtml(input.code)}</p><p>No result file was saved. Return to the comparison form and check the inputs.</p></body></html>`;
}

export function renderMetricRunNotFound(): string {
  return '<!doctype html><html lang="en"><body><h1>Metric run not found</h1></body></html>';
}

export function renderExportLimitExceeded(): string {
  return "<!doctype html><html lang=\"en\"><body><h1>Export limit exceeded</h1></body></html>";
}

export function renderTrackingLinkTransitionFailed(input: { readonly reason: string }): string {
  return `<!doctype html><html lang="en"><body><h1>Tracking link transition failed</h1><p>${escapeHtml(input.reason)}</p></body></html>`;
}

export function renderTrackingLinkCreated(input: { readonly appId: string; readonly link: string; readonly destinationUrl: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Tracking link created</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Tracking link created</h1><dl><dt>App</dt><dd>${escapeHtml(input.appId)}</dd><dt>Tracking link</dt><dd><code>${escapeHtml(input.link)}</code></dd><dt>Destination</dt><dd>${escapeHtml(input.destinationUrl)}</dd></dl><p><a href="/dashboard/apps/${encodeURIComponent(input.appId)}">Return to the app dashboard</a></p></main></body></html>`;
}

export function renderTrackingLinkCreationFailed(input: { readonly reason: string }): string {
  return `<!doctype html><html lang="en"><body><h1>Tracking link creation failed</h1><p>${escapeHtml(input.reason)}</p></body></html>`;
}

export function renderIssuedSdkKey(input: { readonly sdkKeyId: string; readonly sdkKey: string; readonly platform: string; readonly appId: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SDK key issued</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>SDK key issued</h1><p>Copy this secret now. It cannot be retrieved again.</p><dl><dt>SDK key ID</dt><dd>${escapeHtml(input.sdkKeyId)}</dd><dt>SDK key</dt><dd><code>${escapeHtml(input.sdkKey)}</code></dd><dt>Platform</dt><dd>${escapeHtml(input.platform)}</dd></dl><p><a href="/dashboard/apps/${encodeURIComponent(input.appId)}">Return to the app dashboard</a></p></main></body></html>`;
}

export function renderSDKKeyOperationFailed(input: { readonly reason: string }): string {
  return `<!doctype html><html lang="en"><body><h1>SDK key operation failed</h1><p>${escapeHtml(input.reason)}</p></body></html>`;
}

export function renderServerKeyIssued(input: { readonly serverKeyId: string; readonly serverKey: string; readonly producer: string; readonly appId: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Server key issued</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Server key issued</h1><p>Copy this secret now. It cannot be retrieved again.</p><dl><dt>Server key ID</dt><dd>${escapeHtml(input.serverKeyId)}</dd><dt>Server key</dt><dd><code>${escapeHtml(input.serverKey)}</code></dd><dt>Producer</dt><dd>${escapeHtml(input.producer)}</dd></dl><p><a href="/dashboard/apps/${encodeURIComponent(input.appId)}">Return to the app dashboard</a></p></main></body></html>`;
}

export function renderServerKeyOperationFailed(input: { readonly reason: string }): string {
  return `<!doctype html><html lang="en"><body><h1>Server key operation failed</h1><p>${escapeHtml(input.reason)}</p></body></html>`;
}

export function renderOperatorWebhookRegistered(input: { readonly destinationId: string; readonly endpointUrl: string; readonly signingSecret: string; readonly appId: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Operator webhook registered</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Operator webhook registered</h1><p>Copy this signing secret now. It cannot be retrieved again.</p><dl><dt>Destination ID</dt><dd>${escapeHtml(input.destinationId)}</dd><dt>Endpoint</dt><dd>${escapeHtml(input.endpointUrl)}</dd><dt>Signing secret</dt><dd><code>${escapeHtml(input.signingSecret)}</code></dd></dl><p><a href="/dashboard/apps/${encodeURIComponent(input.appId)}">Return to the app dashboard</a></p></main></body></html>`;
}

export function renderOperatorWebhookOperationFailed(input: { readonly reason: string }): string {
  return `<!doctype html><html lang="en"><body><h1>Operator webhook operation failed</h1><p>${escapeHtml(input.reason)}</p></body></html>`;
}

export function renderBulkExportRegistered(input: { readonly appId: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Bulk export registered</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>Bulk export registered</h1><p>The protected storage credential was accepted and will not be displayed.</p><p><a href="/dashboard/apps/${encodeURIComponent(input.appId)}">Return to the app dashboard</a></p></main></body></html>`;
}

export function renderBulkExportOperationFailed(input: { readonly reason: string }): string {
  return `<!doctype html><html lang="en"><body><h1>Bulk export operation failed</h1><p>${escapeHtml(input.reason)}</p></body></html>`;
}

export function renderAppNotFound(): string {
  return "<!doctype html><html lang=\"en\"><body><h1>App not found</h1></body></html>";
}

export function renderInvalidFilter(input: { readonly reason: string }): string {
  return `<!doctype html><html lang="en"><body><h1>Invalid filter</h1><p>${escapeHtml(input.reason)}</p></body></html>`;
}
