import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import { verifyAdminKey, type AdminIdentity } from "./admin-auth.js";
import { type RouteDefinition } from "./routes.js";
import { recordDashboardAudit, verifyCsrfToken, verifyDashboardSession, type DashboardSession } from "./session.js";
import type { RequestHandlerDependencies } from "./http-types.js";
import { dashboardHtml } from "./http-responses.js";
import { renderForbidden } from "./dashboard/action-pages.js";

export function authorization(request: IncomingMessage): string | undefined {
  return typeof request.headers.authorization === "string" ? request.headers.authorization : undefined;
}

export async function adminIdentity(
  dependencies: Pick<RequestHandlerDependencies, "dashboard">,
  request: IncomingMessage,
  pool: Pool,
): Promise<AdminIdentity | undefined> {
  return verifyAdminKey(pool, dependencies.dashboard.tenantId, authorization(request));
}

export function routePool(dependencies: Pick<RequestHandlerDependencies, "pool" | "readerPool">, route: RouteDefinition): Pool {
  return route.mutates ? dependencies.pool : dependencies.readerPool;
}

export function csrfOriginAccepted(request: IncomingMessage, publicBaseUrl: string): boolean {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  return !origin || origin === new URL(publicBaseUrl).origin;
}

export async function dashboardSessionFor(
  dependencies: Pick<RequestHandlerDependencies, "readerPool" | "dashboard">,
  request: IncomingMessage,
): Promise<DashboardSession | undefined> {
  return verifyDashboardSession(
    dependencies.readerPool,
    dependencies.dashboard.tenantId,
    request.headers.cookie,
    dependencies.dashboard.publicBaseUrl,
  );
}

export async function rejectDashboardCsrf(
  dependencies: Pick<RequestHandlerDependencies, "pool">,
  response: ServerResponse,
  session: DashboardSession,
  action: string,
  targetScope: "tenant" | "app" | "session" | "tracking_link" | "sdk_key" | "server_key" | "webhook_destination" | "bulk_export_destination",
  targetRef: string,
): Promise<void> {
  await recordDashboardAudit(dependencies.pool, {
    tenantId: session.tenantId,
    actorRef: `admin_key:${session.adminKeyId}`,
    action,
    targetScope,
    targetRef,
    outcome: "failed",
    reasonCode: "csrf_rejected",
  });
  dashboardHtml(response, 403, renderForbidden());
}

export async function authorizeDashboardForm(
  dependencies: Pick<RequestHandlerDependencies, "pool" | "dashboard">,
  context: { request: IncomingMessage; response: ServerResponse; session: DashboardSession },
  body: URLSearchParams,
  action: string,
  targetScope: Parameters<typeof rejectDashboardCsrf>[4],
  targetRef: string,
): Promise<boolean> {
  if (!csrfOriginAccepted(context.request, dependencies.dashboard.publicBaseUrl)
      || !verifyCsrfToken(context.session.token, body.get("csrf_token") ?? undefined)) {
    await rejectDashboardCsrf(dependencies, context.response, context.session, action, targetScope, targetRef);
    return false;
  }
  return true;
}
