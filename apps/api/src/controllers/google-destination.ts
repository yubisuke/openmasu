import { configureGoogleDataManagerDestination, googleDestinationHistory } from "../google-data-manager-admin.js";
import { previewGoogleDestination } from "../google-destination-readiness.js";
import { googleDestinationForm, renderGoogleDestination } from "../dashboard/google-destination.js";
import { requireRegisteredApp, AppNotFoundError } from "../apps-admin.js";
import { adminAppId, publicReason } from "../http-paths.js";
import { json, dashboardHtml, dashboardHeaders } from "../http-responses.js";
import { csrfToken, verifyCsrfToken } from "../session.js";
import { csrfOriginAccepted } from "../http-security.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { AdminRequestContext, DashboardAppContext } from "./context.js";

export function createGoogleDestinationControllers(dependencies: Pick<RequestHandlerDependencies, "pool" | "dashboard">) {
  const status = (error: unknown) => error instanceof AppNotFoundError ? 404 : error instanceof Error && error.message.endsWith("revision_stale") ? 409 : 400;
  const admin = async ({ response, target, route, pool, identity, decoder }: AdminRequestContext) => {
    try {
      const app = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      json(response, 200, route.handler === "admin_google_destination_read" ? { revisions: await googleDestinationHistory(pool, app) }
        : route.handler === "admin_google_destination_preview" ? previewGoogleDestination(await decoder.json())
        : await configureGoogleDataManagerDestination({ pool: dependencies.pool, identity: app, body: await decoder.json() }));
    } catch (error) { json(response, status(error), { error: publicReason(error, "google_destination_failed") }); }
  };
  const dashboard = async ({ request, response, target, route, pool, appId, appIdentity, session, decoder }: DashboardAppContext) => {
    try {
      const history = await googleDestinationHistory(pool, appIdentity);
      let preview;
      if (request.method === "POST") {
        const form = await decoder.form();
        if (!csrfOriginAccepted(request, dependencies.dashboard.publicBaseUrl) || form.getAll("csrf_token").length !== 1
          || !verifyCsrfToken(session.token, form.get("csrf_token") ?? "")) { dashboardHtml(response, 403, "<p>csrf_rejected</p>"); return; }
        if (route.handler === "dashboard_google_destination_preview") preview = previewGoogleDestination(googleDestinationForm(form));
        else {
          const definition = JSON.parse(form.get("definition") ?? "null");
          await configureGoogleDataManagerDestination({ pool: dependencies.pool, identity: appIdentity,
            body: { ...definition, expected_revision: Number(form.get("expected_revision")), preview_digest: form.get("preview_digest") } });
          response.writeHead(303, { ...dashboardHeaders, location: target.pathname }).end(); return;
        }
      }
      dashboardHtml(response, 200, renderGoogleDestination(appId, csrfToken(session.token), history, preview));
    } catch (error) { dashboardHtml(response, status(error), "<p>Configuration was not changed. Return to the app and preview again.</p>"); }
  };
  return {
    admin_google_data_manager: { boundary: "admin", handle: admin },
    admin_google_destination_read: { boundary: "admin", handle: admin },
    admin_google_destination_preview: { boundary: "admin", handle: admin },
    dashboard_google_data_manager: { boundary: "dashboard_app", handle: dashboard },
    dashboard_google_destination_read: { boundary: "dashboard_app", handle: dashboard },
    dashboard_google_destination_preview: { boundary: "dashboard_app", handle: dashboard },
  } as const;
}
