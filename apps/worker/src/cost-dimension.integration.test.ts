import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, it } from "node:test";
import { evaluate, jcs, sha256 } from "@openmasu/attribution-core";
import { createAppPool, createSeedPool, uuidV7, withTenant } from "@openmasu/runtime";
import { persistCostImport, type CostInput } from "./import/cost.js";
import { ingestFixture, persistFixtureCosts } from "./test-support/fixture-ingestion.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { currentCosts, disjointCosts } from "./metrics/snapshot.js";

const pool = createAppPool(), seed = createSeedPool();
after(async () => { await Promise.all([pool.end(),seed.end()]); });

it("imported_cost_wire_and_SQL_share_contract_JCS_across_dates_revisions_and_scopes_without_rewriting_history", async () => {
  const tenantId = `tenant-cost-digest-${uuidV7().slice(-12)}`, appId = "app-a";
  const input = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json", "utf8").replaceAll("tenant-a",tenantId));
  input.cost_records = [];
  input.metric_evaluations = [{ ...input.metric_evaluations[0], metric_run_id_prefix: "cost-digest-run", metric_names: ["d7_roas"] }];
  await ingestFixture(`cost-digest-${tenantId}`, { ...input, metric_evaluations: [] }, pool, seed);
  const base: CostInput = { tenant_id: tenantId,app_id: appId,network: "synthetic-network",campaign_id: "provider-campaign-33",country: "JP",
    date: "2026-08-01",amount_unscaled: "200000000",amount_scale: 6,currency: "USD",source: "imported_reported",as_of: "2026-08-07T00:00:00.000Z" };
  await persistCostImport(pool,"synthetic-base",[base]);
  const revision = { ...base,amount_unscaled: "100000000",as_of: "2026-08-08T00:00:00.000Z" };
  const nextDay = { ...revision,date: "2026-08-02",amount_unscaled: "1000000" };
  await persistCostImport(pool,"synthetic-revision",[revision,nextDay]);
  // Reimport is a no-op for cost artifacts, even though import-run audit remains.
  assert.equal((await persistCostImport(pool,"synthetic-revision-repeat",[revision,nextDay])).inserted,0);
  await persistCostImport(pool,"synthetic-other-app",[{ ...revision,app_id: "app-other",amount_unscaled: "7000000" }]);
  await persistCostImport(pool,"synthetic-other-tenant",[{ ...revision,tenant_id: tenantId + "-other",amount_unscaled: "11000000" }]);
  const artifacts = await withTenant(pool,tenantId,async client => (await client.query(
    "SELECT artifact FROM ledger.cost_records WHERE tenant_id=$1 AND app_id=$2 ORDER BY as_of,cost_record_id",[tenantId,appId])).rows.map(row=>row.artifact));
  assert.equal(artifacts.length,3);
  input.cost_records = artifacts;
  const expected = evaluate(input).metric_runs;
  const actual = await computeSqlMetricRuns(pool,input);
  assert.equal(actual[0].value_unscaled,"1500000");
  assert.equal(jcs(actual),jcs(expected),"actual imported artifacts reach both engines without an adapter or expected-value rewrite");
  await withTenant(pool,tenantId,async client => {
    const legacy = await currentCosts(client,{tenant_id:tenantId,app_id:appId},"2026-08-09T00:00:00.000Z",undefined);
    const disjoint = await disjointCosts(client,{tenant_id:tenantId,app_id:appId},"2026-08-09T00:00:00.000Z",undefined);
    assert.equal(legacy.length,2); assert.equal(disjoint.rows.length,2);
    assert.equal(new Set(legacy.map(row=>row.dimension_digest)).size,1,"public grain is equal across dates while internal keys retain both");
    const current = await client.query("SELECT cost_date::text,spend_unscaled FROM ledger.cost_records_current WHERE tenant_id=$1 AND app_id=$2 ORDER BY cost_date",[tenantId,appId]);
    assert.deepEqual(current.rows,[{cost_date:"2026-08-01",spend_unscaled:"100000000"},{cost_date:"2026-08-02",spend_unscaled:"1000000"}]);
  });
  const before = jcs(artifacts),runBefore = jcs(actual);
  const saved = await withTenant(pool,tenantId,async client => (await client.query("SELECT artifact FROM ledger.metric_runs WHERE tenant_id=$1",[tenantId])).rows.map(row=>row.artifact));
  assert.equal(jcs(saved),runBefore);
  const repeat = await computeSqlMetricRuns(pool,input,false); assert.equal(jcs(repeat),runBefore);
  const afterArtifacts = await withTenant(pool,tenantId,async client => (await client.query(
    "SELECT artifact FROM ledger.cost_records WHERE tenant_id=$1 AND app_id=$2 ORDER BY as_of,cost_record_id",[tenantId,appId])).rows.map(row=>row.artifact));
  assert.equal(jcs(afterArtifacts),before);
  assert.equal(actual[0].input_snapshot_id,expected[0].input_snapshot_id);
  // Reconstruct a pre-fix persisted artifact, not a new valid wire artifact.
  // It keeps its recorded digest and SQL replay identity; no UPDATE repairs it.
  const oldKey = sha256({tenant_id:tenantId,app_id:appId,network:base.network,campaign_id:base.campaign_id,
    ad_group_id:null,country:base.country,date:base.date});
  const legacy = { ...artifacts[0],cost_record_id:"cost-synthetic-legacy",as_of:"2026-08-08T12:00:00.000Z",
    dimension_digest:oldKey,amount_unscaled:"300000000" };
  await persistFixtureCosts(pool,{cost_records:[legacy]});
  const legacyInput = { ...input,metric_evaluations:[{...input.metric_evaluations[0],metric_run_id_prefix:"legacy-cost-digest-run"}] };
  const legacyRuns = await computeSqlMetricRuns(pool,legacyInput);
  await persistCostImport(pool,"synthetic-future-revision",[{...revision,as_of:"2026-08-10T00:00:00.000Z",amount_unscaled:"50000000"}]);
  assert.equal(jcs(await computeSqlMetricRuns(pool,legacyInput,false)),jcs(legacyRuns),"later valid rows do not rewrite a saved old-cutoff replay");
  const retained = await withTenant(pool,tenantId,c=>c.query("SELECT artifact FROM ledger.cost_records WHERE cost_record_id=$1",[legacy.cost_record_id]));
  assert.equal(jcs(retained.rows[0].artifact),jcs(legacy));
});
