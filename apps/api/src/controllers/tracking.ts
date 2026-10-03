import { AppNotFoundError, requireRegisteredApp } from "../apps-admin.js";
import { recordDashboardAudit } from "../session.js";
import { createTrackingLink, listTrackingLinks, transitionTrackingLink } from "../tracking-links.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { DashboardAppContext, AdminRequestContext } from "./context.js";
import { json, dashboardHtml } from "../http-responses.js";
import { adminAppId, trackingLinkAction, publicReason, measurementLink, listedTrackingLink } from "../http-paths.js";
import { authorizeDashboardForm } from "../http-security.js";
import { dashboardHeaders } from "../http-responses.js";
import { renderTrackingLinkTransitionFailed, renderTrackingLinkCreated, renderTrackingLinkCreationFailed } from "../dashboard/action-pages.js";

export function createTrackingControllers(dependencies: Pick<RequestHandlerDependencies, "pool" | "dashboard" | "trackingDestinationAllowlist" | "referrerMaximumEncodedCharacters" | "redirectorBaseUrl">) {
  const dashboardTrackingLinkTransition = async ({ request, response, target, pool, session, appId, appIdentity, decoder }: DashboardAppContext): Promise<void> => {
    const body = await decoder.form();
    const action = trackingLinkAction(target.pathname);
    if (!await authorizeDashboardForm(dependencies, { request, response, session }, body, "dashboard_tracking_link_transition", "tracking_link", action?.trackingLinkId ?? "tracking_link:unrecognized")) return;
    try {
      if (!action) throw new Error("tracking_link_action_invalid");
      await transitionTrackingLink({
        pool: dependencies.pool, tenantId: appIdentity.tenantId, appId: appIdentity.appId,
        trackingLinkId: action.trackingLinkId, status: action.status,
        actorRef: `admin_key:${session.adminKeyId}`,
      });
      response.writeHead(303, { ...dashboardHeaders, location: `/dashboard/apps/${encodeURIComponent(appIdentity.appId)}/tracking-links` }).end();
    } catch (error) {
      const reason = publicReason(error, "tracking_link_transition_failed");
      await recordDashboardAudit(dependencies.pool, {
        tenantId: appIdentity.tenantId, appId: appIdentity.appId,
        actorRef: `admin_key:${session.adminKeyId}`, action: "tracking_link_transition",
        targetScope: "tracking_link", targetRef: action?.trackingLinkId ?? "tracking_link:unrecognized",
        outcome: "failed", reasonCode: reason,
      });
      dashboardHtml(response, reason === "tracking_link_not_found" ? 404 : 409, renderTrackingLinkTransitionFailed({ reason: reason }));
    }
    return;
  };

  const dashboardTrackingLinksCreate = async ({ request, response, pool, session, appId, appIdentity, decoder }: DashboardAppContext): Promise<void> => {
    const body = await decoder.form();
    if (!await authorizeDashboardForm(dependencies, { request, response, session }, body, "dashboard_tracking_link_create", "tracking_link", "tracking_link:unrecognized")) return;
    try {
      const result = await createTrackingLink({
        pool: dependencies.pool,
        tenantId: appIdentity.tenantId,
        appId: appIdentity.appId,
        actorRef: `admin_key:${session.adminKeyId}`,
        allowedOrigins: dependencies.trackingDestinationAllowlist ?? [],
        referrerMaximumEncodedCharacters: dependencies.referrerMaximumEncodedCharacters,
        body: Object.fromEntries(body),
      });
      const link = measurementLink(dependencies.redirectorBaseUrl, result.slug);
      dashboardHtml(response, 201, renderTrackingLinkCreated({ appId: appIdentity.appId, link: link, destinationUrl: result.destination_url }));
    } catch (error) {
      dashboardHtml(response, 400, renderTrackingLinkCreationFailed({ reason: error instanceof Error ? error.message : "tracking_link_invalid" }));
    }
    return;
  };

  const adminTrackingLinks = async ({ request, response, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    try {
      const body = await decoder.json();
      const appIdentity = await requireRegisteredApp(dependencies.pool, identity, String(body.app_id ?? ""));
      const result = await createTrackingLink({
        pool: dependencies.pool,
        tenantId: appIdentity.tenantId,
        appId: appIdentity.appId,
        actorRef: `admin_key:${identity.keyId}`,
        allowedOrigins: dependencies.trackingDestinationAllowlist ?? [],
        referrerMaximumEncodedCharacters: dependencies.referrerMaximumEncodedCharacters,
        body,
      });
      json(response, 201, result);
    } catch (error) {
      const status = error instanceof Error && error.message === "app_not_found" ? 404 : 400;
      json(response, status, { error: status === 404 ? "app_not_found" : error instanceof Error ? error.message : "tracking_link_invalid" });
    }
    return;
  };

  const adminTrackingLinkTransition = async ({ response, target, pool, identity }: AdminRequestContext): Promise<void> => {
    try {
      const appIdentity = await requireRegisteredApp(dependencies.pool, identity, adminAppId(target.pathname) ?? "");
      const action = trackingLinkAction(target.pathname);
      if (!action) throw new Error("tracking_link_action_invalid");
      json(response, 200, await transitionTrackingLink({
        pool: dependencies.pool, tenantId: appIdentity.tenantId, appId: appIdentity.appId,
        trackingLinkId: action.trackingLinkId, status: action.status,
        actorRef: `admin_key:${identity.keyId}`,
      }));
    } catch (error) {
      if (error instanceof AppNotFoundError || (error instanceof Error && error.message === "tracking_link_not_found")) {
        json(response, 404, { error: "not_found" });
      } else {
        const reason = publicReason(error, "tracking_link_transition_failed");
        const appId = adminAppId(target.pathname) ?? "";
        const action = trackingLinkAction(target.pathname);
        await recordDashboardAudit(dependencies.pool, {
          tenantId: identity.tenantId, appId,
          actorRef: `admin_key:${identity.keyId}`, action: "tracking_link_transition",
          targetScope: "tracking_link", targetRef: action?.trackingLinkId ?? "tracking_link:unrecognized",
          outcome: "failed", reasonCode: reason,
        });
        json(response, 409, { error: reason });
      }
    }
    return;
  };

  const adminTrackingLinksList = async ({ response, target, pool, identity }: AdminRequestContext): Promise<void> => {
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, target.searchParams.get("app_id") ?? "");
      const data = (await listTrackingLinks(pool, appIdentity.tenantId, appIdentity.appId))
        .map((link) => listedTrackingLink(dependencies.redirectorBaseUrl, link));
      json(response, 200, { data });
    } catch (error) {
      if (error instanceof AppNotFoundError) json(response, 404, { error: "app_not_found" });
      else throw error;
    }
    return;
  };

  return {
    dashboard_tracking_link_transition: { boundary: "dashboard_app", handle: dashboardTrackingLinkTransition },
    dashboard_tracking_links_create: { boundary: "dashboard_app", handle: dashboardTrackingLinksCreate },
    admin_tracking_links: { boundary: "admin", handle: adminTrackingLinks },
    admin_tracking_link_transition: { boundary: "admin", handle: adminTrackingLinkTransition },
    admin_tracking_links_list: { boundary: "admin", handle: adminTrackingLinksList },
  } as const;
}
