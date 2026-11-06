import { AppNotFoundError, requireRegisteredApp } from "../apps-admin.js";
import { configurationHistory, ConfigurationHistoryQueryError, parseConfigurationHistoryQuery } from "../configuration-history.js";
import { renderConfigurationHistory } from "../dashboard/configuration-history.js";
import { adminAppId } from "../http-paths.js";
import { json, dashboardHtml } from "../http-responses.js";
import type { AdminRequestContext, DashboardAppContext } from "./context.js";

export function createConfigurationHistoryControllers() {
  const admin = async ({ response, target, pool, identity }: AdminRequestContext) => {
    try {
      const app = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      json(response, 200, await configurationHistory(pool, app, parseConfigurationHistoryQuery(target.searchParams)));
    } catch (error) {
      json(response, error instanceof AppNotFoundError ? 404 : error instanceof ConfigurationHistoryQueryError ? 400 : 503,
        { error: error instanceof AppNotFoundError ? "app_not_found" : error instanceof ConfigurationHistoryQueryError ? error.message : "configuration_history_unavailable" });
    }
  };
  const dashboard = async ({ response, target, pool, appIdentity }: DashboardAppContext) => {
    try {
      const query = parseConfigurationHistoryQuery(target.searchParams);
      dashboardHtml(response, 200, renderConfigurationHistory(appIdentity.appId, await configurationHistory(pool, appIdentity, query), query.limit));
    } catch (error) {
      dashboardHtml(response, error instanceof ConfigurationHistoryQueryError ? 400 : 503,
        "<p>Configuration history could not be loaded. Return to the app and try the latest page.</p>");
    }
  };
  return {
    admin_configuration_history: { boundary: "admin", handle: admin },
    dashboard_configuration_history: { boundary: "dashboard_app", handle: dashboard },
  } as const;
}
