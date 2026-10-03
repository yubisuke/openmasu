import { AppNotFoundError, listApps, requireRegisteredApp } from "../apps-admin.js";
import { roleAllows } from "../authorization.js";
import { renderDashboard } from "../dashboard/render.js";
import { buildDashboardView } from "../dashboard/view.js";
import { metricExplanation } from "../metric-explanation.js";
import { ComparisonExportError } from "../comparison-export.js";
import { fixedComparisonDownload } from "../fixed-comparison.js";
import { compareSnapshots } from "../cohort-comparison.js";
import { jcs } from "@openmasu/attribution-core/canonical";
import { ComparisonWorkflowError, comparisonWorkflowLimits, readComparisonSubmission, boundedComparisonOutput } from "../dashboard-comparison.js";
import { renderComparisonWorkflow } from "../dashboard/comparison-workflow.js";
import { renderComparison } from "../dashboard/comparison-report.js";
import { renderMetricExplanation } from "../dashboard/metric-explanation.js";
import { dashboardReportParams } from "../dashboard/report-controls.js";
import { differenceAudit, encodeDifferenceAudit, encodeMetricReport, encodeRecordCounts, metricReport, recordCounts, supportsRecordCounts, type ReportFormat } from "../reporting.js";
import { parseMetricQuery, ReportQueryError } from "../report-query.js";
import { encodeFraudAudit, fraudAudit, FraudAuditQueryError, parseFraudAuditQuery } from "../fraud-reporting.js";
import { googleDeliveryHealth } from "../google-delivery-health.js";
import { operatorDeliveryHealth } from "../operator-delivery-health.js";
import { measurementHealth } from "../measurement-health.js";
import { attributionReport, AttributionReportError, parseAttributionQuery } from "../attribution-reporting.js";
import { renderAttributionReport } from "../dashboard/attribution-report.js";
import { csrfToken, verifyCsrfToken } from "../session.js";
import { listTrackingLinks } from "../tracking-links.js";
import { listSdkKeys } from "../sdk-auth.js";
import { listServerKeys } from "../server-auth.js";
import { listOperatorWebhookDestinations } from "../operator-webhooks-admin.js";
import { listOperatorBulkExportDestinations } from "../operator-bulk-exports-admin.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { DashboardAppContext, AdminRequestContext } from "./context.js";
import { json, dashboardHtml } from "../http-responses.js";
import { adminAppId, decodedPathPart, listedTrackingLink } from "../http-paths.js";
import { csrfOriginAccepted } from "../http-security.js";
import { dashboardHeaders } from "../http-responses.js";
import { renderAttributionReportNotCompleted, renderComparisonNotCompleted, renderMetricRunNotFound, renderExportLimitExceeded } from "../dashboard/action-pages.js";

export function createReportsControllers(dependencies: Pick<RequestHandlerDependencies, "readerPool" | "dashboard" | "reportMaximumRows" | "reportMaximumExportRows" | "redirectorBaseUrl">) {
  const dashboardAttributionReport = async ({ response, target, appId, appIdentity }: DashboardAppContext): Promise<void> => {
    try {
      const report = [...target.searchParams].length ? await attributionReport(dependencies.readerPool, appIdentity, parseAttributionQuery(target.searchParams)) : undefined;
      dashboardHtml(response, 200, renderAttributionReport(appId, report));
    } catch (error) {
      if (!(error instanceof AttributionReportError)) throw error;
      dashboardHtml(response, error.statusCode, renderAttributionReportNotCompleted({ code: error.code }));
    }
    return;
  };

  const dashboardComparisonForm = async ({ request, response, target, route, startedAt, session, appId, appIdentity }: DashboardAppContext): Promise<void> => {
    const deadline = startedAt + comparisonWorkflowLimits.milliseconds;
    try {
      if ([...target.searchParams].length) throw new ComparisonWorkflowError("comparison_query_not_allowed");
      if (route.handler === "dashboard_comparison_form") {
        dashboardHtml(response, 200, boundedComparisonOutput(renderComparisonWorkflow(appId, csrfToken(session.token)), deadline));
        return;
      }
      if (!csrfOriginAccepted(request, dependencies.dashboard.publicBaseUrl)) throw new ComparisonWorkflowError("csrf_rejected", 403);
      const submission = await readComparisonSubmission(request, appIdentity, token => verifyCsrfToken(session.token, token), deadline);
      if (submission.action === "review") {
        dashboardHtml(response, 200, boundedComparisonOutput(renderComparisonWorkflow(appId, csrfToken(session.token), submission), deadline));
        return;
      }
      const result = compareSnapshots(submission.left, submission.right, { allowExternalDeclaration: submission.allowExternalDeclaration });
      if (submission.action === "result") {
        dashboardHtml(response, 200, boundedComparisonOutput(renderComparisonWorkflow(appId, csrfToken(session.token), submission, result, submission.allowExternalDeclaration), deadline));
      } else {
        const html = submission.action === "html";
        const body = boundedComparisonOutput(html ? renderComparison(result) : `${jcs(result)}\n`, deadline);
        response.writeHead(200, { ...dashboardHeaders, "content-type": html ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="openmasu-comparison.${html ? "html" : "json"}"` }).end(body);
      }
    } catch (error) {
      const safe = error instanceof ComparisonWorkflowError ? error : new ComparisonWorkflowError("comparison_invalid_input");
      if (!response.destroyed) dashboardHtml(response, safe.statusCode, renderComparisonNotCompleted({ code: safe.code }));
    }
    return;
  };

  const dashboardMetricExplanation = async ({ response, target, appId, appIdentity }: DashboardAppContext): Promise<void> => {
    const runId = decodedPathPart(target.pathname, /\/metrics\/([^/]+)\/explanation$/) ?? "";
    const explanation = await metricExplanation(dependencies.readerPool, appIdentity, runId);
    dashboardHtml(response, explanation ? 200 : 404, explanation ? renderMetricExplanation(appId, explanation)
      : renderMetricRunNotFound());
    return;
  };

  const dashboardFraud = async ({ response, target, session, sessionIdentity, appId, appIdentity }: DashboardAppContext): Promise<void> => {
    const from = target.searchParams.get("from") ?? "2000-01-01";
    const to = target.searchParams.get("to") ?? "9999-12-31";
    const rows = await fraudAudit(dependencies.readerPool, appIdentity, { from, to });
    const apps = await listApps(dependencies.readerPool, sessionIdentity);
    dashboardHtml(response, 200, renderDashboard(buildDashboardView({
      apps,
      selectedAppId: appIdentity.appId,
      fraudRows: rows,
      csrfToken: csrfToken(session.token),
    })));
    return;
  };

  const dashboardApp = async ({ response, target, route, session, sessionIdentity, appId, appIdentity }: DashboardAppContext): Promise<void> => {
    const params = dashboardReportParams(target.searchParams);
    let declaredAggregation: string | undefined;
    if (route.handler === "dashboard_comparison_export") {
      const declarations = params.getAll("comparison_aggregation");
      if (declarations.length > 1 || (declarations.length === 1 && !["", "cumulative", "on_day"].includes(declarations[0]))) {
        throw new ComparisonExportError("comparison_aggregation_invalid");
      }
      declaredAggregation = declarations[0] || undefined;
      params.delete("comparison_aggregation");
    }
    if (route.handler === "dashboard_export") {
      params.set("format", "csv");
      params.set("export", "true");
    }
    const parsed = parseMetricQuery({
      tenantId: appIdentity.tenantId,
      appId: appIdentity.appId,
      searchParams: params,
      maximumRows: dependencies.reportMaximumRows,
      maximumExportRows: dependencies.reportMaximumExportRows,
      cursorKind: route.handler === "dashboard_differences"
        ? "difference"
        : route.handler === "dashboard_records" ? "record" : "metric",
    });
    if (route.handler === "dashboard_export") {
      const page = await metricReport(dependencies.readerPool, appIdentity, parsed.query);
      if (page.next_cursor) {
        dashboardHtml(response, 400, renderExportLimitExceeded());
        return;
      }
      const encoded = encodeMetricReport(page, "csv");
      const first = page.data[0];
      const range = `${parsed.query.dateFrom ?? "all"}-${parsed.query.dateTo ?? "all"}`;
      response.writeHead(200, {
        "content-type": encoded.contentType,
        "content-disposition": `attachment; filename="openmasu-${appIdentity.appId}-${range}-${first?.input_snapshot_id.slice(0, 8) ?? "empty"}.csv"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(encoded.body);
      return;
    }
    if (route.handler === "dashboard_comparison_export") {
      const abort = new AbortController();
      const disconnected = () => abort.abort();
      response.once("close", disconnected);
      let body: string;
      try {
        body = await fixedComparisonDownload(dependencies.readerPool, appIdentity, parsed.query,
          { declaredAggregation, signal: abort.signal });
      } finally { response.off("close", disconnected); }
      response.writeHead(200, { ...dashboardHeaders, "content-type": "application/json; charset=utf-8",
        "content-disposition": 'attachment; filename="openmasu-comparison.json"',
        "content-length": Buffer.byteLength(body, "utf8") });
      response.end(body);
      return;
    }

    const apps = await listApps(dependencies.readerPool, sessionIdentity);
    const trackingLinks = (await listTrackingLinks(dependencies.readerPool, appIdentity.tenantId, appIdentity.appId))
      .map((link) => listedTrackingLink(dependencies.redirectorBaseUrl, link));
    const sdkKeys = await listSdkKeys(dependencies.readerPool, appIdentity);
    const serverKeys = await listServerKeys(dependencies.readerPool, appIdentity);
    const operatorWebhooks = await listOperatorWebhookDestinations(dependencies.readerPool, appIdentity);
    const operatorBulkExports = await listOperatorBulkExportDestinations(dependencies.readerPool, appIdentity);
    const googleHealth = await googleDeliveryHealth(dependencies.readerPool, appIdentity);
    const operatorHealth = await operatorDeliveryHealth(dependencies.readerPool, appIdentity);
    const measurement = await measurementHealth(dependencies.readerPool, appIdentity);
    const metrics = await metricReport(dependencies.readerPool, appIdentity, parsed.query);
    const effectiveWatermark = parsed.query.watermarkAtMost
      ?? metrics.data.map((row) => row.input_received_at_watermark).sort().at(-1);
    const effectiveQuery = effectiveWatermark
      ? { ...parsed.query, watermarkAtMost: effectiveWatermark }
      : parsed.query;
    const records = effectiveWatermark && supportsRecordCounts(effectiveQuery)
      ? await recordCounts(dependencies.readerPool, appIdentity, effectiveQuery)
      : { data: [] };
    const storedDifferences = effectiveQuery.metricScheduleId ? { data: [] }
      : await differenceAudit(dependencies.readerPool, appIdentity, effectiveQuery);
    dashboardHtml(response, 200, renderDashboard(buildDashboardView({
      apps,
      selectedAppId: appIdentity.appId,
      query: effectiveQuery,
      metrics: ["dashboard_differences", "dashboard_records", "dashboard_tracking_links_list"].includes(route.handler) ? { data: [] } : metrics,
      records: ["dashboard_differences", "dashboard_tracking_links_list"].includes(route.handler) ? [] : records.data,
      ...(records.next_cursor ? { recordNextCursor: records.next_cursor } : {}),
      differences: storedDifferences,
      ...(storedDifferences.next_cursor ? { differenceNextCursor: storedDifferences.next_cursor } : {}),
      trackingLinks,
      sdkKeys,
      serverKeys,
      operatorWebhooks,
      operatorBulkExports,
      googleDeliveryHealth: googleHealth,
      operatorDeliveryHealth: operatorHealth,
      measurementHealth: measurement,
      canOperate: roleAllows(session.role, "operate"),
      canAdminister: roleAllows(session.role, "administer"),
      csrfToken: csrfToken(session.token),
    })));
  };

  const adminAttributionReport = async ({ response, target, pool, identity }: AdminRequestContext): Promise<void> => {
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      json(response, 200, await attributionReport(pool, appIdentity, parseAttributionQuery(target.searchParams)));
    } catch (error) {
      if (error instanceof AppNotFoundError) json(response, 404, { error: "app_not_found" });
      else if (error instanceof AttributionReportError) json(response, error.statusCode, { error: error.code });
      else throw error;
    }
    return;
  };

  const adminMetricExplanation = async ({ response, target, pool, identity }: AdminRequestContext): Promise<void> => {
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      const explanation = await metricExplanation(pool, appIdentity, decodedPathPart(target.pathname, /\/metrics\/([^/]+)\/explanation$/) ?? "");
      json(response, explanation ? 200 : 404, explanation ?? { error: "metric_run_not_found" });
    } catch (error) {
      if (error instanceof AppNotFoundError) json(response, 404, { error: "app_not_found" });
      else throw error;
    }
    return;
  };

  const auditFraud = async ({ response, target, pool, identity }: AdminRequestContext): Promise<void> => {
    try {
      const query = parseFraudAuditQuery(target.searchParams);
      const appIdentity = await requireRegisteredApp(pool, identity, query.appId);
      const rows = await fraudAudit(pool, appIdentity, query);
      const encoded = encodeFraudAudit(rows, query.format);
      response.writeHead(200, {
        "content-type": encoded.contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(query.format === "csv" ? {
          "content-disposition": `attachment; filename="openmasu-fraud-${appIdentity.appId}-${query.from}-${query.to}.csv"`,
        } : {}),
      });
      response.end(encoded.body);
    } catch (error) {
      if (error instanceof AppNotFoundError) json(response, 404, { error: "app_not_found" });
      else if (error instanceof FraudAuditQueryError) json(response, 400, { error: error.message });
      else throw error;
    }
    return;
  };

  const reportMetrics = async ({ response, target, route, pool, identity }: AdminRequestContext): Promise<void> => {
    const appId = target.searchParams.get("app_id") ?? "";
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, appId);
      const parsed = parseMetricQuery({
        tenantId: appIdentity.tenantId,
        appId: appIdentity.appId,
        searchParams: target.searchParams,
        maximumRows: dependencies.reportMaximumRows,
        maximumExportRows: dependencies.reportMaximumExportRows,
        cursorKind: route.handler === "audit_differences"
          ? "difference"
          : route.handler === "report_records" ? "record" : "metric",
      });
      const format = parsed.format as ReportFormat;
      let encoded: { contentType: string; body: string };
      let first: { input_snapshot_id?: string } | undefined;
      let nextCursor: string | undefined;
      if (route.handler === "report_metrics") {
        const page = await metricReport(pool, appIdentity, parsed.query);
        encoded = encodeMetricReport(page, format);
        first = page.data[0];
        nextCursor = page.next_cursor;
      } else if (route.handler === "audit_differences") {
        const page = await differenceAudit(pool, appIdentity, parsed.query);
        encoded = encodeDifferenceAudit(page, format);
        first = page.data[0] as { input_snapshot_id?: string } | undefined;
        nextCursor = page.next_cursor;
      } else {
        const page = await recordCounts(pool, appIdentity, parsed.query);
        encoded = encodeRecordCounts(page, format);
        nextCursor = page.next_cursor;
      }
      if (parsed.export && nextCursor) {
        json(response, 400, { error: "export_limit_exceeded" });
        return;
      }
      const range = `${parsed.query.dateFrom ?? "all"}-${parsed.query.dateTo ?? "all"}`;
      const fileIdentity = route.handler === "report_records"
        ? "record-counts"
        : first?.input_snapshot_id?.slice(0, 8) ?? "empty";
      response.writeHead(200, {
        "content-type": encoded.contentType,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(!parsed.export && nextCursor ? { "x-next-cursor": nextCursor } : {}),
        ...(format === "csv" ? {
          "content-disposition": `attachment; filename="openmasu-${appIdentity.appId}-${range}-${fileIdentity}.csv"`,
        } : {}),
      });
      response.end(encoded.body);
    } catch (error) {
      if (error instanceof AppNotFoundError) {
        json(response, 404, { error: "app_not_found" });
      } else if (error instanceof ReportQueryError || (error instanceof Error && error.message === "watermark_required")) {
        json(response, 400, { error: error.message });
      } else {
        throw error;
      }
    }
    return;
  };

  return {
    dashboard_attribution_report: { boundary: "dashboard_app", handle: dashboardAttributionReport },
    dashboard_comparison_form: { boundary: "dashboard_app", handle: dashboardComparisonForm },
    dashboard_comparison_submit: { boundary: "dashboard_app", handle: dashboardComparisonForm },
    dashboard_metric_explanation: { boundary: "dashboard_app", handle: dashboardMetricExplanation },
    dashboard_fraud: { boundary: "dashboard_app", handle: dashboardFraud },
    dashboard_app: { boundary: "dashboard_app", handle: dashboardApp },
    dashboard_export: { boundary: "dashboard_app", handle: dashboardApp },
    dashboard_comparison_export: { boundary: "dashboard_app", handle: dashboardApp },
    dashboard_records: { boundary: "dashboard_app", handle: dashboardApp },
    dashboard_differences: { boundary: "dashboard_app", handle: dashboardApp },
    dashboard_tracking_links_list: { boundary: "dashboard_app", handle: dashboardApp },
    admin_attribution_report: { boundary: "admin", handle: adminAttributionReport },
    admin_metric_explanation: { boundary: "admin", handle: adminMetricExplanation },
    audit_fraud: { boundary: "admin", handle: auditFraud },
    report_metrics: { boundary: "admin", handle: reportMetrics },
    audit_differences: { boundary: "admin", handle: reportMetrics },
    report_records: { boundary: "admin", handle: reportMetrics },
  } as const;
}
