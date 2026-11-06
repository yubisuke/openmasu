import type { RequestHandlerDependencies } from "../http-types.js";
import type { DashboardAppContext } from "./context.js";
import { roleAllows } from "../authorization.js";
import { csrfToken } from "../session.js";
import { authorizeDashboardForm } from "../http-security.js";
import { dashboardHeaders, dashboardHtml } from "../http-responses.js";
import { registerConversionSchema } from "../apple-admin.js";
import { conversionMeaningBundle, listMeaningConfigurations, parseMeaningForm, readMeaningConfiguration } from "../apple-meaning-configuration.js";
import { renderMeaningConfiguration, renderMeaningConfigurationForm, renderMeaningFailure } from "../dashboard/apple-meaning.js";

export function createAppleMeaningsControllers(dependencies:Pick<RequestHandlerDependencies,"pool"|"dashboard">) {
  const handle=async(context:DashboardAppContext)=>{
    const {route,pool,appIdentity,appId,response,target,session,decoder}=context;
    try {
      if(route.handler==="dashboard_meanings_list") {
        if(target.searchParams.size) throw Error("conversion_meaning_form_invalid");
        dashboardHtml(response,200,renderMeaningConfigurationForm(appId,csrfToken(session.token),await listMeaningConfigurations(pool,appIdentity),roleAllows(session.role,"administer")));return;
      }
      if(route.handler==="dashboard_meanings_read" || route.handler==="dashboard_meanings_export") {
        const saved=await readMeaningConfiguration(pool,appIdentity,target.searchParams);
        if(route.handler==="dashboard_meanings_read") dashboardHtml(response,200,renderMeaningConfiguration(appId,saved.definition,undefined,true));
        else response.writeHead(200,{...dashboardHeaders,"content-type":"application/json; charset=utf-8","content-disposition":'attachment; filename="openmasu-conversion-meaning.json"'}).end(`${JSON.stringify(saved.bundle)}\n`);
        return;
      }
      if(target.searchParams.size) throw Error("conversion_meaning_form_invalid");
      const form=await decoder.form();
      if(!await authorizeDashboardForm(dependencies,context,form,"conversion_meaning_configuration","app",appId)) return;
      const definition=parseMeaningForm(form),bundle=conversionMeaningBundle(definition);
      if(route.handler==="dashboard_meanings_preview") {dashboardHtml(response,200,renderMeaningConfiguration(appId,definition,csrfToken(session.token)));return;}
      if(form.get("preview_digest")!==bundle.schema_digest) throw Error("conversion_meaning_preview_changed");
      await registerConversionSchema({pool,identity:appIdentity,schemaVersion:definition.schema_version,definition});
      response.writeHead(303,{...dashboardHeaders,location:`/dashboard/apps/${encodeURIComponent(appId)}/conversion-meanings/view?${new URLSearchParams({schema_version:bundle.schema_version,schema_digest:bundle.schema_digest})}`}).end();
    } catch(error) {
      const code=(error as Error).message;
      const known=new Set(["conversion_meaning_form_invalid","conversion_meaning_invalid","conversion_meaning_not_found","conversion_meaning_integrity_failed",
        "conversion_meaning_preview_changed","conversion_schema_version_already_registered"]);
      const status=code==="request_too_large"?413:code==="conversion_meaning_not_found"?404:
        ["conversion_meaning_integrity_failed","conversion_meaning_preview_changed","conversion_schema_version_already_registered"].includes(code)?409:known.has(code)?400:503;
      dashboardHtml(response,status,renderMeaningFailure(appId,known.has(code)?code:code==="request_too_large"?"request_too_large":"conversion_meaning_unavailable"));
    }
  };
  return {dashboard_meanings_list:{boundary:"dashboard_app" as const,handle},dashboard_meanings_read:{boundary:"dashboard_app" as const,handle},
    dashboard_meanings_export:{boundary:"dashboard_app" as const,handle},dashboard_meanings_preview:{boundary:"dashboard_app" as const,handle},
    dashboard_meanings_register:{boundary:"dashboard_app" as const,handle}};
}
