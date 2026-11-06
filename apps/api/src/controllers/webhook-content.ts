import { normalizeOperatorWebhookEvents } from "@openmasu/runtime";
import { previewWebhookContent } from "@openmasu/runtime/webhook-content";
import { readWebhookContent, activateWebhookContent } from "../webhook-content-admin.js";
import { contentPolicyFromForm, renderWebhookContent } from "../dashboard/webhook-content.js";
import { requireRegisteredApp, AppNotFoundError } from "../apps-admin.js";
import { adminAppId, operatorWebhookDestinationId, publicReason } from "../http-paths.js";
import { json, dashboardHtml, dashboardHeaders } from "../http-responses.js";
import { csrfToken, verifyCsrfToken } from "../session.js";
import { csrfOriginAccepted } from "../http-security.js";
import type { AdminRequestContext, DashboardAppContext } from "./context.js";
import type { RequestHandlerDependencies } from "../http-types.js";

export function createWebhookContentControllers(dependencies: Pick<RequestHandlerDependencies, "pool" | "dashboard">) {
  const status = (error: unknown) => error instanceof AppNotFoundError || (error instanceof Error && error.message.endsWith("not_found")) ? 404
    : error instanceof Error && /revision_stale|not_active/.test(error.message) ? 409 : 400;
  const admin = async ({ response, target, route, pool, identity, decoder }: AdminRequestContext) => {
    try {
      const app = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      if (route.handler === "admin_webhook_content_preview") {
        const body = await decoder.json();
        if (Object.keys(body).some(key => !["policy", "events"].includes(key))) throw Error("operator_webhook_content_invalid");
        json(response, 200, previewWebhookContent(body.policy, normalizeOperatorWebhookEvents(body.events)));
      } else {
        const destination = operatorWebhookDestinationId(target.pathname);
        if (!destination) throw Error("operator_webhook_destination_not_found");
        json(response, 200, route.handler === "admin_webhook_content_read"
          ? await readWebhookContent(pool, app, destination)
          : await activateWebhookContent(dependencies.pool, app, destination, await decoder.json()));
      }
    } catch (error) { json(response, status(error), { error: publicReason(error, "operator_webhook_content_failed") }); }
  };
  const dashboard = async ({ request, response, target, route, pool, appIdentity, appId, session, decoder }: DashboardAppContext) => {
    try {
      const destination = operatorWebhookDestinationId(target.pathname);
      if (!destination) throw Error("operator_webhook_destination_not_found");
      const history = await readWebhookContent(pool, appIdentity, destination);
      let preview;
      if (request.method === "POST") {
        const form = await decoder.form();
        if (!csrfOriginAccepted(request, dependencies.dashboard.publicBaseUrl) || form.getAll("csrf_token").length !== 1
          || !verifyCsrfToken(session.token, form.get("csrf_token") ?? "")) {
          dashboardHtml(response, 403, renderWebhookContent(appId, csrfToken(session.token), history, undefined, "csrf_rejected")); return;
        }
        if (route.handler === "dashboard_webhook_content_preview") preview = previewWebhookContent(contentPolicyFromForm(form), history.events);
        else {
          await activateWebhookContent(dependencies.pool, appIdentity, destination, { policy: JSON.parse(form.get("policy") ?? "null"),
            preview_digest: form.get("preview_digest"), expected_revision: Number(form.get("expected_revision")) });
          response.writeHead(303, { ...dashboardHeaders, location: target.pathname }); response.end(); return;
        }
      }
      dashboardHtml(response, 200, renderWebhookContent(appId, csrfToken(session.token), history, preview));
    } catch (error) {
      dashboardHtml(response, status(error), `<p>Webhook content operation failed. Return to the app and retry the preview.</p>`);
    }
  };
  return {
    admin_webhook_content_preview: { boundary: "admin", handle: admin },
    admin_webhook_content_read: { boundary: "admin", handle: admin },
    admin_webhook_content_activate: { boundary: "admin", handle: admin },
    dashboard_webhook_content_read: { boundary: "dashboard_app", handle: dashboard },
    dashboard_webhook_content_preview: { boundary: "dashboard_app", handle: dashboard },
    dashboard_webhook_content_activate: { boundary: "dashboard_app", handle: dashboard },
  } as const;
}
