import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectDisjointCosts, costCoverageMatchesGrouping, type ScopedCost } from "./cost-selection.js";

type Cost = ScopedCost & { amount_unscaled: string };
const base: Cost = {
  tenant_id: "synthetic-tenant", app_id: "synthetic-app", network: "synthetic-network",
  campaign_id: "synthetic-campaign", date: "2026-08-06", as_of: "2026-08-12T00:00:00.000Z",
  cost_record_id: "parent", amount_unscaled: "100000000",
};
const child = (id: string, amount: string): Cost => ({ ...base,
  cost_record_id: id, ad_group_id: id, amount_unscaled: amount });

describe("explicit disjoint cost selection", () => {
  it("selected_child_coverage_cannot_supply_a_campaign_or_unselected_sibling_denominator", () => {
    const selected: Cost = { ...child("group-a","40000000"),creative_id:"synthetic-creative",coverage_scope:"matching_detail_only" };
    assert.equal(costCoverageMatchesGrouping(selected,{ campaign_id:base.campaign_id! },true),false);
    assert.equal(costCoverageMatchesGrouping(selected,{ ad_group_id:"group-a" },true),false);
    assert.equal(costCoverageMatchesGrouping(selected,{ ad_group_id:"group-a",creative_id:"synthetic-creative" },true),true);
    assert.equal(costCoverageMatchesGrouping(selected,{ ad_group_id:"group-a",creative_id:"synthetic-other" },true),false);
    assert.equal(costCoverageMatchesGrouping(selected,{ ad_group_id:"group-a",creative_id:"synthetic-creative" },false),false);
    assert.equal(costCoverageMatchesGrouping({ ...selected,creative_id:null },{ ad_group_id:"group-a" },true),true);
    assert.equal(costCoverageMatchesGrouping(base,undefined,false),true);
    const historical = child("group-a","8000000");
    const revised = {...historical,cost_record_id:"selected-revision",as_of:"2026-08-13T00:00:00.000Z",coverage_scope:"matching_detail_only" as const};
    assert.deepEqual(selectDisjointCosts([historical,revised],true,
      cost=>costCoverageMatchesGrouping(cost,{campaign_id:base.campaign_id!},true)).rows,[],"ineligible latest coverage must not revive historical spend");
    assert.deepEqual(selectDisjointCosts([historical,revised],true,
      cost=>costCoverageMatchesGrouping(cost,{ad_group_id:"group-a"},true)).rows,[revised]);
  });
  it("flags parent 100 plus detail 40/60 but preserves all evidence candidates", () => {
    const input = [base, child("group-a", "40000000"), child("group-b", "60000000")];
    const selection = selectDisjointCosts(input);
    assert.equal(selection.overlapping, true);
    assert.equal(selection.rows.length, 3);
    assert.deepEqual(selectDisjointCosts([...input].reverse()), selection);
    const children = selectDisjointCosts(input.slice(1));
    assert.equal(children.overlapping, false);
    assert.equal(children.rows.reduce((total, row) => total + BigInt(row.amount_unscaled), 0n), 100000000n);
  });

  it("selects latest revisions before overlap checks and preserves distinct acquisition dates", () => {
    const initial = child("group-a", "40000000");
    const revised = { ...initial, cost_record_id: "revised", amount_unscaled: "50000000",
      as_of: "2026-08-13T00:00:00.000Z" };
    const nextDate = { ...initial, cost_record_id: "next-date", date: "2026-08-07" };
    const selection = selectDisjointCosts([initial, revised, nextDate]);
    assert.equal(selection.overlapping, false);
    assert.deepEqual(selection.rows.map((row) => row.cost_record_id), ["next-date", "revised"]);
  });

  it("rejects intersecting ad-group/country cuts without guessing from equal amounts", () => {
    const ad = child("group-a", "40000000");
    const country = { ...base, cost_record_id: "country", country: "US", amount_unscaled: "13000000" };
    assert.equal(selectDisjointCosts([ad, country]).overlapping, true);
    assert.equal(selectDisjointCosts([ad, { ...ad, cost_record_id: "detail", country: "US" }]).overlapping, true);
    assert.equal(selectDisjointCosts([ad, { ...child("group-b", "60000000"), country: "US" }]).overlapping, false);
    assert.equal(selectDisjointCosts([country, { ...country, cost_record_id: "country-jp", country: "JP" }]).overlapping, false);
  });

  it("treats missing campaign coverage conservatively and keeps tenant/app/network/date scopes separate", () => {
    assert.equal(selectDisjointCosts([base, { ...base, cost_record_id: "unallocated", campaign_id: null }]).overlapping, true);
    for (const changed of [{ tenant_id: "other-tenant" }, { app_id: "other-app" },
      { network: "other-network" }, { campaign_id: "other-campaign" }, { date: "2026-08-07" }]) {
      assert.equal(selectDisjointCosts([base, { ...base, ...changed, cost_record_id: "other" }]).overlapping, false);
    }
  });
});
