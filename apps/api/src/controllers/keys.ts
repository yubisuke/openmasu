import { AppNotFoundError, requireRegisteredApp } from "../apps-admin.js";
import { recordDashboardAudit } from "../session.js";
import { issueSdkKey, listSdkKeys, retireSdkKey } from "../sdk-auth.js";
import { issueServerKey, listServerKeys, retireServerKey } from "../server-auth.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { DashboardAppContext, AdminRequestContext } from "./context.js";
import { json, dashboardHtml } from "../http-responses.js";
import { adminAppId, sdkKeyId, serverKeyId, publicReason } from "../http-paths.js";
import { authorizeDashboardForm } from "../http-security.js";
import { dashboardHeaders } from "../http-responses.js";
import { renderIssuedSdkKey, renderSDKKeyOperationFailed, renderServerKeyIssued, renderServerKeyOperationFailed } from "../dashboard/action-pages.js";

export function createKeysControllers(dependencies: Pick<RequestHandlerDependencies, "pool" | "payloadStore" | "dashboard">) {
  const dashboardSdkKeysIssue = async ({ request, response, target, route, pool, session, appId, appIdentity, decoder }: DashboardAppContext): Promise<void> => {
    const body = await decoder.form();
    const targetKeyId = sdkKeyId(target.pathname);
    if (!await authorizeDashboardForm(dependencies, { request, response, session }, body, "dashboard_sdk_key_mutation", "sdk_key", targetKeyId ?? "sdk_key:new")) return;
    try {
      if (route.handler === "dashboard_sdk_keys_issue") {
        const platform = body.get("platform");
        if (platform !== "android" && platform !== "ios") throw new Error("sdk_platform_invalid");
        const issued = await issueSdkKey({
          pool: dependencies.pool, payloadStore: dependencies.payloadStore,
          scope: appIdentity, platform, actorRef: `admin_key:${session.adminKeyId}`,
        });
        dashboardHtml(response, 201, renderIssuedSdkKey({ sdkKeyId: issued.sdk_key_id, sdkKey: issued.sdk_key, platform: issued.platform, appId: appIdentity.appId }));
      } else {
        if (!targetKeyId) throw new Error("sdk_key_not_found");
        const retired = await retireSdkKey({
          pool: dependencies.pool, scope: appIdentity, sdkKeyId: targetKeyId,
          actorRef: `admin_key:${session.adminKeyId}`,
        });
        response.writeHead(303, { ...dashboardHeaders, location: `/dashboard/apps/${encodeURIComponent(appIdentity.appId)}` }).end();
      }
    } catch (error) {
      const reason = publicReason(error, "sdk_key_lifecycle_failed");
      await recordDashboardAudit(dependencies.pool, {
        tenantId: appIdentity.tenantId, appId: appIdentity.appId,
        actorRef: `admin_key:${session.adminKeyId}`, action: "sdk_key_lifecycle",
        targetScope: "sdk_key", targetRef: targetKeyId ?? "sdk_key:new",
        outcome: "failed", reasonCode: reason,
      });
      dashboardHtml(response, reason === "sdk_key_not_found" ? 404 : 409, renderSDKKeyOperationFailed({ reason: reason }));
    }
    return;
  };

  const dashboardServerKeysIssue = async ({ request, response, target, route, pool, session, appId, appIdentity, decoder }: DashboardAppContext): Promise<void> => {
    const body = await decoder.form();
    const targetKeyId = serverKeyId(target.pathname);
    if (!await authorizeDashboardForm(dependencies, { request, response, session }, body, "dashboard_server_key_mutation", "server_key", targetKeyId ?? "server_key:new")) return;
    try {
      if (route.handler === "dashboard_server_keys_issue") {
        const issued = await issueServerKey({
          pool: dependencies.pool,
          payloadStore: dependencies.payloadStore,
          scope: appIdentity,
          producer: body.get("producer") ?? undefined,
          actorRef: `admin_key:${session.adminKeyId}`,
        });
        dashboardHtml(response, 201, renderServerKeyIssued({ serverKeyId: issued.server_key_id, serverKey: issued.server_key, producer: issued.producer, appId: appIdentity.appId }));
      } else {
        if (!targetKeyId) throw new Error("server_key_not_found");
        await retireServerKey({
          pool: dependencies.pool,
          payloadStore: dependencies.payloadStore,
          scope: appIdentity,
          serverKeyId: targetKeyId,
          actorRef: `admin_key:${session.adminKeyId}`,
        });
        response.writeHead(303, { ...dashboardHeaders, location: `/dashboard/apps/${encodeURIComponent(appIdentity.appId)}` }).end();
      }
    } catch (error) {
      const reason = publicReason(error, "server_key_lifecycle_failed");
      await recordDashboardAudit(dependencies.pool, {
        tenantId: appIdentity.tenantId, appId: appIdentity.appId,
        actorRef: `admin_key:${session.adminKeyId}`, action: "server_key_lifecycle",
        targetScope: "server_key", targetRef: targetKeyId ?? "server_key:new",
        outcome: "failed", reasonCode: reason,
      });
      dashboardHtml(response, reason === "server_key_not_found" ? 404 : 409, renderServerKeyOperationFailed({ reason: reason }));
    }
    return;
  };

  const adminSdkKeysList = async ({ request, response, target, route, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    const appId = adminAppId(target.pathname) ?? "";
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, appId);
      if (route.handler === "admin_sdk_keys_list") {
        json(response, 200, { data: await listSdkKeys(pool, appIdentity) });
        return;
      }
      if (route.handler === "admin_sdk_keys_issue") {
        const body = await decoder.json();
        const platform = body.platform;
        if (platform !== "android" && platform !== "ios") throw new Error("sdk_platform_invalid");
        const issued = await issueSdkKey({
          pool: dependencies.pool, payloadStore: dependencies.payloadStore,
          scope: appIdentity, platform, actorRef: `admin_key:${identity.keyId}`,
        });
        json(response, 201, issued);
        return;
      }
      const targetKeyId = sdkKeyId(target.pathname);
      if (!targetKeyId) throw new Error("sdk_key_not_found");
      const retired = await retireSdkKey({
        pool: dependencies.pool, scope: appIdentity, sdkKeyId: targetKeyId,
        actorRef: `admin_key:${identity.keyId}`,
      });
      json(response, 200, retired);
    } catch (error) {
      if (error instanceof AppNotFoundError || (error instanceof Error && error.message === "sdk_key_not_found")) {
        json(response, 404, { error: "not_found" });
      } else {
        const reason = publicReason(error, "sdk_key_lifecycle_failed");
        await recordDashboardAudit(dependencies.pool, {
          tenantId: identity.tenantId, appId,
          actorRef: `admin_key:${identity.keyId}`, action: "sdk_key_lifecycle",
          targetScope: "sdk_key", targetRef: sdkKeyId(target.pathname) ?? "sdk_key:new",
          outcome: "failed", reasonCode: reason,
        });
        json(response, 409, { error: reason });
      }
    }
    return;
  };

  const adminServerKeysList = async ({ request, response, target, route, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    const appId = adminAppId(target.pathname) ?? "";
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, appId);
      if (route.handler === "admin_server_keys_list") {
        json(response, 200, { data: await listServerKeys(pool, appIdentity) });
        return;
      }
      if (route.handler === "admin_server_keys_issue") {
        const body = await decoder.json();
        json(response, 201, await issueServerKey({
          pool: dependencies.pool,
          payloadStore: dependencies.payloadStore,
          scope: appIdentity,
          producer: body.producer === undefined ? undefined : String(body.producer),
          actorRef: `admin_key:${identity.keyId}`,
        }));
        return;
      }
      const targetKeyId = serverKeyId(target.pathname);
      if (!targetKeyId) throw new Error("server_key_not_found");
      json(response, 200, await retireServerKey({
        pool: dependencies.pool,
        payloadStore: dependencies.payloadStore,
        scope: appIdentity,
        serverKeyId: targetKeyId,
        actorRef: `admin_key:${identity.keyId}`,
      }));
    } catch (error) {
      if (error instanceof AppNotFoundError || (error instanceof Error && error.message === "server_key_not_found")) {
        json(response, 404, { error: "not_found" });
      } else {
        const reason = publicReason(error, "server_key_lifecycle_failed");
        await recordDashboardAudit(dependencies.pool, {
          tenantId: identity.tenantId, appId,
          actorRef: `admin_key:${identity.keyId}`, action: "server_key_lifecycle",
          targetScope: "server_key", targetRef: serverKeyId(target.pathname) ?? "server_key:new",
          outcome: "failed", reasonCode: reason,
        });
        json(response, 409, { error: reason });
      }
    }
    return;
  };

  return {
    dashboard_sdk_keys_issue: { boundary: "dashboard_app", handle: dashboardSdkKeysIssue },
    dashboard_sdk_keys_retire: { boundary: "dashboard_app", handle: dashboardSdkKeysIssue },
    dashboard_server_keys_issue: { boundary: "dashboard_app", handle: dashboardServerKeysIssue },
    dashboard_server_keys_retire: { boundary: "dashboard_app", handle: dashboardServerKeysIssue },
    admin_sdk_keys_list: { boundary: "admin", handle: adminSdkKeysList },
    admin_sdk_keys_issue: { boundary: "admin", handle: adminSdkKeysList },
    admin_sdk_keys_retire: { boundary: "admin", handle: adminSdkKeysList },
    admin_server_keys_list: { boundary: "admin", handle: adminServerKeysList },
    admin_server_keys_issue: { boundary: "admin", handle: adminServerKeysList },
    admin_server_keys_retire: { boundary: "admin", handle: adminServerKeysList },
  } as const;
}
