import assert from "node:assert/strict";
import { it } from "node:test";
import { EnvironmentSecretStore, normalizeGoogleCostDetail, normalizeCostRefreshDefinition, costAdapterCapability } from "@openmasu/runtime";
import { fetchGoogleAds, type FetchLike } from "./adapters.js";

const detail = { version:1,grain:"ad",coverage:"explicit_selection",country_scope:"all",selections:[
  { campaign_id:"43601",ad_group_id:"43602",provider_ad_id:"43603",creative_id:"synthetic-creative-one" } ] };
const row = { campaign:{ id:"43601" },adGroup:{ id:"43602" },adGroupAd:{ ad:{ id:"43603" } },customer:{ currencyCode:"USD" },segments:{ date:"2026-08-20" },metrics:{ costMicros:"1250000" } };
const secrets = new EnvironmentSecretStore({ OPENMASU_GOOGLE_ADS_ACCESS_TOKEN:{ value:"synthetic-detail-token" }, OPENMASU_GOOGLE_ADS_DEVELOPER_TOKEN:{ value:"synthetic-developer-token" } });
const options = (fetch:FetchLike, selected:unknown=detail) => ({ fetch,secrets,customerId:"4300000000",since:"2026-08-20",until:"2026-08-20",
  scope:{ tenant_id:"tenant-synthetic-detail",app_id:"app-synthetic-detail",currency:"USD",as_of:"2026-08-21T00:00:00.000Z" },detail:normalizeGoogleCostDetail(selected) });

it("selected_google_costs_preserve_explicit_ad_binding_exact_micro_money_and_declared_country_grain",async()=>{
  const queries:string[]=[];
  const fetch:FetchLike=async(_url,init)=>{ queries.push(JSON.parse(String(init?.body)).query); return Response.json([{ results:[structuredClone(row)] }]); };
  const rows=await fetchGoogleAds(options(fetch));
  assert.equal(queries.length,1); assert.match(queries[0],/FROM ad_group_ad/); assert.doesNotMatch(queries[0],/geo_target|geographic_view|campaign\.name|ad\.name/);
  assert.equal(rows[0].creative_id,"synthetic-creative-one"); assert.equal(rows[0].amount_unscaled,"1250000"); assert.equal(rows[0].amount_scale,6); assert.equal(rows[0].country,undefined);
  const normalized=normalizeCostRefreshDefinition({ provider:"google_ads",customer_id:"4300000000",currency:"USD",detail });
  assert.deepEqual(normalizeCostRefreshDefinition(normalized),normalized);
  assert.deepEqual(costAdapterCapability(normalized),{ version:1,provider:"google_ads",api_version:"v25",grain:"ad",coverage:"explicit_selection",country_scope:"all",creative_binding:"operator_explicit",selection_count:1,upstream_completeness:"unknown" });
  const group={ ...detail,grain:"ad_group",country_scope:"geo_country",selections:[{ campaign_id:"43601",ad_group_id:"43602" }] };
  const groupOptions=options(async(_url,init)=>{
    const query=JSON.parse(String(init?.body)).query;
    return Response.json([{ results:query.includes("FROM geo_target_constant") ? [{ geoTargetConstant:{ id:"2840",countryCode:"US" } }]
      : [{ ...row,adGroupAd:undefined,segments:{ ...row.segments,geoTargetCountry:"geoTargetConstants/2840" } }] }]);
  },group);
  const grouped=await fetchGoogleAds(groupOptions); assert.equal(grouped[0].country,"US"); assert.equal(grouped[0].creative_id,undefined);
});
it("selected_google_costs_reject_duplicate_unknown_parent_partial_and_unsupported_grains_before_returning_rows",async()=>{
  for(const bad of [{ ...detail,country_scope:"geo_country" },{ ...detail,grain:"campaign" },{ ...detail,selections:[...detail.selections,...detail.selections] },
    { ...detail,selections:[{ campaign_id:"43601",ad_group_id:"43602",provider_ad_id:"43603" }] },{ ...detail,selections:Array(101).fill(detail.selections[0]) }]) assert.throws(()=>normalizeGoogleCostDetail(bad),/cost_detail_/);
  for(const response of [[{ results:[row,row] }],[{ results:[{ ...row,adGroupAd:{ ad:{ id:"43609" } } }] }],
    [{ results:[{ ...row,adGroup:undefined,adGroupAd:undefined }] }],[{ results:[row] },{ error:{ message:"synthetic partial failure" } }],
    [{ results:[row],nextPageToken:"synthetic-unread-page" }],[{ results:[{ ...row,segments:{ ...row.segments,geoTargetCountry:"geoTargetConstants/2840" } }] }]]) {
    await assert.rejects(fetchGoogleAds(options(async()=>Response.json(response))),/Google Ads/);
  }
  await assert.rejects(fetchGoogleAds(options(async()=>new Response('[{"results":[', { status:200 }))),/valid JSON/);
});
