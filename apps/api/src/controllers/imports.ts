import { confirmManagedUpload, createManagedUpload, listManagedUploads, readManagedUpload, ManagedImportError, managedImportLimits } from "@openmasu/runtime/managed-imports";
import { listImportMappingRevisions } from "@openmasu/runtime/import-mapping-registry";
import type { RequestHandlerDependencies } from "../http-types.js";
import type { DashboardAppContext } from "./context.js";
import { roleAllows } from "../authorization.js";
import { csrfToken, recordDashboardAuditWithClient } from "../session.js";
import type { PoolClient } from "pg";
import { authorizeDashboardForm } from "../http-security.js";
import { dashboardHeaders, dashboardHtml } from "../http-responses.js";
import { importMappingFailure, saveImportMappingRevision } from "../import-mapping-revisions.js";
import { renderManagedImport, renderManagedImports } from "../dashboard/imports.js";
import { renderMetricScheduleOperationFailed } from "../dashboard/action-pages.js";
import { managedImportFields, managedImportScalar, readManagedImportForm } from "../managed-import-form.js";

export function createImportsControllers(dependencies: Pick<RequestHandlerDependencies,"pool"|"readerPool"|"dashboard"|"payloadStore">) {
  const handle = async (context: DashboardAppContext): Promise<void> => {
    const { request,response,target,route,pool,session,appId,appIdentity,decoder }=context;
    const base=`/dashboard/apps/${encodeURIComponent(appId)}/imports`, token=csrfToken(session.token), operate=roleAllows(session.role,"operate");
    const redirect=(path:string)=>response.writeHead(303,{...dashboardHeaders,location:path}).end();
    const audit = (action: string) => async (client: PoolClient, id: string) => {
      await recordDashboardAuditWithClient(client, { tenantId: appIdentity.tenantId, appId,
        actorRef: `admin_key:${appIdentity.keyId}`, action, targetScope: "app", targetRef: `import:${id}`, outcome: "succeeded" });
    };
    try {
      if(route.handler==="dashboard_imports_list") {
        const mappings=await listImportMappingRevisions(pool,appIdentity,target.searchParams);
        dashboardHtml(response,200,renderManagedImports(appId,mappings.data,await listManagedUploads(pool,appIdentity),token,operate,roleAllows(session.role,"administer"),mappings.next_revision));
        return;
      }
      if(target.searchParams.size) throw new ManagedImportError("import_form_invalid");
      if(route.handler==="dashboard_imports_read") {
        dashboardHtml(response,200,renderManagedImport(appId,await readManagedUpload(pool,appIdentity,target.pathname.split("/").at(-1)!),token,operate));return;
      }
      if(route.handler==="dashboard_imports_upload") {
        const form=await readManagedImportForm(request);
        managedImportFields(form,["csrf_token","selection","csv"]);
        const csrf=new URLSearchParams({csrf_token:managedImportScalar(form,"csrf_token")});
        if(!await authorizeDashboardForm(dependencies,context,csrf,"csv_import_upload","app",appId)) return;
        const selected=managedImportScalar(form,"selection").split("@");
        if(selected.length!==2 || !/^[1-9][0-9]*$/.test(selected[1])) throw new ManagedImportError("import_form_invalid");
        const file=form.get("csv");
        if(!file || typeof file==="string") throw new ManagedImportError("import_csv_required");
        if(!file.size || file.size>managedImportLimits.maxBytes) throw new ManagedImportError("import_upload_size",413);
        const id=await createManagedUpload(pool,dependencies.payloadStore,appIdentity,{mapping_id:selected[0],revision:Number(selected[1])},Buffer.from(await file.arrayBuffer()),new Date(),audit("csv_import_uploaded"));
        redirect(`${base}/${id}`);return;
      }
      const form=await decoder.form();
      if(!await authorizeDashboardForm(dependencies,context,form,"csv_import_mutation","app",appId)) return;
      if(route.handler==="dashboard_imports_register_mapping") {
        managedImportFields(form,["csrf_token","definition"]);
        await saveImportMappingRevision(pool,dependencies.payloadStore,appIdentity,JSON.parse(managedImportScalar(form,"definition")));
        redirect(base);return;
      }
      managedImportFields(form,["csrf_token","confirmation_digest"]);
      const id=target.pathname.split("/").at(-2)!;
      await confirmManagedUpload(pool,dependencies.payloadStore,appIdentity,id,managedImportScalar(form,"confirmation_digest"),new Date(),audit("csv_import_confirmed"));
      redirect(`${base}/${id}`);
    } catch(error) {
      const failure=error instanceof ManagedImportError ? {status:error.status,code:error.code}
        : (error as Error).message==="request_too_large" ? {status:413,code:"import_upload_size"} : importMappingFailure(error);
      dashboardHtml(response,failure.status,renderMetricScheduleOperationFailed({appId,reason:failure.code}));
    }
  };
  return {
    dashboard_imports_list:{boundary:"dashboard_app" as const,handle},
    dashboard_imports_read:{boundary:"dashboard_app" as const,handle},
    dashboard_imports_upload:{boundary:"dashboard_app" as const,handle},
    dashboard_imports_confirm:{boundary:"dashboard_app" as const,handle},
    dashboard_imports_register_mapping:{boundary:"dashboard_app" as const,handle},
  };
}
