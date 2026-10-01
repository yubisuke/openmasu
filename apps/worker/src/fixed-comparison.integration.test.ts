import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, after, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { createAppPool, createSeedPool, withTenant } from "@openmasu/runtime";
import { sha256 } from "@openmasu/attribution-core";
import { ingestFixture } from "./ingestion.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { fixedComparisonDownload, comparisonLimits } from "../../api/src/fixed-comparison.js";
import { metricReport } from "../../api/src/reporting.js";
import { parseSnapshot, compareSnapshots } from "../../api/src/cohort-comparison.js";
import type { MetricQuery } from "../../api/src/report-query.js";

describe("fixed comparison acquisition", { concurrency: false }, () => {
  const identity = { tenantId: "tenant-a", appId: "app-a", keyId: "key:synthetic-fixed", role: "read_only" as const };
  const query: MetricQuery = { ...identity, metricNames: ["d1_roas"], grouping: { attribution_status: "non_organic" },
    dateFrom: "2026-08-01", dateTo: "2026-08-02", watermarkAtMost: "2026-08-09T00:00:00.000Z", supersession: "latest", limit: 1 };
  let appPool: Pool, seedPool: Pool, readerPool: Pool, input: Record<string, any>;
  before(async () => {
    appPool = createAppPool(); seedPool = createSeedPool();
    readerPool = new Pool({ connectionString: process.env.OPENMASU_READER_DATABASE_URL, max: 1 });
    input = JSON.parse(readFileSync("fixtures/v0.4/33-stage-b-cohort-metrics/input.json", "utf8"));
    input.metric_definitions = input.metric_definitions.filter((d: any) => d.metric_name === "d1_roas");
    const base = input.metric_evaluations[0];
    input.metric_evaluations = ["JP", "GB", "US"].map(country => ({ ...structuredClone(base),
      metric_names: ["d1_roas"], metric_run_id_prefix: `synthetic-fixed-${country}`, grouping: { ...base.grouping, country } }));
    await seedPool.query(`INSERT INTO testing.fixture_inputs (fixture_name,input_digest,input) VALUES ($1,$2,$3::jsonb)
      ON CONFLICT (fixture_name) DO UPDATE SET input_digest=EXCLUDED.input_digest,input=EXCLUDED.input`,
      ["synthetic-fixed-comparison", sha256(input), JSON.stringify(input)]);
    await ingestFixture("synthetic-fixed-comparison", input, appPool, seedPool);
    await computeSqlMetricRuns(appPool, input, true);
  });
  after(async () => { await readerPool?.end(); await appPool?.end(); await seedPool?.end(); });

  function afterFirstPage(action: (client: PoolClient) => Promise<void>): Pool {
    return { connect: async () => {
      const client = await readerPool.connect(), execute = client.query.bind(client);
      let first = true;
      return new Proxy(client, { get(target, key) {
        if (key === "query") return async (...args: any[]) => {
          const result = await (execute as any)(...args);
          if (typeof args[0] === "string" && args[0].startsWith("SELECT mr.artifact") && first) {
            first = false; await action(client);
          }
          return result;
        };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    } } as unknown as Pool;
  }

  it("reads every selected row once on a one-connection reader pool with a repeatable receipt digest", async () => {
    const body = await fixedComparisonDownload(readerPool, identity, query);
    assert.equal(body, await fixedComparisonDownload(readerPool, identity, { ...query, limit: 2 }));
    const snapshot = parseSnapshot(JSON.parse(body));
    assert.equal(snapshot.rows.length, 3); assert.equal(snapshot.acquisition?.row_count, 3);
    assert.equal(new Set(snapshot.provenance!.runs.map(r => r.metric_run_id)).size, 3);
    assert.equal(compareSnapshots(snapshot, snapshot).status, "compared");
    assert.equal(snapshot.rows.filter(r => r.state === "undefined").length, 2, "empty cohorts must not become zero");
  });

  it("does not mix new or superseding runs inserted between keyset pages", async () => {
    const initial = await fixedComparisonDownload(readerPool, identity, query);
    const page = await metricReport(readerPool, identity, { ...query, limit: 200 });
    const oldId = page.data.at(-1)!.metric_run_id;
    const oldEvaluation = input.metric_evaluations.find((e: any) => `${e.metric_run_id_prefix}:d1_roas` === oldId);
    assert.ok(oldEvaluation);
    const mutation = structuredClone(input);
    mutation.metric_evaluations = [
      { ...structuredClone(oldEvaluation), metric_run_id_prefix: "synthetic-fixed-replacement",
        supersedes_metric_run_id_prefix: oldEvaluation.metric_run_id_prefix, computed_at: "2026-08-09T00:02:00.000Z" },
      { ...structuredClone(oldEvaluation), metric_run_id_prefix: "synthetic-fixed-new",
        grouping: { ...oldEvaluation.grouping, country: "AU" } },
    ];
    const observed = afterFirstPage(async () => { await computeSqlMetricRuns(appPool, mutation, true); });
    assert.equal(await fixedComparisonDownload(observed, identity, query), initial);
    const latest = await metricReport(readerPool, identity, { ...query, limit: 200 });
    assert.equal(latest.data.length, 4);
    assert.ok(latest.data.some(r => r.metric_run_id === "synthetic-fixed-replacement:d1_roas"));
    assert.ok(!latest.data.some(r => r.metric_run_id === oldId));
  });

  it("refuses empty, cross-scope, row/byte-limited and interrupted acquisitions and releases its reader/fence", async () => {
    await assert.rejects(fixedComparisonDownload(readerPool, identity, { ...query, metricNames: ["missing_metric"] }), /comparison_requires_one_nonempty_definition/);
    await assert.rejects(fixedComparisonDownload(readerPool, identity, { ...query, appId: "other-app" }), /comparison_scope_mismatch/);
    for (const bounds of [{ ...comparisonLimits, rows: 2 }, { ...comparisonLimits, bytes: 10 }]) {
      await assert.rejects(fixedComparisonDownload(readerPool, identity, query, { bounds }), /comparison_incomplete_or_limit_exceeded/);
    }
    const abort = new AbortController();
    await assert.rejects(fixedComparisonDownload(afterFirstPage(async () => abort.abort()), identity, query, { signal: abort.signal }), /comparison_acquisition_incomplete/);
    await assert.rejects(fixedComparisonDownload(afterFirstPage(async client => {
      await client.query("SELECT pg_sleep(0.1)");
    }), identity, query, { bounds: { ...comparisonLimits, milliseconds: 50 } }), /comparison_acquisition_incomplete/);
    assert.equal(parseSnapshot(JSON.parse(await fixedComparisonDownload(readerPool, identity, query))).rows.length, 4);
  });

  it("refuses source evidence removed after calculation without reconstructing it", async () => {
    await withTenant(appPool, identity.tenantId, client => client.query(`INSERT INTO ledger.raw_payload_states
      (tenant_id,app_id,record_id,lifecycle_status,changed_at) VALUES ($1,$2,'revenue-33-c','purged','2026-08-10T00:00:00.000Z')`,
      [identity.tenantId, identity.appId]));
    await assert.rejects(fixedComparisonDownload(readerPool, identity, query), /comparison_evidence_unavailable/);
    assert.equal((await metricReport(readerPool, identity, { ...query, limit: 200 })).data.length, 4,
      "ordinary reporting retains historical aggregates; comparison must not claim readable replay evidence");
  });
});
