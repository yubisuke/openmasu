import type { RequestHandlerDependencies } from "../http-types.js";
import { routes, type RouteHandler } from "../routes.js";
import type { RegisteredController } from "./context.js";
import { createReceiversControllers } from "./receivers.js";
import { createSessionsControllers } from "./sessions.js";
import { createAppsControllers } from "./apps.js";
import { createMetricJobsControllers } from "./metric-jobs.js";
import { createReportsControllers } from "./reports.js";
import { createTrackingControllers } from "./tracking.js";
import { createKeysControllers } from "./keys.js";
import { createOperationsControllers } from "./operations.js";
import { createPrivacyControllers } from "./privacy.js";

export type HandlerRegistry = Readonly<Record<RouteHandler, RegisteredController>>;

/** Aliased paths share one implementation; missing declarations are a startup error. */
export function assertHandlerRegistry(registry: Readonly<Partial<Record<RouteHandler, RegisteredController>>>): asserts registry is HandlerRegistry {
  for (const route of routes) {
    const controller = registry[route.handler];
    if (!controller) throw new Error(`route_handler_missing:${route.handler}`);
    const boundary = controller.boundary;
    const sessionRoute = ["dashboard_css", "dashboard_root", "dashboard_login", "dashboard_logout"].includes(route.handler);
    const tenantRoute = ["dashboard_apps_create", "dashboard_link_domain"].includes(route.handler);
    const valid = sessionRoute ? boundary === "session"
      : route.auth === "admin_bearer" ? boundary === "admin"
      : route.auth === "dashboard_session" ? boundary === (tenantRoute ? "dashboard_tenant" : "dashboard_app")
      : boundary === "receiver";
    if (!valid) throw new Error(`route_security_boundary_mismatch:${route.handler}`);
  }
}

export function createHandlerRegistry(dependencies: RequestHandlerDependencies): HandlerRegistry {
  const registry = {
    ...createReceiversControllers({ maxConfig: dependencies.maxConfig, maxBucket: dependencies.maxBucket, pool: dependencies.pool, payloadStore: dependencies.payloadStore, applePostback: dependencies.applePostback, googlePlayRtdn: dependencies.googlePlayRtdn, appleStoreNotifications: dependencies.appleStoreNotifications, sdk: dependencies.sdk, server: dependencies.server }),
    ...createSessionsControllers({ readerPool: dependencies.readerPool, dashboard: dependencies.dashboard, dashboardLoginBucket: dependencies.dashboardLoginBucket, dashboardLoginGlobalBucket: dependencies.dashboardLoginGlobalBucket, pool: dependencies.pool }),
    ...createAppsControllers({ pool: dependencies.pool, payloadStore: dependencies.payloadStore, publicBaseUrl: dependencies.publicBaseUrl, redirectorBaseUrl: dependencies.redirectorBaseUrl, dashboard: dependencies.dashboard }),
    ...createMetricJobsControllers({ readerPool: dependencies.readerPool, pool: dependencies.pool, dashboard: dependencies.dashboard }),
    ...createReportsControllers({ readerPool: dependencies.readerPool, dashboard: dependencies.dashboard, reportMaximumRows: dependencies.reportMaximumRows, reportMaximumExportRows: dependencies.reportMaximumExportRows, redirectorBaseUrl: dependencies.redirectorBaseUrl }),
    ...createTrackingControllers({ pool: dependencies.pool, dashboard: dependencies.dashboard, trackingDestinationAllowlist: dependencies.trackingDestinationAllowlist, referrerMaximumEncodedCharacters: dependencies.referrerMaximumEncodedCharacters, redirectorBaseUrl: dependencies.redirectorBaseUrl }),
    ...createKeysControllers({ pool: dependencies.pool, payloadStore: dependencies.payloadStore, dashboard: dependencies.dashboard }),
    ...createOperationsControllers({ operatorWebhooks: dependencies.operatorWebhooks, pool: dependencies.pool, payloadStore: dependencies.payloadStore, dashboard: dependencies.dashboard, operatorBulkExports: dependencies.operatorBulkExports, operationalMetrics: dependencies.operationalMetrics, readerPool: dependencies.readerPool }),
    ...createPrivacyControllers({ pool: dependencies.pool, privacySubjectDigestKey: dependencies.privacySubjectDigestKey, server: dependencies.server, sdk: dependencies.sdk, payloadStore: dependencies.payloadStore }),
  } satisfies HandlerRegistry;
  assertHandlerRegistry(registry);
  return registry;
}
