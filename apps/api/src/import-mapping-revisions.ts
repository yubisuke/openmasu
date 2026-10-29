import type { Pool } from "pg";
import type { PayloadStore } from "@openmasu/runtime";
import {
  ImportMappingRegistryError, listImportMappingRevisions, previewImportMappingHeaders, registerImportMappingRevision,
} from "@openmasu/runtime/import-mapping-registry";
import type { AppAdminIdentity } from "./admin-auth.js";
import { AppNotFoundError } from "./apps-admin.js";
import { recordDashboardAuditWithClient } from "./session.js";

export { listImportMappingRevisions, previewImportMappingHeaders };

export function saveImportMappingRevision(pool: Pool, payloadStore: PayloadStore, identity: AppAdminIdentity, body: unknown) {
  return registerImportMappingRevision({ pool, payloadStore, scope: identity, body,
    onRegistered: async (client, metadata) => {
      await recordDashboardAuditWithClient(client, { tenantId: identity.tenantId, appId: identity.appId,
        actorRef: `admin_key:${identity.keyId}`, action: "import_mapping_revision_registered", targetScope: "app",
        targetRef: `mapping:${metadata.mapping_id}:${metadata.revision}`, outcome: "succeeded" });
    },
  });
}

/** Closed errors only: mapping values and storage/database parameters are private. */
export function importMappingFailure(error: unknown): { status: number; code: string } {
  if (error instanceof AppNotFoundError || error instanceof ImportMappingRegistryError && error.status === 404) {
    return { status: 404, code: "not_found" };
  }
  if (error instanceof ImportMappingRegistryError) return { status: error.status, code: error.code };
  if (error instanceof SyntaxError) return { status: 400, code: "import_mapping_invalid" };
  if (error instanceof Error && error.message === "request_too_large") return { status: 413, code: "import_mapping_too_large" };
  return { status: 503, code: "import_mapping_unavailable" };
}
