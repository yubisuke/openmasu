import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import type { PoolClient } from "pg";
import { evaluate, jcs, sha256 } from "@openmasu/attribution-core";
import { costArtifact, persistCostImportWithClient, type CostInput } from "./cost.js";

it("runtime_cost_artifacts_match_contract_dimensions_and_keep_date_scope_revision_keys_and_IDs_stable", async () => {
  const input = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json", "utf8"));
  input.metric_evaluations = [];
  const base: CostInput = { tenant_id: "tenant-synthetic-cost", app_id: "app-synthetic-cost", network: "synthetic-network",
    campaign_id: "synthetic-campaign", country: "JP", date: "2026-08-01", currency: "USD", amount_scale: 6,
    amount_unscaled: "100000000", as_of: "2026-08-08T00:00:00.000Z", source: "imported_reported" };
  const variants: CostInput[] = [base, { ...base, date: "2026-08-02" }, { ...base, tenant_id: "tenant-other" },
    { ...base, app_id: "app-other" }, { ...base, campaign_id: undefined, country: undefined },
    { ...base, campaign_id: null, country: null }, { ...base, ad_group_id: "synthetic-group" },
    { ...base, ad_group_id: "synthetic-group", creative_id: "synthetic-creative", coverage_scope: "matching_detail_only" },
    { ...base, reporting_time_zone: "Asia/Tokyo" }];
  const keys: string[] = [];
  for (const row of variants) {
    const artifact = costArtifact(row, sha256([row]));
    const contract = evaluate({ ...input, cost_records: [artifact] }).cost_records;
    assert.equal(jcs(contract[0]), jcs(artifact), "the actual runtime wire object is accepted without normalization");
    const client = { query: async (text: string, values: unknown[]) => {
      if (text.includes("INSERT INTO ledger.cost_records")) {
        keys.push(String(values[14]));
        assert.equal(jcs(JSON.parse(String(values[16]))), jcs(artifact));
      }
      return { rowCount: 1, rows: [{ count: 1 }] };
    } } as unknown as PoolClient;
    await persistCostImportWithClient(client, "synthetic-cost-source", [row]);
  }
  const first = costArtifact(base, sha256([base]));
  for (const index of [1, 2, 3]) {
    assert.equal(costArtifact(variants[index], sha256([variants[index]])).dimension_digest, first.dimension_digest);
    assert.notEqual(keys[index], keys[0], "dates and scopes remain separate internal keys");
  }
  const previousKey = { tenant_id: base.tenant_id, app_id: base.app_id, network: base.network,
    campaign_id: base.campaign_id, ad_group_id: null, country: base.country, date: base.date };
  assert.equal(keys[0], sha256(previousKey), "existing internal key remains unchanged");
  assert.equal(first.cost_record_id, `cost:${sha256([previousKey,base.as_of,base.amount_unscaled,base.currency]).slice(0,48)}`);
});
