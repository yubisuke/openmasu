import { assertSyntheticValidationDeployment, SyntheticValidationError, withTenant } from "@openmasu/runtime";
import { requireRegisteredApp, AppNotFoundError } from "../apps-admin.js";
import { createSyntheticValidation, closeSyntheticValidation, syntheticValidationStatus } from "../synthetic-validations.js";
import { renderSyntheticValidation } from "../dashboard/synthetic-validations.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { AdminRequestContext, DashboardAppContext } from "./context.js";
import { adminAppId, decodedPathPart } from "../http-paths.js";
import { json, dashboardHtml } from "../http-responses.js";
import { authorizeDashboardForm } from "../http-security.js";
import { csrfToken } from "../session.js";
import { roleAllows } from "../authorization.js";

const sessionId = (path: string) => decodedPathPart(path, /\/synthetic-validations\/([^/]+)(?:\/close)?$/) ?? "";
const failure = (error: unknown) => error instanceof SyntheticValidationError ? error
  : error instanceof SyntaxError ? new SyntheticValidationError("validation_request_invalid", 400)
  : error instanceof AppNotFoundError ? new SyntheticValidationError("validation_session_unavailable", 404)
  : new SyntheticValidationError("validation_session_unavailable", 503);
export function createSyntheticValidationControllers(dependencies: Pick<RequestHandlerDependencies, "pool" | "readerPool" | "dashboard">) {
  const admin = async ({ response, target, route, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    try {
      const app = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      if (target.searchParams.size) throw new SyntheticValidationError("validation_request_invalid", 400);
      if (route.handler === "admin_synthetic_validation_create") json(response, 201, await createSyntheticValidation(pool, app, await decoder.json()));
      else if (route.handler === "admin_synthetic_validation_close") json(response, 200, await closeSyntheticValidation(pool, app, sessionId(target.pathname)));
      else json(response, 200, await syntheticValidationStatus(pool, app, sessionId(target.pathname)));
    } catch (error) { const result = failure(error); json(response, result.status, { error: result.code }); }
  };
  const dashboard = async (context: DashboardAppContext): Promise<void> => {
    const { request, response, target, route, pool, session, appIdentity, decoder } = context;
    const page = { appId: appIdentity.appId, csrfToken: csrfToken(session.token), canAdminister: roleAllows(session.role, "administer") };
    try {
      if (target.searchParams.size) throw new SyntheticValidationError("validation_request_invalid", 400);
      if (route.mutates) {
        const form = await decoder.form();
        if (!await authorizeDashboardForm(dependencies, { request, response, session }, form, "synthetic_validation", "app", appIdentity.appId)) return;
        if ([...form.keys()].some(key => !["csrf_token", "expected_events", "expected_custom_keys", "ttl_seconds"].includes(key)
          || key !== "expected_events" && form.getAll(key).length !== 1)) throw new SyntheticValidationError("validation_request_invalid", 400);
        if (route.handler === "dashboard_synthetic_validation_close") {
          await closeSyntheticValidation(pool, appIdentity, sessionId(target.pathname));
          dashboardHtml(response, 200, renderSyntheticValidation({ ...page, error: "Validation associations closed. Underlying synthetic ledger evidence remains." }));
        } else {
          const created = await createSyntheticValidation(pool, appIdentity, { ttl_seconds: Number(form.get("ttl_seconds")),
            expected_events: form.getAll("expected_events"), expected_custom_keys: (form.get("expected_custom_keys") ?? "").split(",").map(value => value.trim()).filter(Boolean) });
          dashboardHtml(response, 201, renderSyntheticValidation({ ...page, created }));
        }
      } else if (route.handler === "dashboard_synthetic_validation_form") {
        await withTenant(pool, appIdentity.tenantId, assertSyntheticValidationDeployment);
        dashboardHtml(response, 200, renderSyntheticValidation(page));
      } else dashboardHtml(response, 200, renderSyntheticValidation({ ...page, status: await syntheticValidationStatus(pool, appIdentity, sessionId(target.pathname)) }));
    } catch (error) { const result = failure(error); dashboardHtml(response, result.status, renderSyntheticValidation({ ...page, error: result.code })); }
  };
  return {
    admin_synthetic_validation_create: { boundary: "admin" as const, handle: admin },
    admin_synthetic_validation_read: { boundary: "admin" as const, handle: admin },
    admin_synthetic_validation_close: { boundary: "admin" as const, handle: admin },
    dashboard_synthetic_validation_form: { boundary: "dashboard_app" as const, handle: dashboard },
    dashboard_synthetic_validation_create: { boundary: "dashboard_app" as const, handle: dashboard },
    dashboard_synthetic_validation_read: { boundary: "dashboard_app" as const, handle: dashboard },
    dashboard_synthetic_validation_close: { boundary: "dashboard_app" as const, handle: dashboard },
  };
}
