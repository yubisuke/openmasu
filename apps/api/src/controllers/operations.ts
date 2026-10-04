import { AppNotFoundError, requireRegisteredApp } from "../apps-admin.js";
import { renderOperationalMetrics } from "../operational-metrics.js";
import { googleDeliveryHealth } from "../google-delivery-health.js";
import { operatorDeliveryHealth } from "../operator-delivery-health.js";
import { measurementHealth, parseMeasurementWindow, MeasurementHealthQueryError } from "../measurement-health.js";
import { renderMeasurementHealthPage } from "../dashboard/recent-measurement-health.js";
import { csrfToken, recordDashboardAudit } from "../session.js";
import { roleAllows } from "../authorization.js";
import { IngestRecoveryError, listIngestRecovery, requestIngestRecovery } from "../ingest-recovery.js";
import { renderIngestRecovery } from "../dashboard/ingest-recovery.js";
import { disableOperatorWebhookDestination, listOperatorWebhookDestinations, registerOperatorWebhookDestination } from "../operator-webhooks-admin.js";
import { disableOperatorBulkExportDestination, listOperatorBulkExportDestinations, registerOperatorBulkExportDestination } from "../operator-bulk-exports-admin.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { DashboardAppContext, AdminRequestContext } from "./context.js";
import { json, dashboardHtml } from "../http-responses.js";
import { adminAppId, operatorWebhookDestinationId, operatorBulkExportDestinationId, publicReason } from "../http-paths.js";
import { authorizeDashboardForm } from "../http-security.js";
import { dashboardHeaders } from "../http-responses.js";
import { renderOperatorWebhookRegistered, renderOperatorWebhookOperationFailed, renderBulkExportRegistered, renderBulkExportOperationFailed } from "../dashboard/action-pages.js";

export function createOperationsControllers(dependencies: Pick<RequestHandlerDependencies, "operatorWebhooks" | "pool" | "payloadStore" | "dashboard" | "operatorBulkExports" | "operationalMetrics" | "readerPool">) {
  const recoveryFailure = async (identity: DashboardAppContext["appIdentity"], error: unknown) => {
    const failure = error instanceof IngestRecoveryError ? error : new IngestRecoveryError("ingest_recovery_unavailable",503);
    await recordDashboardAudit(dependencies.pool,{tenantId:identity.tenantId,appId:identity.appId,
      actorRef:`admin_key:${identity.keyId}`,action:"ingest_recovery_requested",targetScope:"app",targetRef:identity.appId,
      outcome:"failed",reasonCode:failure.code});
    return failure;
  };
  const adminIngestRecovery = async ({ response,target,route,pool,identity,decoder }: AdminRequestContext): Promise<void> => {
    let appIdentity;
    try {
      appIdentity = await requireRegisteredApp(pool,identity,adminAppId(target.pathname) ?? "");
      if (target.searchParams.size) throw new IngestRecoveryError("invalid_recovery_request",400);
      if (route.handler === "admin_ingest_recovery_list") {
        json(response,200,await listIngestRecovery(pool,appIdentity));
      } else {
        json(response,202,await requestIngestRecovery(dependencies.pool,dependencies.payloadStore,appIdentity,await decoder.json()));
      }
    } catch (error) {
      if (error instanceof AppNotFoundError) { json(response,404,{error:"app_not_found"}); return; }
      const failure = route.mutates && appIdentity ? await recoveryFailure(appIdentity,error)
        : error instanceof IngestRecoveryError ? error : new IngestRecoveryError("ingest_recovery_unavailable",503);
      json(response,failure.status,{error:failure.code});
    }
  };
  const dashboardIngestRecovery = async ({ request,response,target,route,pool,session,appIdentity,decoder }: DashboardAppContext): Promise<void> => {
    try {
      if (target.searchParams.size) throw new IngestRecoveryError("invalid_recovery_request",400);
      if (route.mutates) {
        const form = await decoder.form();
        if (!await authorizeDashboardForm(dependencies,{request,response,session},form,"ingest_recovery_requested","app",appIdentity.appId)) return;
        if ([...form.keys()].some(key => !["kind","job_id","revision","confirmation","csrf_token"].includes(key) || form.getAll(key).length !== 1)) {
          throw new IngestRecoveryError("invalid_recovery_request",400);
        }
        const { csrf_token: ignored, ...body } = Object.fromEntries(form); void ignored;
        await requestIngestRecovery(dependencies.pool,dependencies.payloadStore,appIdentity,body);
        response.writeHead(303,{...dashboardHeaders,location:`/dashboard/apps/${encodeURIComponent(appIdentity.appId)}/ingest-recovery`}).end();
        return;
      }
      const result = await listIngestRecovery(pool,appIdentity);
      dashboardHtml(response,200,renderIngestRecovery({appId:appIdentity.appId,items:result.items,
        csrfToken:csrfToken(session.token),canOperate:roleAllows(session.role,"operate")}));
    } catch (error) {
      const failure = route.mutates ? await recoveryFailure(appIdentity,error)
        : error instanceof IngestRecoveryError ? error : new IngestRecoveryError("ingest_recovery_unavailable",503);
      dashboardHtml(response,failure.status,renderIngestRecovery({appId:appIdentity.appId,items:[],
        csrfToken:csrfToken(session.token),canOperate:roleAllows(session.role,"operate"),error:failure.code}));
    }
  };
  const dashboardOperatorWebhooksRegister = async ({ request, response, target, route, pool, session, appId, appIdentity, decoder }: DashboardAppContext): Promise<void> => {
    const body = await decoder.form();
    const destinationId = operatorWebhookDestinationId(target.pathname);
    if (!await authorizeDashboardForm(dependencies, { request, response, session }, body, "dashboard_operator_webhook_mutation", "webhook_destination", destinationId ?? "webhook:new")) return;
    try {
      if (route.handler === "dashboard_operator_webhooks_register") {
        if (!dependencies.operatorWebhooks) throw new Error("operator_webhooks_not_configured");
        const issued = await registerOperatorWebhookDestination({
          pool: dependencies.pool,
          payloadStore: dependencies.payloadStore,
          identity: appIdentity,
          body: {
            endpoint_url: body.get("endpoint_url") ?? "",
            events: body.getAll("events"),
          },
          destinationAllowlist: dependencies.operatorWebhooks.destinationAllowlist,
          allowSyntheticLoopback: dependencies.operatorWebhooks.allowSyntheticLoopback,
        });
        dashboardHtml(response, 201, renderOperatorWebhookRegistered({ destinationId: issued.destination_id, endpointUrl: issued.endpoint_url, signingSecret: issued.signing_secret, appId: appIdentity.appId }));
      } else {
        if (!destinationId) throw new Error("operator_webhook_destination_not_found");
        await disableOperatorWebhookDestination({
          pool: dependencies.pool,
          payloadStore: dependencies.payloadStore,
          identity: appIdentity,
          destinationId,
        });
        response.writeHead(303, {
          ...dashboardHeaders,
          location: `/dashboard/apps/${encodeURIComponent(appIdentity.appId)}`,
        }).end();
      }
    } catch (error) {
      const reason = publicReason(error, "operator_webhook_lifecycle_failed");
      await recordDashboardAudit(dependencies.pool, {
        tenantId: appIdentity.tenantId,
        appId: appIdentity.appId,
        actorRef: `admin_key:${session.adminKeyId}`,
        action: "operator_webhook_lifecycle",
        targetScope: "webhook_destination",
        targetRef: destinationId ?? "webhook:new",
        outcome: "failed",
        reasonCode: reason,
      });
      dashboardHtml(response, reason === "operator_webhook_destination_not_found" ? 404 : 400,
        renderOperatorWebhookOperationFailed({ reason: reason }));
    }
    return;
  };

  const dashboardOperatorBulkExportsRegister = async ({ request, response, target, route, pool, session, appId, appIdentity, decoder }: DashboardAppContext): Promise<void> => {
    const body = await decoder.form();
    const destinationId = operatorBulkExportDestinationId(target.pathname);
    if (!await authorizeDashboardForm(dependencies, { request, response, session }, body, "dashboard_operator_bulk_export_mutation", "bulk_export_destination", destinationId ?? "bulk:new")) return;
    try {
      if (route.handler === "dashboard_operator_bulk_exports_register") {
        if (!dependencies.operatorBulkExports) throw new Error("operator_bulk_exports_not_configured");
        await registerOperatorBulkExportDestination({
          pool: dependencies.pool,
          payloadStore: dependencies.payloadStore,
          identity: appIdentity,
          body: {
            endpoint_url: body.get("endpoint_url") ?? "",
            bucket_name: body.get("bucket_name") ?? "",
            object_prefix: body.get("object_prefix") ?? "",
            region: body.get("region") ?? "",
            start_at: body.get("start_at") ?? "",
            access_key_id: body.get("access_key_id") ?? "",
            secret_access_key: body.get("secret_access_key") ?? "",
            session_token: body.get("session_token") ?? "",
            events: body.getAll("events"),
          },
          destinationAllowlist: dependencies.operatorBulkExports.destinationAllowlist,
          allowSyntheticLoopback: dependencies.operatorBulkExports.allowSyntheticLoopback,
        });
        dashboardHtml(response, 201, renderBulkExportRegistered({ appId: appIdentity.appId }));
      } else {
        if (!destinationId) throw new Error("operator_bulk_destination_not_found");
        await disableOperatorBulkExportDestination({
          pool: dependencies.pool,
          payloadStore: dependencies.payloadStore,
          identity: appIdentity,
          destinationId,
        });
        response.writeHead(303, {
          ...dashboardHeaders,
          location: `/dashboard/apps/${encodeURIComponent(appIdentity.appId)}`,
        }).end();
      }
    } catch (error) {
      const reason = publicReason(error, "operator_bulk_lifecycle_failed");
      await recordDashboardAudit(dependencies.pool, {
        tenantId: appIdentity.tenantId,
        appId: appIdentity.appId,
        actorRef: `admin_key:${session.adminKeyId}`,
        action: "operator_bulk_export_lifecycle",
        targetScope: "bulk_export_destination",
        targetRef: destinationId ?? "bulk:new",
        outcome: "failed",
        reasonCode: reason,
      });
      dashboardHtml(response, reason === "operator_bulk_destination_not_found" ? 404 : 400,
        renderBulkExportOperationFailed({ reason: reason }));
    }
    return;
  };

  const operationalMetrics = async ({ response, identity }: AdminRequestContext): Promise<void> => {
    if (!dependencies.operationalMetrics) {
      json(response, 503, { error: "operational_metrics_unavailable" });
      return;
    }
    const body = await renderOperationalMetrics(
      dependencies.readerPool,
      identity.tenantId,
      dependencies.operationalMetrics,
    );
    response.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(body);
    return;
  };

  const adminGoogleDeliveryHealth = async ({ response, target, pool, identity }: AdminRequestContext): Promise<void> => {
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      json(response, 200, await googleDeliveryHealth(pool, appIdentity));
    } catch (error) {
      if (error instanceof AppNotFoundError) json(response, 404, { error: "app_not_found" });
      else throw error;
    }
    return;
  };

  const adminMeasurementHealth = async ({ response, target, pool, identity }: AdminRequestContext): Promise<void> => {
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      json(response, 200, await measurementHealth(pool, appIdentity, parseMeasurementWindow(target.searchParams)));
    } catch (error) {
      if (error instanceof AppNotFoundError) json(response, 404, { error: "app_not_found" });
      else if (error instanceof MeasurementHealthQueryError) json(response, error.statusCode, { error: error.code });
      else throw error;
    }
    return;
  };

  const dashboardMeasurementHealth = async ({ response, target, pool, appIdentity }: DashboardAppContext): Promise<void> => {
    try {
      const health = await measurementHealth(pool, appIdentity, parseMeasurementWindow(target.searchParams));
      dashboardHtml(response, 200, renderMeasurementHealthPage(health.recent!, appIdentity.appId));
    } catch (error) {
      if (error instanceof MeasurementHealthQueryError) json(response, error.statusCode, { error: error.code });
      else throw error;
    }
  };

  const adminOperatorDeliveryHealth = async ({ response, target, pool, identity }: AdminRequestContext): Promise<void> => {
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      json(response, 200, await operatorDeliveryHealth(pool, appIdentity));
    } catch (error) {
      if (error instanceof AppNotFoundError) json(response, 404, { error: "app_not_found" });
      else throw error;
    }
    return;
  };

  const adminOperatorWebhooksList = async ({ request, response, target, route, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    const appId = adminAppId(target.pathname) ?? "";
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, appId);
      if (route.handler === "admin_operator_webhooks_list") {
        json(response, 200, { data: await listOperatorWebhookDestinations(pool, appIdentity) });
        return;
      }
      if (route.handler === "admin_operator_webhooks_register") {
        if (!dependencies.operatorWebhooks) throw new Error("operator_webhooks_not_configured");
        const body = await decoder.json();
        json(response, 201, await registerOperatorWebhookDestination({
          pool: dependencies.pool,
          payloadStore: dependencies.payloadStore,
          identity: appIdentity,
          body,
          destinationAllowlist: dependencies.operatorWebhooks.destinationAllowlist,
          allowSyntheticLoopback: dependencies.operatorWebhooks.allowSyntheticLoopback,
        }));
        return;
      }
      const destinationId = operatorWebhookDestinationId(target.pathname);
      if (!destinationId) throw new Error("operator_webhook_destination_not_found");
      json(response, 200, await disableOperatorWebhookDestination({
        pool: dependencies.pool,
        payloadStore: dependencies.payloadStore,
        identity: appIdentity,
        destinationId,
      }));
    } catch (error) {
      const reason = publicReason(error, "operator_webhook_lifecycle_failed");
      if (error instanceof AppNotFoundError || reason === "operator_webhook_destination_not_found") {
        json(response, 404, { error: "not_found" });
      } else {
        await recordDashboardAudit(dependencies.pool, {
          tenantId: identity.tenantId,
          appId,
          actorRef: `admin_key:${identity.keyId}`,
          action: "operator_webhook_lifecycle",
          targetScope: "webhook_destination",
          targetRef: operatorWebhookDestinationId(target.pathname) ?? "webhook:new",
          outcome: "failed",
          reasonCode: reason,
        });
        json(response, reason === "operator_webhook_destination_not_active" ? 409 : 400, { error: reason });
      }
    }
    return;
  };

  const adminOperatorBulkExportsList = async ({ request, response, target, route, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    const appId = adminAppId(target.pathname) ?? "";
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, appId);
      if (route.handler === "admin_operator_bulk_exports_list") {
        json(response, 200, { data: await listOperatorBulkExportDestinations(pool, appIdentity) });
        return;
      }
      if (route.handler === "admin_operator_bulk_exports_register") {
        if (!dependencies.operatorBulkExports) throw new Error("operator_bulk_exports_not_configured");
        const body = await decoder.json();
        json(response, 201, await registerOperatorBulkExportDestination({
          pool: dependencies.pool,
          payloadStore: dependencies.payloadStore,
          identity: appIdentity,
          body,
          destinationAllowlist: dependencies.operatorBulkExports.destinationAllowlist,
          allowSyntheticLoopback: dependencies.operatorBulkExports.allowSyntheticLoopback,
        }));
        return;
      }
      const destinationId = operatorBulkExportDestinationId(target.pathname);
      if (!destinationId) throw new Error("operator_bulk_destination_not_found");
      json(response, 200, await disableOperatorBulkExportDestination({
        pool: dependencies.pool,
        payloadStore: dependencies.payloadStore,
        identity: appIdentity,
        destinationId,
      }));
    } catch (error) {
      const reason = publicReason(error, "operator_bulk_lifecycle_failed");
      if (error instanceof AppNotFoundError || reason === "operator_bulk_destination_not_found") {
        json(response, 404, { error: "not_found" });
      } else {
        await recordDashboardAudit(dependencies.pool, {
          tenantId: identity.tenantId,
          appId,
          actorRef: `admin_key:${identity.keyId}`,
          action: "operator_bulk_export_lifecycle",
          targetScope: "bulk_export_destination",
          targetRef: operatorBulkExportDestinationId(target.pathname) ?? "bulk:new",
          outcome: "failed",
          reasonCode: reason,
        });
        json(response, reason === "operator_bulk_destination_not_active" ? 409 : 400, { error: reason });
      }
    }
    return;
  };

  return {
    admin_ingest_recovery_list: { boundary: "admin", handle: adminIngestRecovery },
    admin_ingest_recovery_request: { boundary: "admin", handle: adminIngestRecovery },
    dashboard_ingest_recovery_list: { boundary: "dashboard_app", handle: dashboardIngestRecovery },
    dashboard_ingest_recovery_request: { boundary: "dashboard_app", handle: dashboardIngestRecovery },
    dashboard_operator_webhooks_register: { boundary: "dashboard_app", handle: dashboardOperatorWebhooksRegister },
    dashboard_operator_webhooks_disable: { boundary: "dashboard_app", handle: dashboardOperatorWebhooksRegister },
    dashboard_operator_bulk_exports_register: { boundary: "dashboard_app", handle: dashboardOperatorBulkExportsRegister },
    dashboard_operator_bulk_exports_disable: { boundary: "dashboard_app", handle: dashboardOperatorBulkExportsRegister },
    operational_metrics: { boundary: "admin", handle: operationalMetrics },
    admin_google_delivery_health: { boundary: "admin", handle: adminGoogleDeliveryHealth },
    admin_measurement_health: { boundary: "admin", handle: adminMeasurementHealth },
    dashboard_measurement_health: { boundary: "dashboard_app", handle: dashboardMeasurementHealth },
    admin_operator_delivery_health: { boundary: "admin", handle: adminOperatorDeliveryHealth },
    admin_operator_webhooks_list: { boundary: "admin", handle: adminOperatorWebhooksList },
    admin_operator_webhooks_register: { boundary: "admin", handle: adminOperatorWebhooksList },
    admin_operator_webhooks_disable: { boundary: "admin", handle: adminOperatorWebhooksList },
    admin_operator_bulk_exports_list: { boundary: "admin", handle: adminOperatorBulkExportsList },
    admin_operator_bulk_exports_register: { boundary: "admin", handle: adminOperatorBulkExportsList },
    admin_operator_bulk_exports_disable: { boundary: "admin", handle: adminOperatorBulkExportsList },
  } as const;
}
