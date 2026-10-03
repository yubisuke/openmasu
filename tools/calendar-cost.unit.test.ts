import assert from "node:assert/strict";
import { it } from "node:test";
import { parseCsv } from "@openmasu/runtime/import-normalization";
import { loadMapping, mapRow } from "../apps/worker/src/import/mapping.js";
import { normalizeCostInput } from "../apps/worker/src/import/cost-cli.js";
import { costArtifact, prepareCostImportRows } from "../apps/worker/src/import/cost.js";
import { syntheticCalendarCostCsv } from "./synthetic-calendar-cohort-cases.js";

it("calendar_cost_mapping_retains_an_explicit_zone_and_never_guesses_a_missing_one",()=>{
  const mapping = loadMapping("examples/mappings/synthetic-calendar-cost.json");
  const row = parseCsv(syntheticCalendarCostCsv)[0];
  const input = normalizeCostInput(mapping,mapRow(mapping,row));
  assert.equal(input.reporting_time_zone,"America/New_York");
  assert.equal(costArtifact(input,"6".repeat(64)).reporting_time_zone,"America/New_York");
  const missing = normalizeCostInput(mapping,mapRow(mapping,{...row,reporting_time_zone:""}));
  assert.equal(Object.hasOwn(missing,"reporting_time_zone"),false);
  assert.equal(Object.hasOwn(costArtifact(missing,"6".repeat(64)),"reporting_time_zone"),false);
  assert.equal(prepareCostImportRows([input,{...input,reporting_time_zone:"UTC"}]).length,2);
  assert.throws(()=>normalizeCostInput(mapping,mapRow(mapping,{...row,reporting_time_zone:"synthetic-unknown"})),/unsupported/);
});
