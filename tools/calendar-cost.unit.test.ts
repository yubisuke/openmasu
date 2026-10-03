import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { parseCsv } from "@openmasu/runtime/import-normalization";
import { loadMapping, mapRow } from "../apps/worker/src/import/mapping.js";
import { normalizeCostInput } from "../apps/worker/src/import/cost-cli.js";
import { costArtifact, prepareCostImportRows } from "../apps/worker/src/import/cost.js";
import { syntheticCalendarCostCsv, syntheticCalendarCohortCases } from "./synthetic-calendar-cohort-cases.js";

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

it("calendar_cost_zone_mutations_keep_valid_unique_dated_revision_inputs",()=>{
  const source = JSON.parse(readFileSync("fixtures/v0.4/68-calendar-acquisition-cohorts/input.json","utf8"));
  for (const entry of syntheticCalendarCohortCases(source)) {
    const keys = entry.input.cost_records.map((cost: Record<string,unknown>) =>
      JSON.stringify([cost.tenant_id,cost.app_id,cost.date,cost.dimension_digest,cost.as_of]));
    assert.equal(new Set(keys).size,keys.length,entry.name);
    if (/calendar_(missing|different)_cost/.test(entry.name)) assert.equal(keys.length,6);
  }
});
