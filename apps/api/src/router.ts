import type { RequestListener } from "node:http";
import { AppNotFoundError, requireRegisteredApp } from "./apps-admin.js";
import { roleAllows } from "./authorization.js";
import { ComparisonExportError } from "./comparison-export.js";
import { createHandlerRegistry } from "./controllers/registry.js";
import type { DashboardTenantContext, HttpRequestContext } from "./controllers/context.js";
import { loginPage, renderAppNotFound, renderForbidden, renderInvalidFilter } from "./dashboard/action-pages.js";
import { dashboardAppId } from "./http-paths.js";
import { createRequestDecoder, dashboardHtml, json } from "./http-responses.js";
import { adminIdentity, dashboardSessionFor, routePool } from "./http-security.js";
import type { RequestHandlerDependencies } from "./http-types.js";
import { boundedMethod, writeOperationalLog } from "./observability.js";
import { ReportQueryError } from "./report-query.js";
import { matchRoute, type RouteDefinition } from "./routes.js";
import { assertDashboardBaseUrl } from "./session.js";

export { dashboardHeaders } from "./http-responses.js";
export type { DashboardConfig, RequestHandlerDependencies } from "./http-types.js";

/** HTTP/security composition only. Feature controllers own their response adapters. */
export function createRequestHandler(dependencies: RequestHandlerDependencies): RequestListener {
  assertDashboardBaseUrl(dependencies.dashboard.enabled, dependencies.dashboard.publicBaseUrl);
  const controllers = createHandlerRegistry(dependencies);
  return (request, response) => {
    const startedAt = performance.now();
    let routeLabel: RouteDefinition["handler"] | "unmatched" = "unmatched";
    let internalError = false;
    void (async () => {
      const target = new URL(request.url ?? "/", "http://openmasu.local");
      const route = matchRoute(request.method, target.pathname);
      routeLabel = route?.handler ?? "unmatched";
      if (!route || (!dependencies.dashboard.enabled && route.handler.startsWith("dashboard_"))) {
        json(response, 404, { error: "not_found" });
        return;
      }
      const pool = routePool(dependencies, route);
      const context: HttpRequestContext = { request, response, target, route, pool, startedAt, decoder: createRequestDecoder(request) };
      const controller = controllers[route.handler];
      if (controller.boundary === "receiver" || controller.boundary === "session") {
        await controller.handle(context);
        return;
      }
      if (controller.boundary === "admin") {
        if (dependencies.adminBucket && !dependencies.adminBucket.allow()) {
          response.writeHead(429, { "retry-after": "1", "cache-control": "no-store" }).end();
          return;
        }
        // Verifier hashes are not readable by the reader role. Authentication
        // uses the app pool; the declaration still selects the feature pool.
        const identity = await adminIdentity(dependencies, request, dependencies.pool);
        if (!identity) {
          json(response, 401, { error: "unauthorized" });
          return;
        }
        if (!roleAllows(identity.role, route.capability)) {
          json(response, 403, { error: "forbidden" });
          return;
        }
        await controller.handle({ ...context, identity });
        return;
      }
      const session = await dashboardSessionFor(dependencies, request);
      if (!session) {
        dashboardHtml(response, 401, loginPage("Authentication required."));
        return;
      }
      if (!roleAllows(session.role, route.capability)) {
        dashboardHtml(response, 403, renderForbidden());
        return;
      }
      const dashboardContext: DashboardTenantContext = {
        ...context, session,
        sessionIdentity: { keyId: session.adminKeyId, tenantId: session.tenantId, role: session.role },
      };
      if (controller.boundary === "dashboard_tenant") {
        await controller.handle(dashboardContext);
        return;
      }
      const appId = dashboardAppId(target.pathname) ?? "";
      try {
        const appIdentity = await requireRegisteredApp(dependencies.readerPool, dashboardContext.sessionIdentity, appId);
        await controller.handle({ ...dashboardContext, appId, appIdentity });
      } catch (error) {
        if (error instanceof AppNotFoundError) {
          dashboardHtml(response, 404, renderAppNotFound());
        } else if (error instanceof ReportQueryError || error instanceof ComparisonExportError || (error instanceof Error && error.message === "watermark_required")) {
          dashboardHtml(response, 400, renderInvalidFilter({ reason: error.message }));
        } else {
          throw error;
        }
      }
    })().catch(() => {
      internalError = true;
      if (!response.headersSent) json(response, 500, { error: "internal_error" });
      else response.end();
    }).finally(() => {
      const durationMs = Math.max(0, performance.now() - startedAt);
      if (routeLabel !== "operational_metrics") {
        dependencies.operationalMetrics?.observe(routeLabel, request.method, response.statusCode, durationMs);
      }
      if (dependencies.operationalLogWriter) {
        writeOperationalLog({
          event: "http_request",
          component: "api",
          route: routeLabel,
          method: boundedMethod(request.method),
          status: response.statusCode,
          duration_ms: Number(durationMs.toFixed(3)),
          ...(internalError ? { error_code: "internal_error" as const } : {}),
        }, dependencies.operationalLogWriter);
      }
    });
  };
}
