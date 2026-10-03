import { registerAppleApp, registerConversionSchema } from "../apple-admin.js";
import { AppNotFoundError, listApps, registerApp, requireRegisteredApp } from "../apps-admin.js";
import { activateRuleBundle } from "../rule-bundles.js";
import { recordDashboardAudit } from "../session.js";
import { registerAppLinkIdentity, registerLinkDomain } from "../link-domains.js";
import { configureGoogleDataManagerDestination } from "../google-data-manager-admin.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { DashboardTenantContext, DashboardAppContext, AdminRequestContext } from "./context.js";
import { json, dashboardHtml } from "../http-responses.js";
import { adminAppId, sdkKeyId, jsonFormValue, publicReason } from "../http-paths.js";
import { authorizeDashboardForm } from "../http-security.js";
import { dashboardHeaders } from "../http-responses.js";
import { renderRegisteredAppKey, renderAppRegistrationFailed, renderLinkDomainRegistrationFailed, renderConfigurationFailed } from "../dashboard/action-pages.js";

export function createAppsControllers(dependencies: Pick<RequestHandlerDependencies, "pool" | "payloadStore" | "publicBaseUrl" | "redirectorBaseUrl" | "dashboard">) {
  const dashboardAppsCreate = async ({ request, response, pool, session, sessionIdentity, decoder }: DashboardTenantContext): Promise<void> => {
    const body = await decoder.form();
    const appId = body.get("app_id") ?? "";
    if (!await authorizeDashboardForm(dependencies, { request, response, session }, body, "dashboard_app_register", "app", appId || "app:unrecognized")) return;
    try {
      const issued = await registerApp({
        pool: dependencies.pool,
        payloadStore: dependencies.payloadStore,
        identity: sessionIdentity,
        appId,
        publicBaseUrl: dependencies.publicBaseUrl,
        redirectorBaseUrl: dependencies.redirectorBaseUrl,
      });
      dashboardHtml(response, 201, renderRegisteredAppKey({ appId: issued.app_id, sdkKeyId: issued.sdk_key_id, sdkKey: issued.sdk_key }));
    } catch (error) {
      const status = error instanceof Error && error.message === "app_already_registered" ? 409 : 400;
      dashboardHtml(response, status, renderAppRegistrationFailed({ reason: error instanceof Error ? error.message : "invalid_request" }));
    }
    return;
  };

  const dashboardLinkDomain = async ({ request, response, pool, session, sessionIdentity, decoder }: DashboardTenantContext): Promise<void> => {
    const body = await decoder.form();
    const host = body.get("host") ?? "";
    if (!await authorizeDashboardForm(dependencies, { request, response, session }, body, "dashboard_link_domain_register", "tenant", session.tenantId)) return;
    try {
      await registerLinkDomain({ pool: dependencies.pool, identity: sessionIdentity, host });
      response.writeHead(303, { ...dashboardHeaders, location: "/dashboard" }).end();
    } catch (error) {
      await recordDashboardAudit(dependencies.pool, {
        tenantId: session.tenantId, actorRef: `admin_key:${session.adminKeyId}`,
        action: "link_domain_registered", targetScope: "tenant", targetRef: host || "host:unrecognized",
        outcome: "failed", reasonCode: error instanceof Error ? error.message : "link_domain_invalid",
      });
      dashboardHtml(response, 400, renderLinkDomainRegistrationFailed({ reason: error instanceof Error ? error.message : "link_domain_invalid" }));
    }
    return;
  };

  const dashboardAppLinkIdentity = async ({ request, response, route, pool, session, appId, appIdentity, decoder }: DashboardAppContext): Promise<void> => {
    const body = await decoder.form();
    if (!await authorizeDashboardForm(dependencies, { request, response, session }, body, "dashboard_configuration", "app", appIdentity.appId)) return;
    const form = Object.fromEntries(body);
    try {
      if (route.handler === "dashboard_app_link_identity") {
        await registerAppLinkIdentity({
          pool: dependencies.pool, identity: appIdentity,
          body: {
            ...(form.android_package_name ? { android_package_name: form.android_package_name } : {}),
            ...(form.android_sha256_fingerprints ? { android_sha256_fingerprints: form.android_sha256_fingerprints.split(",").map((value) => value.trim()).filter(Boolean) } : {}),
            ...(form.apple_team_id ? { apple_team_id: form.apple_team_id } : {}),
            ...(form.apple_bundle_id ? { apple_bundle_id: form.apple_bundle_id } : {}),
          },
        });
      } else if (route.handler === "dashboard_apple_registration") {
        await registerAppleApp({ pool: dependencies.pool, identity: appIdentity,
          appleAppAdamId: form.apple_app_adam_id, appleBundleId: form.apple_bundle_id || undefined });
      } else if (route.handler === "dashboard_conversion_schema") {
        await registerConversionSchema({ pool: dependencies.pool, identity: appIdentity,
          schemaVersion: form.schema_version, definition: jsonFormValue(body, "definition_json") });
      } else if (route.handler === "dashboard_rule_bundle") {
        await activateRuleBundle({ pool: dependencies.pool, identity: appIdentity, body: jsonFormValue(body, "definition_json") as Record<string, unknown> });
      } else {
        await configureGoogleDataManagerDestination({ pool: dependencies.pool, identity: appIdentity, body: {
          operating_account_id: form.operating_account_id,
          conversion_action_id: form.conversion_action_id,
          enabled: form.enabled === "true",
          app_audience: form.app_audience,
        } });
      }
      response.writeHead(303, { ...dashboardHeaders, location: `/dashboard/apps/${encodeURIComponent(appIdentity.appId)}` }).end();
    } catch (error) {
      const reason = publicReason(error, "admin_configuration_invalid");
      await recordDashboardAudit(dependencies.pool, {
        tenantId: appIdentity.tenantId, appId: appIdentity.appId,
        actorRef: `admin_key:${session.adminKeyId}`, action: "dashboard_configuration",
        targetScope: "app", targetRef: appIdentity.appId,
        outcome: "failed", reasonCode: reason,
      });
      dashboardHtml(response, 400, renderConfigurationFailed({ reason: reason }));
    }
    return;
  };

  const adminAppsList = async ({ response, pool, identity }: AdminRequestContext): Promise<void> => {
    json(response, 200, { data: await listApps(pool, identity) });
    return;
  };

  const adminAppsCreate = async ({ request, response, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    try {
      const body = await decoder.json();
      const sdkPlatform = body.sdk_platform === undefined ? "android" : body.sdk_platform;
      if (sdkPlatform !== "android" && sdkPlatform !== "ios") throw new Error("sdk_platform_invalid");
      const result = await registerApp({
        pool: dependencies.pool,
        payloadStore: dependencies.payloadStore,
        identity,
        appId: String(body.app_id ?? ""),
        sdkPlatform,
        publicBaseUrl: dependencies.publicBaseUrl,
        redirectorBaseUrl: dependencies.redirectorBaseUrl,
      });
      json(response, 201, result);
    } catch (error) {
      json(response, error instanceof Error && error.message === "app_already_registered" ? 409 : 400, {
        error: error instanceof Error ? error.message : "app_registration_failed",
      });
    }
    return;
  };

  const adminLinkDomain = async ({ request, response, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    try {
      const body = await decoder.json();
      json(response, 201, await registerLinkDomain({ pool: dependencies.pool, identity, host: String(body.host ?? "") }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "link_domain_invalid";
      json(response, message.endsWith("already_registered") ? 409 : 400, { error: message });
    }
    return;
  };

  const adminAppleRegistration = async ({ request, response, target, route, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    try {
      const appIdentity = await requireRegisteredApp(dependencies.pool, identity, adminAppId(target.pathname) ?? "");
      const body = await decoder.json();
      const result = route.handler === "admin_google_data_manager"
        ? await configureGoogleDataManagerDestination({
            pool: dependencies.pool,
            identity: appIdentity,
            body,
          })
        : route.handler === "admin_app_link_identity"
        ? await registerAppLinkIdentity({ pool: dependencies.pool, identity: appIdentity, body })
        : route.handler === "admin_apple_registration"
        ? await registerAppleApp({
            pool: dependencies.pool,
            identity: appIdentity,
            appleAppAdamId: body.apple_app_adam_id,
            appleBundleId: body.apple_bundle_id,
          })
        : route.handler === "admin_conversion_schema" ? await registerConversionSchema({
            pool: dependencies.pool,
            identity: appIdentity,
            schemaVersion: body.schema_version,
            definition: body.definition,
          }) : await activateRuleBundle({
            pool: dependencies.pool,
            identity: appIdentity,
            body,
          });
      json(response, 201, result);
    } catch (error) {
      if (error instanceof AppNotFoundError) {
        json(response, 404, { error: "app_not_found" });
      } else {
        const message = error instanceof Error ? error.message : "admin_configuration_invalid";
        const status = message.endsWith("_already_registered") || message === "rule_bundle_predecessor_mismatch" ? 409 : 400;
        json(response, status, { error: message });
      }
    }
    return;
  };

  return {
    dashboard_apps_create: { boundary: "dashboard_tenant", handle: dashboardAppsCreate },
    dashboard_link_domain: { boundary: "dashboard_tenant", handle: dashboardLinkDomain },
    dashboard_app_link_identity: { boundary: "dashboard_app", handle: dashboardAppLinkIdentity },
    dashboard_apple_registration: { boundary: "dashboard_app", handle: dashboardAppLinkIdentity },
    dashboard_conversion_schema: { boundary: "dashboard_app", handle: dashboardAppLinkIdentity },
    dashboard_rule_bundle: { boundary: "dashboard_app", handle: dashboardAppLinkIdentity },
    dashboard_google_data_manager: { boundary: "dashboard_app", handle: dashboardAppLinkIdentity },
    admin_apps_list: { boundary: "admin", handle: adminAppsList },
    admin_apps_create: { boundary: "admin", handle: adminAppsCreate },
    admin_link_domain: { boundary: "admin", handle: adminLinkDomain },
    admin_apple_registration: { boundary: "admin", handle: adminAppleRegistration },
    admin_conversion_schema: { boundary: "admin", handle: adminAppleRegistration },
    admin_rule_bundle: { boundary: "admin", handle: adminAppleRegistration },
    admin_app_link_identity: { boundary: "admin", handle: adminAppleRegistration },
    admin_google_data_manager: { boundary: "admin", handle: adminAppleRegistration },
  } as const;
}
