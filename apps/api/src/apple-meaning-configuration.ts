import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { withTenant } from "@openmasu/runtime";
import { canonicalConversionSchema } from "./apple-admin.js";
import { parseConversionMeaning, type ConversionMeaning } from "./apple-conversion-meaning.js";

export const meaningFormFields = ["schema_version","effective_from","effective_to","event_keys","revenue_event_key",
  "currency","amount_scale","thresholds","medium_from","high_from","lock_at_maximum"] as const;
const invalid = (): never => { throw new Error("conversion_meaning_form_invalid"); };
export function parseMeaningForm(form: URLSearchParams): ConversionMeaning {
  const allowed: readonly string[] = [...meaningFormFields,"csrf_token","preview_digest"];
  if ([...form.keys()].some(key => !allowed.includes(key) || form.getAll(key).length !== 1)) invalid();
  const value = (key: string): string => { const v=form.get(key); return v === null ? invalid() : v.trim(); };
  const integer = (key: string): number => { const v=value(key); return /^(0|[1-9][0-9]{0,2})$/.test(v) ? Number(v) : invalid(); };
  const midnight = (key: string): string => { const v=value(key); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00.000Z` : invalid(); };
  const lock=value("lock_at_maximum"); if (!["true","false"].includes(lock)) invalid();
  if(value("schema_version").length>128) invalid();
  return parseConversionMeaning({profile:"event_revenue_v1",schema_version:value("schema_version"),
    effective_from:midnight("effective_from"),effective_to:midnight("effective_to"),
    event_keys:value("event_keys").split(/[\r\n,]+/).map(x=>x.trim()),
    revenue:{event_key:value("revenue_event_key"),currency:value("currency"),amount_scale:integer("amount_scale"),
      thresholds:value("thresholds").split(/[\r\n,]+/).map(x=>x.trim())},
    coarse:{medium_from:integer("medium_from"),high_from:integer("high_from")},lock_at_maximum:lock==="true"});
}
export function meaningFormValues(definition: ConversionMeaning): Record<typeof meaningFormFields[number],string> {
  return {schema_version:definition.schema_version,effective_from:definition.effective_from.slice(0,10),effective_to:definition.effective_to.slice(0,10),
    event_keys:definition.event_keys.join(","),revenue_event_key:definition.revenue.event_key,currency:definition.revenue.currency,
    amount_scale:String(definition.revenue.amount_scale),thresholds:definition.revenue.thresholds.join(","),
    medium_from:String(definition.coarse.medium_from),high_from:String(definition.coarse.high_from),lock_at_maximum:String(definition.lock_at_maximum)};
}
export function conversionMeaningBundle(definition: ConversionMeaning) {
  const canonical_definition=canonicalConversionSchema(parseConversionMeaning(definition));
  return {format:"openmasu.apple-conversion-meaning.v1" as const,schema_version:definition.schema_version,
    schema_digest:createHash("sha256").update(canonical_definition,"utf8").digest("hex"),canonical_definition};
}
type Scope = {tenantId:string;appId:string};
export type MeaningRegistration = {schema_version:string;schema_digest:string;created_at:string};
export async function listMeaningConfigurations(pool: Pool, scope: Scope): Promise<MeaningRegistration[]> {
  return withTenant(pool,scope.tenantId,async client=>(await client.query<MeaningRegistration>(`SELECT schema_version,schema_digest,created_at
    FROM control.conversion_schemas WHERE tenant_id=$1 AND app_id=$2 AND definition->>'profile'='event_revenue_v1'
    ORDER BY created_at DESC,conversion_schema_id DESC LIMIT 100`,[scope.tenantId,scope.appId])).rows);
}
/** Never export a latest-version guess or change a saved definition. */
export async function readMeaningConfiguration(pool:Pool,scope:Scope,params:URLSearchParams) {
  const version=params.get("schema_version"),digest=params.get("schema_digest");
  if ([...params.keys()].some(k=>!["schema_version","schema_digest"].includes(k) || params.getAll(k).length!==1)
      || !version || version.length>128 || !/^\d+\.\d+\.\d+$/.test(version) || !digest || !/^[a-f0-9]{64}$/.test(digest)) invalid();
  const row=await withTenant(pool,scope.tenantId,async client=>(await client.query<{definition:unknown}>(`SELECT definition
    FROM control.conversion_schemas WHERE tenant_id=$1 AND app_id=$2 AND schema_version=$3 AND schema_digest=$4`,
  [scope.tenantId,scope.appId,version,digest])).rows[0]);
  if (!row) throw new Error("conversion_meaning_not_found");
  let definition:ConversionMeaning;
  try { definition=parseConversionMeaning(row.definition); } catch { throw new Error("conversion_meaning_integrity_failed"); }
  const bundle=conversionMeaningBundle(definition);
  if(bundle.schema_version!==version || bundle.schema_digest!==digest) throw new Error("conversion_meaning_integrity_failed");
  return {definition,bundle};
}
