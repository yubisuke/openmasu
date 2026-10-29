import { depositComparisonSnapshot, deleteComparison, readComparisons, readComparisonRun, registerComparison,
  recurringComparisonLimits, prepareComparisonRegistration, configureComparisonNotifications } from "@openmasu/runtime/recurring-comparisons";
import { jcs } from "@openmasu/attribution-core/canonical";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { DashboardAppContext, AdminRequestContext } from "./context.js";
import { AppNotFoundError, requireRegisteredApp } from "../apps-admin.js";
import { adminAppId, decodedPathPart } from "../http-paths.js";
import { dashboardHeaders, dashboardHtml, json, rawBody } from "../http-responses.js";
import { authorizeDashboardForm } from "../http-security.js";
import { assertRoleAllows, roleAllows } from "../authorization.js";
import { csrfToken, recordDashboardAudit } from "../session.js";
import { renderComparisonFormPreview, renderRecurringComparisons } from "../dashboard/recurring-comparisons.js";
import { confirmedComparisonForm, previewComparisonForm } from "../recurring-comparison-form.js";
import { boundedComparisonOutput } from "../dashboard-comparison.js";

const maximumBody = recurringComparisonLimits.bytes * 2 + 16384;
const reason = (error: unknown) => error instanceof Error && /^comparison_[a-z_]+$/.test(error.message) ? error.message : "comparison_input_invalid";
export function createComparisonsControllers(dependencies: Pick<RequestHandlerDependencies, "pool" | "readerPool" | "dashboard">) {
  const admin = async ({ request, response, pool, identity, target, route }: AdminRequestContext) => {
    try {
      const scope = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      if (route.handler === "admin_comparison_read") {
        const runId = decodedPathPart(target.pathname, /\/comparison-runs\/([^/]+)$/);
        const result = runId ? await readComparisonRun(pool, scope, runId) : await readComparisons(pool, scope);
        json(response, result ? 200 : 404, result ?? { error: "not_found" }); return;
      }
      assertRoleAllows(identity.role, "operate");
      const body = JSON.parse((await rawBody(request, maximumBody)).toString("utf8"));
      const result = await mutate(scope, body, roleAllows(identity.role, "administer"));
      json(response, 200, result);
    } catch (error) { const forbidden = error instanceof Error && error.message === "forbidden";
      json(response, error instanceof AppNotFoundError ? 404 : forbidden ? 403 : 400, { error: error instanceof AppNotFoundError ? "not_found" : forbidden ? "forbidden" : reason(error) }); }
  };
  const mutate = async (scope: Parameters<typeof registerComparison>[1] & { keyId: string }, body: Record<string, unknown>, canAdminister: boolean) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw Error("comparison_input_invalid");
    const action = body.action;
    let result: unknown;
    let targetRef: string;
    if (action === "register") {
      if (Object.keys(body).sort().join(",") !== "action,registration") throw Error("comparison_input_invalid");
      const saved = await registerComparison(dependencies.pool, scope, body.registration); result = saved; targetRef = saved.comparison_id;
    } else if (action === "deposit") {
      if (Object.keys(body).sort().join(",") !== "action,comparison_id,side,snapshot,target_date" || typeof body.comparison_id !== "string"
          || typeof body.target_date !== "string" || typeof body.side !== "string") throw Error("comparison_input_invalid");
      targetRef = body.comparison_id;
      result = { snapshot_digest: await depositComparisonSnapshot(dependencies.pool, scope, targetRef, body.target_date, body.side, body.snapshot) };
    } else if (action === "delete") {
      if (Object.keys(body).sort().join(",") !== "action,comparison_id" || typeof body.comparison_id !== "string") throw Error("comparison_input_invalid");
      targetRef = body.comparison_id;
      result = { deleted: await deleteComparison(dependencies.pool, scope, targetRef) };
    } else if (action === "notifications") {
      if (!canAdminister) throw Error("forbidden");
      const { action: _action, ...settings } = body;
      result = await configureComparisonNotifications(dependencies.pool, scope, settings);
      targetRef = String(settings.comparison_id);
    } else throw Error("comparison_action_invalid");
    await recordDashboardAudit(dependencies.pool, { tenantId: scope.tenantId, appId: scope.appId, actorRef: `admin_key:${scope.keyId}`,
      action: `comparison_${action}`, targetScope: "app", targetRef, outcome: "succeeded" });
    return result;
  };
  const dashboard = async ({ request, response, pool, session, appId, appIdentity, target, route, startedAt }: DashboardAppContext) => {
    try {
      if (route.handler === "dashboard_comparison_runs_mutate" || route.handler === "dashboard_comparison_runs_preview") {
        assertRoleAllows(session.role, "operate");
        const type = request.headers["content-type"] ?? "";
        const bytes = await rawBody(request, maximumBody);
        let form: FormData;
        if (/^multipart\/form-data;\s*boundary=(?:"[A-Za-z0-9'()+_,./:=? -]{1,70}"|[A-Za-z0-9'()+_,./:=?-]{1,70})$/i.test(type)) {
          new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          form = await new Request("http://openmasu.local/comparisons", { method: "POST", headers: { "content-type": type }, body: new Uint8Array(bytes) }).formData();
        } else if (route.handler === "dashboard_comparison_runs_mutate" && type.startsWith("application/x-www-form-urlencoded")) {
          // Keep existing command clients compatible; the page only offers typed forms.
          form = new FormData();
          for (const [key, value] of new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) form.append(key, value);
        } else throw Error("comparison_multipart_required");
        const token = form.get("csrf_token");
        if (form.getAll("csrf_token").length !== 1 || typeof token !== "string") throw Error("comparison_input_invalid");
        if (!await authorizeDashboardForm(dependencies, { request, response, session }, new URLSearchParams({ csrf_token: token }), "comparison_mutation", "app", appId)) return;
        if (route.handler === "dashboard_comparison_runs_preview") {
          const saved = await readComparisons(pool, appIdentity);
          const preview = await previewComparisonForm(form, appIdentity, saved.plans,
            input => prepareComparisonRegistration(dependencies.readerPool, appIdentity, input));
          dashboardHtml(response, 200, boundedComparisonOutput(renderComparisonFormPreview(appId, csrfToken(session.token), preview), startedAt + 30_000));
          return;
        }
        let command: Record<string, unknown>;
        if (form.get("action") === "notifications") {
          const keys = ["csrf_token","action","comparison_id","destination_id","enabled","muted","cooldown_seconds"];
          if ([...form.keys()].some(key => !keys.includes(key)) || keys.some(key => form.getAll(key).length !== 1)
              || !["true","false"].includes(String(form.get("enabled"))) || !["true","false"].includes(String(form.get("muted")))) throw Error("comparison_input_invalid");
          command = { action: "notifications",comparison_id:form.get("comparison_id"),destination_id:form.get("destination_id"),
            enabled:form.get("enabled") === "true",muted:form.get("muted") === "true",cooldown_seconds:Number(form.get("cooldown_seconds")) };
        } else if (form.has("confirmation_digest")) command = confirmedComparisonForm(form);
        else {
          if ([...form.keys()].some(key => !["csrf_token", "command"].includes(key)) || form.getAll("command").length !== 1
              || typeof form.get("command") !== "string") throw Error("comparison_input_invalid");
          command = JSON.parse(form.get("command") as string);
        }
        const result = await mutate(appIdentity, command, roleAllows(session.role, "administer")) as { comparison_id?: string };
        const id = result.comparison_id ?? (typeof command.comparison_id === "string" ? command.comparison_id : "");
        response.writeHead(303, { ...dashboardHeaders, location: `/dashboard/apps/${encodeURIComponent(appId)}/comparisons${id ? `#comparison-${encodeURIComponent(id)}` : ""}` }).end(); return;
      }
      const runId = decodedPathPart(target.pathname, /\/comparison-runs\/([^/]+)\.json$/);
      if (runId) {
        const result = await readComparisonRun(pool, appIdentity, runId);
        if (!result) { json(response, 404, { error: "not_found" }); return; }
        response.writeHead(200, { ...dashboardHeaders, "content-type": "application/json", "content-disposition": 'attachment; filename="openmasu-comparison.json"' });
        response.end(`${jcs(result)}\n`); return;
      }
      dashboardHtml(response, 200, renderRecurringComparisons(appId, await readComparisons(pool, appIdentity), csrfToken(session.token), roleAllows(session.role, "operate"), undefined, roleAllows(session.role, "administer")));
    } catch (error) { dashboardHtml(response, error instanceof Error && error.message === "forbidden" ? 403 : 400,
      renderRecurringComparisons(appId, { plans: [], runs: [] }, csrfToken(session.token), false, reason(error))); }
  };
  return {
    admin_comparison_read: { boundary: "admin", handle: admin },
    admin_comparison_mutate: { boundary: "admin", handle: admin },
    dashboard_comparison_runs: { boundary: "dashboard_app", handle: dashboard },
    dashboard_comparison_runs_mutate: { boundary: "dashboard_app", handle: dashboard },
    dashboard_comparison_runs_preview: { boundary: "dashboard_app", handle: dashboard },
  } as const;
}
