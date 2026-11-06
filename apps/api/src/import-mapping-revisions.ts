import type { Pool } from "pg";
import type { PayloadStore } from "@openmasu/runtime";
import {
  ImportMappingRegistryError, listImportMappingRevisions, previewImportMappingHeaders, registerImportMappingRevision,
} from "@openmasu/runtime/import-mapping-registry";
import type { AppAdminIdentity } from "./admin-auth.js";
import { AppNotFoundError } from "./apps-admin.js";
import { recordDashboardAuditWithClient } from "./session.js";
import { configurationChange } from "./configuration-change.js";

export { listImportMappingRevisions, previewImportMappingHeaders };

export function saveImportMappingRevision(pool: Pool, payloadStore: PayloadStore, identity: AppAdminIdentity, body: unknown) {
  return registerImportMappingRevision({ pool, payloadStore, scope: identity, body,
    onRegistered: async (client, metadata) => {
      const prior = (await client.query<{ definition_digest: string; kind: string; header_count: number }>(
        `SELECT definition_digest,kind,header_count FROM control.import_mapping_revisions
         WHERE tenant_id=$1 AND app_id=$2 AND mapping_id=$3 AND revision=$4`,
        [identity.tenantId, identity.appId, metadata.mapping_id, metadata.revision - 1])).rows[0];
      const reference = (number: number) => `mapping:${metadata.mapping_id}:${number}`;
      await recordDashboardAuditWithClient(client, { tenantId: identity.tenantId, appId: identity.appId,
        actorRef: `admin_key:${identity.keyId}`, action: "import_mapping_revision_registered", targetScope: "app",
        targetRef: reference(metadata.revision), outcome: "succeeded", now: new Date(metadata.created_at),
        configurationChange: configurationChange("import_mapping", prior ? reference(metadata.revision - 1) : null, prior ?? null,
          reference(metadata.revision), { definition_digest: metadata.definition_digest, kind: metadata.kind, header_count: metadata.header_count }) });
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
