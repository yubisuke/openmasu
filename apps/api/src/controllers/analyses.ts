import type { RequestHandlerDependencies } from "../http-types.js";
import type { DashboardAppContext } from "./context.js";
import { dashboardHeaders, dashboardHtml } from "../http-responses.js";
import { authorizeDashboardForm } from "../http-security.js";
import { csrfToken } from "../session.js";
import { roleAllows } from "../authorization.js";
import { decodedPathPart } from "../http-paths.js";
import { ReportQueryError } from "../report-query.js";
import { ComparisonExportError } from "../comparison-export.js";
import { comparisonLimits } from "../fixed-comparison.js";
import { analysisQuery, deleteSavedAnalysis, getSavedAnalysis, listSavedAnalyses, saveAnalysis } from "../saved-analysis.js";
import { acquirePeriodAnalysis, encodePeriodAnalysisCsv } from "../period-analysis.js";
import { renderSavedAnalyses, renderPeriodAnalysis, renderAnalysisError } from "../dashboard/saved-analysis.js";
import { dashboardReportParams } from "../dashboard/report-controls.js";

export function createAnalysesControllers(dependencies: Pick<RequestHandlerDependencies, "readerPool" | "pool" | "dashboard">) {
  const index = async ({ response, session, appId, appIdentity, target }: DashboardAppContext) => {
    const params = dashboardReportParams(target.searchParams);
    dashboardHtml(response, 200, renderSavedAnalyses(appId, await listSavedAnalyses(dependencies.readerPool, appIdentity),
      csrfToken(session.token), roleAllows(session.role, "operate"), params));
  };
  const mutate = async ({ request, response, decoder, route, session, appId, appIdentity, target }: DashboardAppContext) => {
    const form = await decoder.form();
    if (!await authorizeDashboardForm(dependencies, { request, response, session }, form, "saved_analysis_mutation", "app", appId)) return;
    try {
      const base = `/dashboard/apps/${encodeURIComponent(appId)}/analyses`;
      if (route.handler === "dashboard_analysis_delete") {
        const id = decodedPathPart(target.pathname, /\/analyses\/([^/]+)\/delete$/);
        if (!id || !await deleteSavedAnalysis(dependencies.pool, appIdentity, id)) {
          dashboardHtml(response, 404, renderAnalysisError("not_found")); return;
        }
        response.writeHead(303, { ...dashboardHeaders, location: base }).end(); return;
      }
      for (const key of ["name", "display", "csrf_token"]) if (form.getAll(key).length !== 1) throw new ReportQueryError("duplicate_or_missing_setting");
      const params = dashboardReportParams(form);
      for (const key of ["name", "display", "csrf_token"]) params.delete(key);
      const id = await saveAnalysis(dependencies.pool, appIdentity, { name: form.get("name")!, display: form.get("display")!, selection: params.toString() });
      response.writeHead(303, { ...dashboardHeaders, location: `${base}/${encodeURIComponent(id)}` }).end();
    } catch (error) {
      if (!(error instanceof ReportQueryError)) throw error;
      dashboardHtml(response, 400, renderAnalysisError(error.code));
    }
  };
  const read = async ({ response, appId, appIdentity, target }: DashboardAppContext) => {
    const id = decodedPathPart(target.pathname, /\/analyses\/([^/]+?)(?:\.csv)?$/);
    const saved = id && await getSavedAnalysis(dependencies.readerPool, appIdentity, id);
    if (!saved) { dashboardHtml(response, 404, renderAnalysisError("not_found")); return; }
    const abort = new AbortController(); const onClose = () => abort.abort(); response.once("close", onClose);
    try {
      const params = new URLSearchParams(saved.selection);
      for (const [key, value] of target.searchParams) {
        if (!["date_from", "date_to", "watermark_at_most"].includes(key) || target.searchParams.getAll(key).length !== 1) {
          throw new ReportQueryError("analysis_override_not_allowed");
        }
        params.set(key, value);
      }
      const result = await acquirePeriodAnalysis(dependencies.readerPool, appIdentity, analysisQuery(appIdentity, params), { signal: abort.signal });
      const csv = target.pathname.endsWith(".csv");
      const body = csv ? encodePeriodAnalysisCsv(result, saved.display) : renderPeriodAnalysis(appId, saved, result);
      if (Buffer.byteLength(body, "utf8") > comparisonLimits.bytes) throw new ReportQueryError("analysis_output_limit");
      if (csv) {
        response.writeHead(200, { ...dashboardHeaders, "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="openmasu-period-analysis.csv"' });
        response.end(body);
      } else dashboardHtml(response, 200, body);
    } catch (error) {
      if (!(error instanceof ReportQueryError) && !(error instanceof ComparisonExportError)) throw error;
      dashboardHtml(response, 400, renderAnalysisError(error.message));
    } finally { response.off("close", onClose); }
  };
  return {
    dashboard_analyses: { boundary: "dashboard_app", handle: index },
    dashboard_analysis_save: { boundary: "dashboard_app", handle: mutate },
    dashboard_analysis_delete: { boundary: "dashboard_app", handle: mutate },
    dashboard_analysis_read: { boundary: "dashboard_app", handle: read },
  } as const;
}
