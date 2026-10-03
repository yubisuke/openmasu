import { AppNotFoundError, requireRegisteredApp } from "../apps-admin.js";
import { roleAllows } from "../authorization.js";
import { metricScheduleFormRequest, metricScheduleReplacementFormRequest, renderMetricScheduleReplacement, renderMetricSchedules } from "../dashboard/metric-schedules.js";
import { csrfToken, recordDashboardAudit } from "../session.js";
import { disableMetricSchedule, listMetricSchedules, registerMetricSchedule } from "../metric-schedules.js";
import { previewMetricScheduleReplacement, replaceMetricSchedule } from "../metric-schedule-replacements.js";
import { disableCostSchedule, listCostSchedules, registerCostSchedule } from "../cost-schedules.js";
import { listMetricRecalculations, requestMetricRecalculation } from "../metric-recalculations.js";
import { renderMetricRecalculations } from "../dashboard/metric-recalculations.js";
import { metricRecalculationFormRequest } from "../metric-recalculation-form.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { DashboardAppContext, AdminRequestContext } from "./context.js";
import { json, dashboardHtml } from "../http-responses.js";
import { adminAppId, decodedPathPart, metricScheduleId, publicReason } from "../http-paths.js";
import { authorizeDashboardForm } from "../http-security.js";
import { dashboardHeaders } from "../http-responses.js";
import { renderRecalculationRequestRejected, renderMetricScheduleOperationFailed } from "../dashboard/action-pages.js";

const scheduleConflict = (reason: string): boolean => ["metric_schedule_not_active", "metric_schedule_metric_overlap",
  "metric_schedule_date_in_flight", "metric_schedule_preview_stale", "metric_schedule_source_key_conflict",
  "metric_schedule_source_key_unavailable",
  "metric_schedule_supersession_target_conflict"].includes(reason);

export function createMetricJobsControllers(dependencies: Pick<RequestHandlerDependencies, "readerPool" | "pool" | "dashboard">) {
  const dashboardMetricRecalculationsList = async ({ response, session, appId, appIdentity }: DashboardAppContext): Promise<void> => {
    dashboardHtml(response, 200, renderMetricRecalculations(appId,
      await listMetricRecalculations(dependencies.readerPool, appIdentity), csrfToken(session.token), roleAllows(session.role, "operate")));
    return;
  };

  const dashboardMetricRecalculationsPreview = async ({ request, response, route, pool, session, appId, appIdentity, decoder }: DashboardAppContext): Promise<void> => {
    const body = await decoder.form();
    if (!await authorizeDashboardForm(dependencies, { request, response, session }, body, "dashboard_metric_recalculation", "app", appId)) return;
    try {
      const parsed = metricRecalculationFormRequest(body);
      if (route.handler === "dashboard_metric_recalculations_preview") {
        dashboardHtml(response, 200, renderMetricRecalculations(appId,
          await listMetricRecalculations(dependencies.readerPool, appIdentity), csrfToken(session.token), true, parsed));
      } else {
        const job = await requestMetricRecalculation(dependencies.pool, appIdentity, parsed);
        response.writeHead(303, { ...dashboardHeaders,
          location: `/dashboard/apps/${encodeURIComponent(appId)}/metric-recalculations#${encodeURIComponent(job.recalculation_id)}` }).end();
      }
    } catch (error) {
      const reason = publicReason(error, "metric_recalculation_failed");
      dashboardHtml(response, reason === "cost_revision_not_found" ? 404 : 400,
        renderRecalculationRequestRejected({ reason: reason, appId: appId }));
    }
    return;
  };

  const dashboardMetricSchedulesList = async ({ response, session, appId, appIdentity }: DashboardAppContext): Promise<void> => {
    dashboardHtml(response, 200, renderMetricSchedules(appId,
      await listMetricSchedules(dependencies.readerPool, appIdentity), csrfToken(session.token)));
    return;
  };

  const dashboardMetricSchedulesRegister = async ({ request, response, target, route, pool, session, appId, appIdentity, decoder }: DashboardAppContext): Promise<void> => {
    const body = await decoder.form();
    const scheduleId = metricScheduleId(target.pathname);
    if (!await authorizeDashboardForm(dependencies, { request, response, session }, body, "dashboard_metric_schedule_mutation", "app", appId)) return;
    try {
      const disable = route.handler === "dashboard_metric_schedules_disable";
      const parsed = metricScheduleFormRequest(body, disable);
      if (disable) {
        if (!scheduleId) throw new Error("metric_schedule_not_found");
        await disableMetricSchedule({ pool: dependencies.pool, identity: appIdentity, metricScheduleId: scheduleId });
      } else {
        await registerMetricSchedule({ pool: dependencies.pool, identity: appIdentity, body: parsed });
      }
      response.writeHead(303, { ...dashboardHeaders, location: `/dashboard/apps/${encodeURIComponent(appId)}/metric-schedules` }).end();
    } catch (error) {
      const reason = publicReason(error, "metric_schedule_lifecycle_failed");
      const notFound = reason === "metric_schedule_not_found";
      if (!notFound) await recordDashboardAudit(dependencies.pool, {
        tenantId: appIdentity.tenantId, appId, actorRef: `admin_key:${session.adminKeyId}`,
        action: "metric_schedule_lifecycle", targetScope: "metric_schedule",
        targetRef: scheduleId ?? "metric_schedule:new", outcome: "failed", reasonCode: reason,
      });
      const status = notFound ? 404 : scheduleConflict(reason) ? 409 : 400;
      dashboardHtml(response, status, renderMetricScheduleOperationFailed({ reason: notFound ? "not_found" : reason, appId: appId }));
    }
    return;
  };

  const dashboardMetricSchedulesReplacement = async ({ request, response, target, route, session, appId, appIdentity, decoder }: DashboardAppContext): Promise<void> => {
    const form = await decoder.form();
    if (!await authorizeDashboardForm(dependencies, { request, response, session }, form,
      "dashboard_metric_schedule_replacement", "app", appId)) return;
    try {
      const id = metricScheduleId(target.pathname);
      if (!id) throw new Error("metric_schedule_not_found");
      const body = metricScheduleReplacementFormRequest(form);
      if (route.handler === "dashboard_metric_schedules_preview_replacement") {
        const preview = await previewMetricScheduleReplacement(dependencies.readerPool, appIdentity, id, body);
        dashboardHtml(response, 200, renderMetricScheduleReplacement(appId, preview, csrfToken(session.token)));
      } else {
        const saved = await replaceMetricSchedule(dependencies.pool, appIdentity, id, body);
        response.writeHead(303, { ...dashboardHeaders,
          location: `/dashboard/apps/${encodeURIComponent(appId)}?metric_schedule_id=${encodeURIComponent(saved.metric_schedule_id)}` }).end();
      }
    } catch (error) {
      const reason = publicReason(error, "metric_schedule_replacement_failed");
      dashboardHtml(response, reason === "metric_schedule_not_found" ? 404 : scheduleConflict(reason) ? 409 : 400,
        renderMetricScheduleOperationFailed({ reason: reason === "metric_schedule_not_found" ? "not_found" : reason, appId }));
    }
  };

  const adminMetricSchedulesList = async ({ request, response, target, route, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    const appId = adminAppId(target.pathname) ?? "";
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, appId);
      if (route.handler === "admin_metric_schedules_list") {
        json(response, 200, { data: await listMetricSchedules(pool, appIdentity) });
        return;
      }
      if (route.handler === "admin_metric_schedules_register") {
        json(response, 201, await registerMetricSchedule({
          pool: dependencies.pool,
          identity: appIdentity,
          body: await decoder.json(),
        }));
        return;
      }
      const scheduleId = metricScheduleId(target.pathname);
      if (!scheduleId) throw new Error("metric_schedule_not_found");
      if (route.handler === "admin_metric_schedules_preview_replacement") {
        json(response, 200, await previewMetricScheduleReplacement(pool, appIdentity, scheduleId, await decoder.json()));
        return;
      }
      if (route.handler === "admin_metric_schedules_replace") {
        json(response, 200, await replaceMetricSchedule(dependencies.pool, appIdentity, scheduleId, await decoder.json()));
        return;
      }
      json(response, 200, await disableMetricSchedule({
        pool: dependencies.pool,
        identity: appIdentity,
        metricScheduleId: scheduleId,
      }));
    } catch (error) {
      const reason = publicReason(error, "metric_schedule_lifecycle_failed");
      if (error instanceof AppNotFoundError || reason === "metric_schedule_not_found") {
        json(response, 404, { error: "not_found" });
      } else {
        if (route.handler !== "admin_metric_schedules_preview_replacement") await recordDashboardAudit(dependencies.pool, {
          tenantId: identity.tenantId,
          appId,
          actorRef: `admin_key:${identity.keyId}`,
          action: "metric_schedule_lifecycle",
          targetScope: "metric_schedule",
          targetRef: metricScheduleId(target.pathname) ?? "metric_schedule:new",
          outcome: "failed",
          reasonCode: reason,
        });
        json(response, scheduleConflict(reason)
          ? 409 : 400, { error: reason });
      }
    }
    return;
  };

  const adminCostSchedulesList = async ({ request, response, target, route, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      if (route.handler === "admin_cost_schedules_list") {
        json(response, 200, { data: await listCostSchedules(pool, appIdentity) });
      } else if (route.handler === "admin_cost_schedules_register") {
        json(response, 201, await registerCostSchedule(dependencies.pool, appIdentity, await decoder.json()));
      } else {
        const id = decodedPathPart(target.pathname, /\/cost-schedules\/([^/]+)\/disable$/);
        if (!id) throw new Error("cost_schedule_not_found");
        json(response, 200, await disableCostSchedule(dependencies.pool, appIdentity, id));
      }
    } catch (error) {
      const reason = publicReason(error, "cost_schedule_lifecycle_failed");
      json(response, error instanceof AppNotFoundError || reason === "cost_schedule_not_found" ? 404
        : ["cost_schedule_active_exists", "cost_schedule_not_active"].includes(reason) ? 409 : 400,
      { error: error instanceof AppNotFoundError || reason === "cost_schedule_not_found" ? "not_found" : reason });
    }
    return;
  };

  const adminMetricRecalculationsList = async ({ request, response, target, route, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      if (route.handler === "admin_metric_recalculations_list") {
        json(response, 200, { data: await listMetricRecalculations(pool, appIdentity) });
      } else {
        json(response, 202, await requestMetricRecalculation(dependencies.pool, appIdentity, await decoder.json()));
      }
    } catch (error) {
      const reason = publicReason(error, "metric_recalculation_failed");
      const notFound = error instanceof AppNotFoundError || ["cost_revision_not_found", "metric_revision_not_found"].includes(reason);
      json(response, notFound ? 404 : 400, { error: notFound ? "not_found" : reason });
    }
    return;
  };

  return {
    dashboard_metric_recalculations_list: { boundary: "dashboard_app", handle: dashboardMetricRecalculationsList },
    dashboard_metric_recalculations_preview: { boundary: "dashboard_app", handle: dashboardMetricRecalculationsPreview },
    dashboard_metric_recalculations_request: { boundary: "dashboard_app", handle: dashboardMetricRecalculationsPreview },
    dashboard_metric_schedules_list: { boundary: "dashboard_app", handle: dashboardMetricSchedulesList },
    dashboard_metric_schedules_register: { boundary: "dashboard_app", handle: dashboardMetricSchedulesRegister },
    dashboard_metric_schedules_disable: { boundary: "dashboard_app", handle: dashboardMetricSchedulesRegister },
    dashboard_metric_schedules_preview_replacement: { boundary: "dashboard_app", handle: dashboardMetricSchedulesReplacement },
    dashboard_metric_schedules_replace: { boundary: "dashboard_app", handle: dashboardMetricSchedulesReplacement },
    admin_metric_schedules_list: { boundary: "admin", handle: adminMetricSchedulesList },
    admin_metric_schedules_register: { boundary: "admin", handle: adminMetricSchedulesList },
    admin_metric_schedules_disable: { boundary: "admin", handle: adminMetricSchedulesList },
    admin_metric_schedules_preview_replacement: { boundary: "admin", handle: adminMetricSchedulesList },
    admin_metric_schedules_replace: { boundary: "admin", handle: adminMetricSchedulesList },
    admin_cost_schedules_list: { boundary: "admin", handle: adminCostSchedulesList },
    admin_cost_schedules_register: { boundary: "admin", handle: adminCostSchedulesList },
    admin_cost_schedules_disable: { boundary: "admin", handle: adminCostSchedulesList },
    admin_metric_recalculations_list: { boundary: "admin", handle: adminMetricRecalculationsList },
    admin_metric_recalculations_request: { boundary: "admin", handle: adminMetricRecalculationsList },
  } as const;
}
