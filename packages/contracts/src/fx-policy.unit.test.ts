import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { canonicalDatedFxPolicy, validDatedFxPolicy, selectDatedFxRate, projectDatedFxSnapshot } from "./fx-policy.js";

const policy = JSON.parse(readFileSync("fixtures/v0.4/69-dated-fx-cohorts/input.json","utf8")).fx_policy;
it("dated_FX_canonical_order_preserves_dates_source_and_input_without_lookup", () => {
  const reversed = structuredClone(policy); reversed.rates.reverse();
  const original = structuredClone(reversed);
  assert.deepEqual(canonicalDatedFxPolicy(reversed),policy);
  assert.deepEqual(reversed,original);
});
it("dated_FX_rejects_duplicate_currency_dates_implicit_identity_unknown_rules_and_unbounded_snapshots", () => {
  const changes = [
    (p: any) => p.rates.push({...p.rates[0],rate_unscaled:"13"}),
    (p: any) => p.rates[0].rate_unscaled="0",
    (p: any) => p.rates[0].rate_unscaled="-1",
    (p: any) => p.rates[0].rate_unscaled="1.2",
    (p: any) => p.rates[0].effective_date="2026-02-30",
    (p: any) => p.rates[0].effective_date="2026-8-6",
    (p: any) => p.rates[0].effective_date="0000-01-01",
    (p: any) => delete p.rates[0].effective_date,
    (p: any) => p.rates[0].source="",
    (p: any) => p.rates[0].source="x".repeat(129),
    (p: any) => p.rates[0].as_of="2026-02-30T00:00:00.000Z",
    (p: any) => p.rates[0].as_of="0000-01-01T00:00:00.000Z",
    (p: any) => p.rates[0].rate_scale=19,
    (p: any) => p.rates[0].rate_scale=true,
    (p: any) => p.rates.push(...Array(128).fill(p.rates[0])),
    (p: any) => p.rates.find((r: any)=>r.currency==="USD").rate_unscaled="2",
    (p: any) => p.rate_selection="latest",
    (p: any) => p.policy_version="fx-v0.1",
    (p: any) => p.provider_url="https://synthetic.example",
  ];
  for (const change of changes) {
    const value=structuredClone(policy); change(value);
    assert.equal(validDatedFxPolicy(value),false);
    assert.throws(()=>canonicalDatedFxPolicy(value),/dated_fx_policy_invalid/);
  }
});
it("dated_FX_selection_is_exact_day_and_as_of_at_the_saved_watermark_even_with_microseconds", () => {
  const value=canonicalDatedFxPolicy(policy);
  assert.equal(selectDatedFxRate(value,"EUR","2026-08-07","2026-08-12T23:59:59.999999Z"),undefined);
  assert.equal(selectDatedFxRate(value,"EUR","2026-08-07","2026-08-13T00:00:00.000000Z")?.rate_unscaled,"15");
  assert.equal(selectDatedFxRate(value,"USD","2026-08-07","2026-08-13T00:00:00.000Z"),undefined);
  assert.equal(selectDatedFxRate(value,"JPY","2026-08-08","2026-08-13T00:00:00.000Z"),undefined);
});
it("dated_FX_public_projection_discards_non_contract_artifact_fields", () => {
  const value={policy,snapshot_id:"a".repeat(64),evidence_refs:["private:synthetic"],payload:{installation_id:"synthetic"}};
  assert.deepEqual(projectDatedFxSnapshot(value),{policy,snapshot_id:"a".repeat(64)});
  assert.equal(projectDatedFxSnapshot({...value,policy:{...policy,payload:"unknown"}}),undefined);
  assert.equal(projectDatedFxSnapshot({...value,snapshot_id:"not-a-digest"}),undefined);
});
