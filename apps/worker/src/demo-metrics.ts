import { createAppPool, withTenant } from "@openmasu/runtime";
import { evaluate } from "@openmasu/attribution-core";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDemoMetricsOutput } from "./demo-metrics-output.js";

const tenantId = process.env.OPENMASU_MAX_TENANT_ID ?? "tenant-local";
const appId = process.env.OPENMASU_MAX_APP_ID ?? "app-local";
const pool = createAppPool();
try {
  const summary = await withTenant(pool, tenantId, async (client) => {
    const result = await client.query(`SELECT
      (SELECT count(*) FROM ledger.raw_records WHERE app_id=$1)::int AS raw_records,
      (SELECT count(*) FROM ledger.logical_events WHERE app_id=$1)::int AS logical_events,
      (SELECT count(*) FROM ledger.attribution_results WHERE app_id=$1)::int AS attributions,
      (SELECT count(*) FROM ledger.metric_runs WHERE app_id=$1)::int AS metric_runs,
      (SELECT count(*) FROM ledger.cost_records_current WHERE app_id=$1)::int AS current_cost_rows`, [appId]);
    return result.rows[0];
  });
  const syntheticInput = JSON.parse(readFileSync(
    join(process.cwd(), "fixtures", "v0.4", "33-stage-b-cohort-metrics", "input.json"),
    "utf8",
  ));
  const syntheticPreview = evaluate(syntheticInput).metric_runs
    .filter((run) => ["d7_roas", "retention_d1"].includes(run.metric_name))
    .map((run) => ({
      metric_name: run.metric_name,
      value_unscaled: run.value_unscaled,
      ratio_scale: run.ratio_scale,
      metric_definition_version: run.metric_definition_version,
      input_snapshot_id: run.input_snapshot_id,
      data_freshness: run.data_freshness,
    }));
  console.log(JSON.stringify(buildDemoMetricsOutput({
    tenantId,
    appId,
    ledgerCounts: summary,
    syntheticMetricRuns: syntheticPreview,
  }), null, 2));
} finally {
  await pool.end();
}
