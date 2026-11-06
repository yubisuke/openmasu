import { previewWebhookRecovery, confirmWebhookRecovery, WebhookRecoveryError } from "@openmasu/runtime/operator-webhook-recovery";
import { AppNotFoundError, requireRegisteredApp } from "../apps-admin.js";
import { adminAppId } from "../http-paths.js";
import { json, dashboardHtml } from "../http-responses.js";
import { authorizeDashboardForm } from "../http-security.js";
import { csrfToken } from "../session.js";
import { renderWebhookRecovery } from "../dashboard/webhook-recovery.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { AdminRequestContext, DashboardAppContext } from "./context.js";

export function createWebhookRecoveryControllers(dependencies: Pick<RequestHandlerDependencies,"pool"|"payloadStore"|"dashboard">) {
  const delivery = (path: string) => path.split("/").at(-2) ?? "";
  const failure = (error: unknown) => error instanceof WebhookRecoveryError ? error
    : error instanceof AppNotFoundError ? new WebhookRecoveryError("not_found",404)
    : new WebhookRecoveryError("webhook_recovery_unavailable",503);
  const execute = async (pool: AdminRequestContext["pool"], scope: Awaited<ReturnType<typeof requireRegisteredApp>>,
    deliveryId: string, confirm: boolean, body: Record<string, unknown>) => {
    if (Object.keys(body).sort().join(",") !== (confirm ? "preview_id,receipt" : "")
      || (confirm && (typeof body.preview_id !== "string" || typeof body.receipt !== "string")))
      throw new WebhookRecoveryError("webhook_recovery_confirmation_invalid",400);
    const options = { pool, scope, deliveryId, payloadStore: dependencies.payloadStore };
    return confirm ? confirmWebhookRecovery({ ...options, previewId: body.preview_id as string, receipt: body.receipt as string })
      : previewWebhookRecovery(options);
  };
  const admin = async ({response,target,route,pool,identity,decoder}: AdminRequestContext) => {
    try {
      const scope = await requireRegisteredApp(pool,identity,adminAppId(target.pathname) ?? "");
      const result = await execute(pool,scope,delivery(target.pathname),route.handler.endsWith("confirm"),await decoder.json());
      json(response,"status" in result && result.status === "requested" ? 202 : 200,result);
    } catch (error) { const safe = failure(error); json(response,safe.statusCode,{error:safe.code}); }
  };
  const dashboard = async (context: DashboardAppContext) => {
    const {request,response,target,route,pool,appIdentity,appId,session,decoder} = context;
    try {
      const form = await decoder.form();
      if (!await authorizeDashboardForm(dependencies,{request,response,session},form,"webhook_recovery","app",appId)) return;
      const confirm = route.handler.endsWith("confirm");
      const allowed = confirm ? ["csrf_token","preview_id","receipt"] : ["csrf_token"];
      if ([...form.keys()].some(key=>!allowed.includes(key)||form.getAll(key).length!==1)) throw new WebhookRecoveryError("webhook_recovery_confirmation_invalid",400);
      const result = await execute(pool,appIdentity,delivery(target.pathname),confirm,
        confirm ? {preview_id:form.get("preview_id"),receipt:form.get("receipt")} : {});
      dashboardHtml(response,200,renderWebhookRecovery(appId,csrfToken(session.token),result));
    } catch (error) { const safe = failure(error); dashboardHtml(response,safe.statusCode,renderWebhookRecovery(appId,csrfToken(session.token),undefined,safe.code)); }
  };
  return {
    admin_webhook_recovery_preview: {boundary:"admin",handle:admin},
    admin_webhook_recovery_confirm: {boundary:"admin",handle:admin},
    dashboard_webhook_recovery_preview: {boundary:"dashboard_app",handle:dashboard},
    dashboard_webhook_recovery_confirm: {boundary:"dashboard_app",handle:dashboard},
  } as const;
}
