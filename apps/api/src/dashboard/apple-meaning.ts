import { decodeConversionMeaning, meaningUpdate, type ConversionMeaning } from "../apple-conversion-meaning.js";
import { conversionMeaningBundle, meaningFormValues, type MeaningRegistration } from "../apple-meaning-configuration.js";
import { escapeHtml as e } from "./html.js";

const caution="Postback binding: unverified. This table describes the selected operator definition, not proof of which definition Apple used. Bucket ranges are not measured revenue; do not use midpoints, totals or ROAS. Missing values remain unknown.";
const shell=(app:string,body:string)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Apple conversion definition</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><nav><a href="/dashboard/apps/${encodeURIComponent(app)}">App overview</a> · <a href="/dashboard/apps/${encodeURIComponent(app)}/conversion-meanings">Conversion definitions</a></nav><h1>Apple conversion definition</h1><p>${caution}</p>${body}</main></body></html>`;
const hidden=(key:string,value:string)=>`<input type="hidden" name="${e(key)}" value="${e(value)}">`;
export function renderMeaningConfigurationForm(app:string,token:string,registrations:MeaningRegistration[],administer:boolean) {
  const base=`/dashboard/apps/${encodeURIComponent(app)}/conversion-meanings`;
  const input=(label:string,name:string,type="text",placeholder="")=>`<label>${label} <input name="${name}" type="${type}" required placeholder="${placeholder}"></label>`;
  const form=administer ? `<h2>Design event_revenue_v1</h2><p>One to three ordered event keys and two to eight increasing integer revenue boundaries (first: 0), at most 64 encoded states. Dates are inclusive/exclusive midnight UTC deployment declarations, not postback receipt dates. Choose the currency and scale explicitly; no FX or rounding occurs.</p><form method="post" action="${base}/preview">${hidden("csrf_token",token)}
    ${input("Immutable version","schema_version","text","2.0.0")}${input("Deployment from (inclusive UTC)","effective_from","date")}${input("Deployment to (exclusive UTC)","effective_to","date")}
    ${input("Ordered event keys, comma separated","event_keys","text","onboarding_complete,purchase")}${input("Revenue event key (one of those keys)","revenue_event_key","text","purchase")}
    ${input("Currency (uppercase ISO code)","currency","text","USD")}${input("Amount scale (0–6)","amount_scale","number","2")}
    ${input("Integer unscaled boundaries, comma separated","thresholds","text","0,100,500")}${input("Medium from fine value","medium_from","number","4")}${input("High from fine value","high_from","number","8")}
    <label>Lock only at maximum state <select name="lock_at_maximum"><option value="false">No</option><option value="true">Yes</option></select></label><button type="submit">Preview all states without saving</button></form>` : "<p>Administrator access is required to register a definition.</p>";
  const rows=registrations.map(r=>{const query=e(new URLSearchParams({schema_version:r.schema_version,schema_digest:r.schema_digest}).toString());
    return `<tr><td>${e(r.schema_version)}</td><td>${e(r.schema_digest)}</td><td>${e(r.created_at)}</td><td><a href="${base}/view?${query}">Inspect states</a> · <a href="${base}/bundle?${query}">Download SDK configuration</a></td></tr>`;}).join("");
  return shell(app,`${form}<h2>Latest 100 registered profile definitions</h2><p>Registration does not deploy a definition or select it for historical postbacks. Legacy definitions are unchanged and not listed here.</p><table><thead><tr><th>Version</th><th>SHA-256</th><th>Registered</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table><h2>Read an exact older definition</h2><form method="get" action="${base}/view">${input("Version","schema_version")}${input("SHA-256","schema_digest")}<button type="submit">Inspect exact definition</button></form>`);
}
export function renderMeaningConfiguration(app:string,definition:ConversionMeaning,token?:string,registered=false) {
  const base=`/dashboard/apps/${encodeURIComponent(app)}/conversion-meanings`,bundle=conversionMeaningBundle(definition);
  const size=2**definition.event_keys.length*definition.revenue.thresholds.length;
  const range=(r:{lower_inclusive:string;upper_exclusive:string|null;currency:string;amount_scale:number})=>`[${r.lower_inclusive}, ${r.upper_exclusive ?? "unbounded"}) ${r.currency}, unscaled / 10^${r.amount_scale}`;
  const rows=Array.from({length:64},(_,fine)=>{
    const meaning=decodeConversionMeaning(definition,`fine:${fine}`,"skan_4","0","download").possible_meanings?.[0];
    if(!meaning) return `<tr data-fine="${fine}"><th scope="row">${fine}</th><td colspan="4">${fine>=size ? "Outside this definition" : "Unreachable: revenue bucket without revenue event"}</td></tr>`;
    const update=meaningUpdate(definition,fine%2**definition.event_keys.length,BigInt(meaning.revenue_range.lower_inclusive));
    return `<tr data-fine="${fine}"><th scope="row">${fine}</th><td>${e(meaning.event_keys_observed.join(", ")||"None")}</td><td>${e(range(meaning.revenue_range))}</td><td>${e(update.coarse_value)}</td><td>${update.lock_postback ? "Yes" : "No"}</td></tr>`;
  }).join("");
  const coarse=["low","medium","high"].map(value=>{
    const meanings=decodeConversionMeaning(definition,`coarse:${value}`,"adattributionkit","1","download").possible_meanings ?? [];
    return `<tr><th scope="row">${value}</th><td>${meanings.map(m=>`${m.fine_value}: ${e(m.event_keys_observed.join(", ")||"None")} — ${e(range(m.revenue_range))}`).join("<br>")||"No reachable state"}</td></tr>`;
  }).join("");
  const query=e(new URLSearchParams({schema_version:bundle.schema_version,schema_digest:bundle.schema_digest}).toString());
  const action=registered ? `<p><a href="${base}/bundle?${query}">Download registered SDK configuration</a></p>`
    : token ? `<form method="post" action="${base}">${hidden("csrf_token",token)}${hidden("preview_digest",bundle.schema_digest)}${Object.entries(meaningFormValues(definition)).map(([k,v])=>hidden(k,v)).join("")}<button type="submit">Register this exact definition</button></form>` : "";
  return shell(app,`<h2>${registered?"Registered definition":"Unsaved preview"}</h2><dl><dt>Version</dt><dd>${e(bundle.schema_version)}</dd><dt>SHA-256</dt><dd>${e(bundle.schema_digest)}</dd><dt>Deployment period [from, to)</dt><dd>${e(definition.effective_from)} — ${e(definition.effective_to)}</dd><dt>Encoded capacity</dt><dd>${size} / 64</dd></dl>${action}<h2>All fine values (first-window profile explanation)</h2><table><thead><tr><th>Fine</th><th>Observed keys</th><th>Declared revenue range</th><th>Coarse</th><th>Lock</th></tr></thead><tbody>${rows}</tbody></table><h2>All coarse values (ambiguous possible meanings)</h2><table><thead><tr><th>Coarse</th><th>Possible fine states and ranges</th></tr></thead><tbody>${coarse}</tbody></table><p>Host-declared install windows only. Downloading is not SDK deployment, OS acceptance or postback delivery evidence. No remote automatic update is performed.</p>`);
}
export const renderMeaningFailure=(app:string,reason:string)=>shell(app,`<h2>Definition could not be confirmed</h2><p>${e(reason)}</p><p>Check saved versions before retrying registration. Correct invalid form fields using the previous page.</p>`);
