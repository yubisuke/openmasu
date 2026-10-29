import assert from "node:assert/strict";
import { it } from "node:test";
import { firstPartyWindowDefinition } from "@openmasu/contracts/definitions";
import { parseAttributionWindowRequest } from "./attribution-window-preview.js";
import { renderAttributionWindowSettings } from "./dashboard/attribution-window.js";

it("attribution window preview closes dates, watermarks and candidate definitions",()=>{
  const body={definition:firstPartyWindowDefinition(30),date_from:"2026-08-01",date_to:"2026-09-01",watermark_at_most:"2026-09-02T00:00:00.000Z"};
  const now=new Date("2026-09-03T00:00:00.000Z");
  assert.deepEqual(parseAttributionWindowRequest(body,now),body);
  for (const patch of [{date_to:"2026-09-02"},{date_from:"2026-02-30"},{date_to:body.date_from},
    {watermark_at_most:"2026-09-04T00:00:00.000Z"},{installation_id:"synthetic"},
    {definition:{...body.definition,lookback_days:2}}]) assert.throws(()=>parseAttributionWindowRequest({...body,...patch},now));
  const html=renderAttributionWindowSettings({appId:"app-a",csrfToken:"synthetic-csrf",current:{days:7,id:"attribution-default",
    version:"0.3.0",hash:"a".repeat(64),revision_id:null,activated_at:null}});
  assert.match(html,/Historical default/);assert.match(html,/never starts a backfill/);
  assert.doesNotMatch(html,/<script|javascript:|\son[a-z]+\s*=/i);
});
