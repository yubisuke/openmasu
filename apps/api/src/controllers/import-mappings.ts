import { ImportMappingRegistryError } from "@openmasu/runtime/import-mapping-registry";
import { requireRegisteredApp } from "../apps-admin.js";
import { adminAppId } from "../http-paths.js";
import { json } from "../http-responses.js";
import type { RequestHandlerDependencies } from "../http-types.js";
import { importMappingFailure, listImportMappingRevisions, previewImportMappingHeaders, saveImportMappingRevision } from "../import-mapping-revisions.js";
import type { AdminRequestContext } from "./context.js";

export function createImportMappingsControllers(dependencies: Pick<RequestHandlerDependencies, "payloadStore">) {
  const admin = async ({ response, target, route, pool, identity, decoder }: AdminRequestContext): Promise<void> => {
    try {
      const app = await requireRegisteredApp(pool, identity, adminAppId(target.pathname) ?? "");
      if (route.handler === "admin_import_mappings_list") {
        json(response, 200, await listImportMappingRevisions(pool, app, target.searchParams));
      } else {
        if (target.searchParams.size) throw new ImportMappingRegistryError("import_mapping_invalid");
        const body = await decoder.json();
        if (route.handler === "admin_import_mappings_register") {
          json(response, 201, await saveImportMappingRevision(pool, dependencies.payloadStore, app, body));
        } else {
          // The app pool can read the private reference; preview never persists anything.
          json(response, 200, await previewImportMappingHeaders(pool, dependencies.payloadStore, app, body));
        }
      }
    } catch (error) { const failure = importMappingFailure(error); json(response, failure.status, { error: failure.code }); }
  };
  return {
    admin_import_mappings_list: { boundary: "admin" as const, handle: admin },
    admin_import_mappings_register: { boundary: "admin" as const, handle: admin },
    admin_import_mappings_preview: { boundary: "admin" as const, handle: admin },
  };
}
