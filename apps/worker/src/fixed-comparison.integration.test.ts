import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { before, after, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { createAppPool, createSeedPool, withTenant } from "@openmasu/runtime";
import { sha256, jcs } from "@openmasu/attribution-core";
import { ingestFixture } from "./test-support/fixture-ingestion.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { persistCostImport } from "./import/cost.js";
import { fixedComparisonDownload, comparisonLimits } from "../../api/src/fixed-comparison.js";
import { metricReport } from "../../api/src/reporting.js";
import { parseSnapshot, compareSnapshots } from "../../api/src/cohort-comparison.js";
import type { MetricQuery } from "../../api/src/report-query.js";
import { createRequestHandler } from "../../api/src/router.js";
import { ensureAdminKeys } from "../../api/src/admin-auth.js";
import { issueDashboardSession } from "../../api/src/session.js";
import { aggregateCsvToSnapshot } from "../../api/src/aggregate-csv-snapshot.js";
import { renderComparison } from "../../api/src/dashboard/comparison-report.js";

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

  it("connects reader dashboard download, CSV review, explicit comparison and identical JSON/HTML without writes", async () => {
    const key = "synthetic-comparison-reader-key-000000000000000000000";
    const [keyId] = await ensureAdminKeys(appPool, identity, [{ key, role: "read_only" }]);
    const session = await issueDashboardSession(appPool, identity.tenantId, keyId, 3600);
    const origin = "http://localhost:8080", cookie = `openmasu_dashboard=${session.token}`, logs: string[] = [];
    // Any accidental writer or payload-store use makes this route fail.
    const forbidden = new Proxy({} as Pool, { get() { throw Error("comparison_must_not_write"); } });
    const server = createServer(createRequestHandler({ pool: forbidden, readerPool, payloadStore: {} as any,
      publicBaseUrl: origin, redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: true, publicBaseUrl: origin, tenantId: identity.tenantId, sessionTtlSeconds: 3600 },
      maxConfig: { ...identity, pathSecret: "synthetic-unused", eventKey: "synthetic-unused", tokenMode: "all", maxParameters: 40, maxQueryBytes: 8192 },
      operationalLogWriter: line => { logs.push(line); } }));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/dashboard/apps/${identity.appId}/comparison`;
    const decode = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");
    const hidden = (html: string) => [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)]
      .map(match => [match[1], decode(match[2])] as const);
    const post = (form: FormData, extra: Record<string, string> = {}) => fetch(url, { method: "POST", headers: { cookie, origin, ...extra }, body: form });
    try {
      assert.equal((await fetch(url)).status, 401);
      assert.equal((await fetch(url, { headers: { authorization: `Bearer ${key}` } })).status, 401);
      const formResponse = await fetch(url, { headers: { cookie } }); assert.equal(formResponse.status, 200);
      assert.equal(formResponse.headers.get("cache-control"), "no-store");
      const token = hidden(await formResponse.text()).find(([name]) => name === "csrf_token")![1];
      const params = new URLSearchParams({ metric_name: "d1_roas", grouping_attribution_status: "non_organic",
        date_from: query.dateFrom!, date_to: query.dateTo!, watermark_at_most: query.watermarkAtMost!, limit: "1" });
      const savedResponse = await fetch(`${url}.json?${params}`, { headers: { cookie } }); assert.equal(savedResponse.status, 200);
      const saved = parseSnapshot(await savedResponse.json());
      const csv = "day,country,roas,unused\n2026-08-01,JP,0.75,private-unused-column\n2026-08-01,GB,,private-unused-column\n2026-08-01,US,0,private-unused-column\n2026-08-01,AU,0,private-unused-column\n";
      const mapping: Record<string, any> = { version: 1, source: "synthetic-external", conditions: { ...saved.conditions, metric_definition: "external-d1" },
        grouping: { cohort_date: { column: "day" }, country: { column: "country" }, campaign_id: { constant: "provider-campaign-33" },
          network: { constant: "synthetic-network" }, attribution_status: { constant: "non_organic" } },
        value: { column: "roas", input: "decimal", scale: 6, currency: { constant: "none" }, undefined: { marker: "", reason: { constant: "no_attributed_cost" } } },
        external_calculation: { version: 1, profile: "external-elapsed-ad-roas-v1", anchor_event: "install", calculation: "revenue_over_cost",
          numerator: "revenue", denominator: "cost", aggregation: "cumulative", time_zone: "UTC", window: { type: "elapsed", day: 1, boundary: "half_open" },
          population: "accepted_installation_cohort", acquisition_basis: "recorded_dimensions", cost_basis: "cohort_acquisition_day_current_snapshot",
          cost_selection_policy: "legacy_dimension_digest_latest", grouping_dimensions: ["campaign_id", "network", "country", "cohort_date", "attribution_status"],
          fraud_policy: "gross", privacy_state: "before", value_type: "ratio", ratio_scale: 6,
          fx: { target_currency: "USD", target_scale: 6, conversion: "per_event_round_then_sum", rounding_mode: "half_even",
            rates: [{ currency: "EUR", rate_unscaled: "5", rate_scale: 1, as_of: "2026-08-01T00:00:00.000Z" }] }, final_rounding: "half_even" } };
      const upload = (candidate = saved, map = mapping) => {
        const form = new FormData(); form.set("action", "review"); form.set("csrf_token", token);
        form.set("saved_json", new File([jcs(candidate)], "private-filename.json"));
        form.set("external_csv", new File([csv], "private-filename.csv")); form.set("mapping_json", new File([jcs(map)], "mapping.json")); return form;
      };
      const reviewed = await post(upload()); assert.equal(reviewed.status, 200);
      const reviewHtml = await reviewed.text(); assert.match(reviewHtml, /No numerical comparison has been performed/);
      assert.doesNotMatch(reviewHtml, /private-unused-column|private-filename| checked|<script/);
      const submit = (html: string, action: string, optIn: boolean) => {
        const form = new FormData(); for (const [name, value] of hidden(html)) form.set(name, value);
        form.set("action", action); if (optIn) form.set("external_opt_in", "yes"); else form.delete("external_opt_in"); return form;
      };
      const noConsent = await post(submit(reviewHtml, "json", false)); assert.equal((await noConsent.json() as any).status, "incomparable");
      const expected = compareSnapshots(saved, aggregateCsvToSnapshot(Buffer.from(csv), mapping), { allowExternalDeclaration: true });
      assert.equal(expected.status, "external_declared_comparison", expected.mismatches.join(","));
      assert.ok(expected.rows.some(row => row.delta_right_minus_left === "250000"));
      assert.ok(expected.rows.some(row => row.status === "missing_left")); assert.ok(expected.rows.some(row => row.status === "undefined"));
      const resultResponse = await post(submit(reviewHtml, "result", true)); assert.equal(resultResponse.status, 200);
      const resultHtml = await resultResponse.text(); assert.match(resultHtml, /EXTERNAL DECLARED COMPARISON/);
      const json = await post(submit(resultHtml, "json", true)); assert.equal(json.status, 200);
      assert.equal(await json.text(), `${jcs(expected)}\n`);
      assert.match(json.headers.get("content-disposition")!, /attachment; filename="openmasu-comparison.json"/);
      const html = await post(submit(resultHtml, "html", true)); assert.equal(html.status, 200);
      assert.equal(await html.text(), renderComparison(expected));
      const mismatched = structuredClone(mapping); mismatched.external_calculation.final_rounding = "half_up";
      const mismatchReview = await post(upload(saved, mismatched));
      const mismatchResult = await post(submit(await mismatchReview.text(), "json", true));
      const mismatch = await mismatchResult.json() as any; assert.equal(mismatch.status, "incomparable"); assert.deepEqual(mismatch.rows, []);
      const unknown = structuredClone(mapping); delete unknown.external_calculation;
      const unknownReview = await post(upload(saved, unknown));
      const unknownResult = await post(submit(await unknownReview.text(), "json", true)); assert.equal((await unknownResult.json() as any).status, "incomparable");
      const wrong = upload(); wrong.set("csrf_token", "wrong"); assert.equal((await post(wrong)).status, 403);
      assert.equal((await post(upload(), { origin: "https://foreign.synthetic.example" })).status, 403);
      const foreign = structuredClone(saved); foreign.acquisition!.scope.app_id = "other-app";
      foreign.acquisition!.query_sha256 = sha256({ scope: foreign.acquisition!.scope, filters: foreign.acquisition!.filters, conditions: foreign.conditions });
      assert.equal((await post(upload(foreign))).status, 403);
      const badJson = upload(); badJson.set("saved_json", new File(["private-invalid-json"], "private-filename"));
      const invalid = await post(badJson); assert.equal(invalid.status, 400); assert.doesNotMatch(await invalid.text(), /private-invalid-json/);
      assert.doesNotMatch(logs.join("\n"), /private-filename|private-unused-column|private-invalid-json|provider-campaign-33|csrf_token/);
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
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
    const observed = afterFirstPage(async () => {
      // A new run on an unchanged input is a duplicate, not a supersession.
      // Commit a synthetic cost correction within the fixed receive cutoff.
      const group = oldEvaluation.grouping;
      await persistCostImport(appPool, "synthetic-fixed-correction", [{
        tenant_id: identity.tenantId, app_id: identity.appId,
        campaign_id: group.campaign_id, network: group.network, country: group.country,
        date: group.cohort_date, amount_unscaled: "110000000", amount_scale: 6,
        currency: "USD", source: "imported_reported", as_of: "2026-08-08T01:00:00.000Z",
      }]);
      await computeSqlMetricRuns(appPool, mutation, true);
    });
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
