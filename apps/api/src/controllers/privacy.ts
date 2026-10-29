import { AppNotFoundError, requireRegisteredApp } from "../apps-admin.js";
import { executePrivacyRequest, privacyResponseStatus, privacySubjectDigest, type PrivacyRequestBody } from "../privacy.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { AdminRequestContext, DashboardAppContext } from "./context.js";
import { dashboardHtml, json } from "../http-responses.js";
import { adminAppId } from "../http-paths.js";
import { parsePrivacyJobRequest, privacyJobProgress, PrivacyJobQueryError } from "../privacy-job-reports.js";
import { renderPrivacyJobs } from "../dashboard/privacy-jobs.js";

export function createPrivacyControllers(dependencies: Pick<RequestHandlerDependencies, "pool" | "privacySubjectDigestKey" | "server" | "sdk" | "payloadStore">) {
  const adminPrivacyJobs = async ({ response, target, pool, identity }: AdminRequestContext): Promise<void> => {
    try {
      const appIdentity = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      const requestId = parsePrivacyJobRequest(target);
      const page = await privacyJobProgress(pool, appIdentity, requestId);
      if (requestId !== undefined && !page.data.length) {
        json(response, 404, { error: "privacy_job_not_found" });
        return;
      }
      json(response, 200, page);
    } catch (error) {
      if (error instanceof AppNotFoundError) json(response, 404, { error: "app_not_found" });
      else if (error instanceof PrivacyJobQueryError) json(response, 400, { error: error.message });
      else json(response, 503, { error: "privacy_job_unavailable" });
    }
  };
  const dashboardPrivacyJobs = async ({ response, target, pool, appIdentity }: DashboardAppContext): Promise<void> => {
    try {
      const requestId = parsePrivacyJobRequest(target);
      const page = await privacyJobProgress(pool, appIdentity, requestId);
      const missing = requestId !== undefined && !page.data.length;
      dashboardHtml(response, missing ? 404 : 200, renderPrivacyJobs(appIdentity.appId, page,
        missing ? "privacy_job_not_found" : undefined));
    } catch (error) {
      const invalid = error instanceof PrivacyJobQueryError;
      dashboardHtml(response, invalid ? 400 : 503, renderPrivacyJobs(appIdentity.appId, { data: [], has_more: false },
        invalid ? "privacy_job_query_invalid" : "privacy_job_unavailable"));
    }
  };
  const adminPrivacy = async ({ request, response, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    try {
      const body = await decoder.json() as PrivacyRequestBody;
      const appIdentity = await requireRegisteredApp(dependencies.pool, identity, String(body.app_id ?? ""));
      if (identity.appScope !== undefined && body.deletion_scope === "tenant") {
        json(response, 403, { error: "forbidden" });
        return;
      }
      const digestKey = dependencies.privacySubjectDigestKey
        ?? dependencies.server?.installationDigestKey
        ?? dependencies.sdk?.config.installationDigestKey;
      if (!digestKey) {
        const error = new Error("privacy_subject_digest_key_unavailable");
        (error as { statusCode?: number }).statusCode = 503;
        throw error;
      }
      const deletionSubjectDigest = privacySubjectDigest(digestKey, body);
      const result = await executePrivacyRequest(
        dependencies.pool,
        { ...appIdentity, deletionSubjectDigest },
        body,
        dependencies.payloadStore,
      );
      json(response, privacyResponseStatus(result), result);
    } catch (error) {
      const status = Number((error as { statusCode?: number }).statusCode ?? (error instanceof SyntaxError ? 400 : 500));
      json(response, status, { error: error instanceof Error ? error.message : "privacy_request_failed" });
    }
    return;
  };

  return {
    admin_privacy: { boundary: "admin", handle: adminPrivacy },
    admin_privacy_jobs: { boundary: "admin", handle: adminPrivacyJobs },
    dashboard_privacy_jobs: { boundary: "dashboard_app", handle: dashboardPrivacyJobs },
  } as const;
}
