import { requireRegisteredApp } from "../apps-admin.js";
import { executePrivacyRequest, privacyResponseStatus, privacySubjectDigest, type PrivacyRequestBody } from "../privacy.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { AdminRequestContext } from "./context.js";
import { json } from "../http-responses.js";

export function createPrivacyControllers(dependencies: Pick<RequestHandlerDependencies, "pool" | "privacySubjectDigestKey" | "server" | "sdk" | "payloadStore">) {
  const adminPrivacy = async ({ request, response, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    try {
      const body = await decoder.json() as PrivacyRequestBody;
      const appIdentity = await requireRegisteredApp(dependencies.pool, identity, String(body.app_id ?? ""));
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
  } as const;
}
