import { AppNotFoundError, requireRegisteredApp } from "../apps-admin.js";
import { EventCatalogError, listEventCatalog, parseEventCatalogQuery, saveEventCatalogRevision } from "../event-catalog.js";
import { eventCatalogFormRequest, renderEventCatalog } from "../dashboard/event-catalog.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { AdminRequestContext, DashboardAppContext } from "./context.js";
import { adminAppId } from "../http-paths.js";
import { dashboardHeaders, dashboardHtml, json } from "../http-responses.js";
import { authorizeDashboardForm } from "../http-security.js";
import { csrfToken } from "../session.js";
import { renderMetricScheduleOperationFailed } from "../dashboard/action-pages.js";

const failure = (error: unknown): { status: number; code: string } => error instanceof AppNotFoundError ? { status: 404, code: "not_found" }
  : error instanceof EventCatalogError ? error : error instanceof SyntaxError || error instanceof Error && error.message === "event_catalog_revision_invalid"
    ? { status: 400, code: "event_catalog_revision_invalid" } : { status: 503, code: "event_catalog_unavailable" };
export function createEventCatalogControllers(dependencies: Pick<RequestHandlerDependencies, "pool" | "readerPool" | "dashboard">) {
  const admin = async ({ response, target, route, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    try {
      const app = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      if (route.mutates) {
        if (target.searchParams.size) throw new EventCatalogError("event_catalog_query_invalid");
        json(response, 201, await saveEventCatalogRevision(pool, app, await decoder.json()));
      } else json(response, 200, await listEventCatalog(pool, app, parseEventCatalogQuery(target.searchParams)));
    } catch (error) { const result = failure(error); json(response, result.status, { error: result.code }); }
  };
  const dashboard = async ({ request, response, target, route, pool, session, appIdentity, decoder }: DashboardAppContext): Promise<void> => {
    try {
      if (route.mutates) {
        const form = await decoder.form();
        if (!await authorizeDashboardForm(dependencies, { request, response, session }, form, "event_catalog_revision", "app", appIdentity.appId)) return;
        if (target.searchParams.size) throw new EventCatalogError("event_catalog_query_invalid");
        const saved = await saveEventCatalogRevision(pool, appIdentity, eventCatalogFormRequest(form));
        response.writeHead(303, { ...dashboardHeaders, location: `/dashboard/apps/${encodeURIComponent(appIdentity.appId)}/event-catalog?prefix=${encodeURIComponent(saved.event_key)}` }).end();
      } else {
        const query = parseEventCatalogQuery(target.searchParams);
        dashboardHtml(response, 200, renderEventCatalog(appIdentity.appId, await listEventCatalog(pool, appIdentity, query), query, csrfToken(session.token)));
      }
    } catch (error) {
      const result = failure(error);
      dashboardHtml(response, result.status, renderMetricScheduleOperationFailed({ reason: result.code, appId: appIdentity.appId }));
    }
  };
  return {
    admin_event_catalog_list: { boundary: "admin" as const, handle: admin },
    admin_event_catalog_save: { boundary: "admin" as const, handle: admin },
    dashboard_event_catalog_list: { boundary: "dashboard_app" as const, handle: dashboard },
    dashboard_event_catalog_save: { boundary: "dashboard_app" as const, handle: dashboard },
  };
}
