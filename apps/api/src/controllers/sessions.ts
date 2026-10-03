import { listApps } from "../apps-admin.js";
import { verifyAdminKey } from "../admin-auth.js";
import { roleAllows } from "../authorization.js";
import { dashboardCss } from "../dashboard/css.js";
import { renderDashboard } from "../dashboard/render.js";
import { buildDashboardView } from "../dashboard/view.js";
import { clearDashboardSessionCookie, csrfToken, dashboardSessionCookie, issueDashboardSession, recordDashboardAudit, revokeDashboardSession } from "../session.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { HttpRequestContext } from "./context.js";
import { dashboardHtml } from "../http-responses.js";
import { sourceKey } from "../http-paths.js";
import { authorizeDashboardForm, dashboardSessionFor } from "../http-security.js";
import { dashboardHeaders } from "../http-responses.js";
import { loginPage } from "../dashboard/action-pages.js";
import { dashboardCssEtag } from "../http-responses.js";

export function createSessionsControllers(dependencies: Pick<RequestHandlerDependencies, "readerPool" | "dashboard" | "dashboardLoginBucket" | "dashboardLoginGlobalBucket" | "pool">) {
  const dashboardCssController = async ({ request, response }: HttpRequestContext): Promise<void> => {
    if (request.headers["if-none-match"] === dashboardCssEtag) {
      response.writeHead(304, { ...dashboardHeaders, etag: dashboardCssEtag, "cache-control": "no-cache" }).end();
      return;
    }
    response.writeHead(200, {
      ...dashboardHeaders,
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-cache",
      etag: dashboardCssEtag,
    });
    response.end(dashboardCss);
    return;
  };

  const dashboardRoot = async ({ request, response }: HttpRequestContext): Promise<void> => {
    const session = await dashboardSessionFor(dependencies, request);
    if (!session) {
      dashboardHtml(response, 200, loginPage());
      return;
    }
    const apps = await listApps(dependencies.readerPool, {
      keyId: session.adminKeyId,
      tenantId: session.tenantId,
      role: session.role,
    });
    dashboardHtml(response, 200, renderDashboard(buildDashboardView({
      apps,
      csrfToken: csrfToken(session.token),
      canOperate: roleAllows(session.role, "operate"),
      canAdminister: roleAllows(session.role, "administer"),
    })));
    return;
  };

  const dashboardLogin = async ({ request, response, pool, decoder }: HttpRequestContext): Promise<void> => {
    const allowed = (!dependencies.dashboardLoginBucket || dependencies.dashboardLoginBucket.allow(sourceKey(request)))
      && (!dependencies.dashboardLoginGlobalBucket || dependencies.dashboardLoginGlobalBucket.allow());
    if (!allowed) {
      response.writeHead(429, { ...dashboardHeaders, "retry-after": "60" }).end();
      return;
    }
    const body = await decoder.form();
    const key = body.get("admin_key") ?? "";
    const identity = await verifyAdminKey(dependencies.pool, dependencies.dashboard.tenantId, `Bearer ${key}`);
    if (!identity) {
      await recordDashboardAudit(dependencies.pool, {
        tenantId: dependencies.dashboard.tenantId,
        actorRef: "admin_key:unrecognized",
        action: "dashboard_login",
        targetScope: "session",
        targetRef: "session:unrecognized",
        outcome: "failed",
        reasonCode: "authentication_failed",
      });
      dashboardHtml(response, 401, loginPage("Authentication failed."));
      return;
    }
    const session = await issueDashboardSession(
      dependencies.pool,
      identity.tenantId,
      identity.keyId,
      dependencies.dashboard.sessionTtlSeconds,
    );
    await recordDashboardAudit(dependencies.pool, {
      tenantId: identity.tenantId,
      actorRef: `admin_key:${identity.keyId}`,
      action: "dashboard_login",
      targetScope: "session",
      targetRef: session.sessionId,
      outcome: "succeeded",
    });
    response.writeHead(303, {
      ...dashboardHeaders,
      location: "/dashboard",
      "set-cookie": dashboardSessionCookie(
        session.token,
        dependencies.dashboard.publicBaseUrl,
        dependencies.dashboard.sessionTtlSeconds,
      ),
    }).end();
    return;
  };

  const dashboardLogout = async ({ request, response, pool, decoder }: HttpRequestContext): Promise<void> => {
    const session = await dashboardSessionFor(dependencies, request);
    if (!session) {
      dashboardHtml(response, 401, loginPage("Authentication required."));
      return;
    }
    const body = await decoder.form();
    if (!await authorizeDashboardForm(dependencies, { request, response, session }, body, "dashboard_logout", "session", session.sessionId)) return;
    await revokeDashboardSession(dependencies.pool, session);
    await recordDashboardAudit(dependencies.pool, {
      tenantId: session.tenantId,
      actorRef: `admin_key:${session.adminKeyId}`,
      action: "dashboard_logout",
      targetScope: "session",
      targetRef: session.sessionId,
      outcome: "succeeded",
    });
    response.writeHead(303, {
      ...dashboardHeaders,
      location: "/dashboard",
      "set-cookie": clearDashboardSessionCookie(dependencies.dashboard.publicBaseUrl),
    }).end();
    return;
  };

  return {
    dashboard_css: { boundary: "session", handle: dashboardCssController },
    dashboard_root: { boundary: "session", handle: dashboardRoot },
    dashboard_login: { boundary: "session", handle: dashboardLogin },
    dashboard_logout: { boundary: "session", handle: dashboardLogout },
  } as const;
}
