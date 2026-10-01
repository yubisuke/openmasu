import type { DashboardView } from "./view.js";
import { escapeHtml } from "./render.js";
import { reportSelectionParams } from "./report-controls.js";

export function renderComparisonExport(view: DashboardView): string {
  if (!view.selectedAppId || !view.query) return "";
  const params = reportSelectionParams(view.query);
  params.set("limit", String(view.query.limit));
  const controls = [...params].map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`).join("");
  return `<section><h2>Save a comparison snapshot</h2><p>Select one metric, a half-open date range, an attribution-status filter when present, and an explicit watermark equal to the saved runs. Only a complete single result can be saved; a partial page, mixed definitions or mismatched conditions are refused. The file contains aggregate values and saved provenance, not raw events.</p><form method="get" action="/dashboard/apps/${encodeURIComponent(view.selectedAppId)}/comparison.json">${controls}<label>Aggregation declaration for legacy/unsupported runs <select name="comparison_aggregation"><option value="">Use the saved definition when available</option><option value="cumulative">Cumulative (declared)</option><option value="on_day">On day (declared)</option></select></label><button type="submit">Save comparison JSON</button></form><p>Supported meaning and maturity come from captured definitions. Legacy or unsupported meaning remains unknown; a successful download is not a claim of comparability or complete upstream delivery. Retain this private file outside the public repository. Use compare:cohorts to compare two saved snapshots.</p></section>`;
}
