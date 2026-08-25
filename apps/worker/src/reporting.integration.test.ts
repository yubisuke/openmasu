import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ensureAdminKeys } from "../../api/src/admin-auth.js";
import { metricColumns } from "../../api/src/reporting.js";
import { createRequestHandler } from "../../api/src/router.js";
import type { MaxReceiverConfig } from "../../api/src/max-receiver.js";
import type { PayloadStore } from "@openmasu/runtime";
import { createAppPool, createReaderPool, createSeedPool, withTenant } from "@openmasu/runtime";
import type { Pool } from "pg";
import { ingestFixture } from "./ingestion.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { sha256 } from "@openmasu/attribution-core";

type Any = Record<string, any>;
const adminKey = "synthetic-report-admin-key-000000000000000000000001";

function fixture(name: string): Any {
  return JSON.parse(readFileSync(join(process.cwd(), "fixtures", "v0.4", name, "input.json"), "utf8"));
}

function csvRow(text: string): Record<string, string> {
  const lines = text.trimEnd().split("\n");
  const parse = (line: string): string[] => {
    const values: string[] = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      if (character === '"') {
        if (quoted && line[index + 1] === '"') {
          value += '"';
          index += 1;
        } else quoted = !quoted;
      } else if (character === "," && !quoted) {
        values.push(value);
        value = "";
      } else value += character;
    }
    values.push(value);
    return values;
  };
  return Object.fromEntries(parse(lines[0]).map((header, index) => [header, parse(lines[1])[index]]));
}

describe("M1b reporting and difference audit", { concurrency: false }, () => {
  let appPool: Pool;
  let readerPool: Pool;
  let seedPool: Pool;
  let server: Server;
  let baseUrl: string;

  async function registerAndIngest(name: string, input: Any): Promise<void> {
    await seedPool.query(
      `INSERT INTO testing.fixture_inputs (fixture_name, input_digest, input)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (fixture_name) DO UPDATE
       SET input_digest=EXCLUDED.input_digest, input=EXCLUDED.input, loaded_at=clock_timestamp()`,
      [name, sha256(input), JSON.stringify(input)],
    );
    await ingestFixture(name, input, appPool, seedPool);
  }

  before(async () => {
    appPool = createAppPool();
    readerPool = createReaderPool();
    seedPool = createSeedPool();
    const input = fixture("33-stage-b-cohort-metrics");
    await registerAndIngest("33-stage-b-cohort-metrics", input);
    await computeSqlMetricRuns(appPool, input, true);
    await ensureAdminKeys(appPool, { tenantId: "tenant-a", appId: "app-a" }, [adminKey]);
    const config: MaxReceiverConfig = {
      tenantId: "tenant-a", appId: "app-a", pathSecret: "synthetic-report-path",
      eventKey: "synthetic-report-event-key", tokenMode: "all", maxParameters: 40, maxQueryBytes: 8192,
    };
    const unusedPayloadStore: PayloadStore = {
      write: async () => { throw new Error("reporting must not write payloads"); },
      read: async () => { throw new Error("reporting must not read payloads"); },
      purge: async () => { throw new Error("reporting must not purge payloads"); },
      scanFor: async () => false,
    };
    server = createServer(createRequestHandler({
      pool: appPool, readerPool, payloadStore: unusedPayloadStore, maxConfig: config,
      publicBaseUrl: "http://localhost:8080", redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: true, publicBaseUrl: "http://localhost:8080", tenantId: config.tenantId, sessionTtlSeconds: 43200 },
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    await appPool?.end();
    await readerPool?.end();
    await seedPool?.end();
  });

  it("B7 protects reporting with the admin key and preserves JSON/CSV values and metadata", async () => {
    const unauthorized = await fetch(`${baseUrl}/v1/reports/metrics?app_id=app-a&format=json`);
    assert.equal(unauthorized.status, 401);
    const headers = { authorization: `Bearer ${adminKey}` };
    const jsonResponse = await fetch(`${baseUrl}/v1/reports/metrics?app_id=app-a&format=json`, { headers });
    const csvResponse = await fetch(`${baseUrl}/v1/reports/metrics?app_id=app-a&format=csv`, { headers });
    assert.equal(jsonResponse.status, 200);
    assert.equal(csvResponse.status, 200);
    const json = await jsonResponse.json() as { data: Any[] };
    const selected = json.data.find((row) => row.metric_name === "d7_roas");
    assert.ok(selected);
    const selectedCsv = (await csvResponse.text()).trimEnd().split("\n");
    const header = selectedCsv[0];
    const metricIndex = header.split(",").indexOf("metric_name");
    const d7Line = selectedCsv.slice(1).find((line) => line.split(",")[metricIndex] === "d7_roas");
    assert.ok(d7Line);
    const csvSelected = csvRow(`${header}\n${d7Line}\n`);
    assert.equal(csvSelected.value_unscaled, selected.value_unscaled);
    assert.equal(csvSelected.metric_definition_version, selected.metric_definition_version);
    assert.equal(csvSelected.input_received_at_watermark, selected.input_received_at_watermark);
    assert.equal(csvSelected.input_snapshot_id, selected.input_snapshot_id);
    assert.equal(csvSelected.data_freshness, selected.data_freshness);
    assert.deepEqual(JSON.parse(csvSelected.policy_versions), selected.policy_versions);
    for (const column of metricColumns) {
      const expected: unknown = selected[column];
      const expectedText: string = expected === null || expected === undefined
        ? ""
        : typeof expected === "object" ? JSON.stringify(expected) : String(expected);
      assert.equal(csvSelected[column], expectedText, `CSV mismatch for ${column}`);
    }
  });

  it("B8 exports undefined ROAS as absent value plus reason", async () => {
    const input = fixture("37-undefined-organic-roas");
    await registerAndIngest("37-undefined-organic-roas", input);
    await computeSqlMetricRuns(appPool, input, true);
    const response = await fetch(`${baseUrl}/v1/reports/metrics?app_id=app-a&format=json`, {
      headers: { authorization: `Bearer ${adminKey}` },
    });
    const body = await response.json() as { data: Any[] };
    assert.equal(response.status, 200);
    assert.equal(body.data[0].value_state, "undefined");
    assert.equal(body.data[0].undefined_reason, "no_attributed_cost");
    assert.equal("value_unscaled" in body.data[0], false);
  });

  for (const [name, reason] of [
    ["21-reconciliation-window-mismatch", "window_mismatch"],
    ["23-reconciliation-freshness-mismatch", "freshness_mismatch"],
    ["38-provider-modeled-reconciliation", "provider_modeled_conversion"],
  ] as const) {
    it(`B5/B10 returns complete automatically-derived ${reason} evidence`, async () => {
      const input = fixture(name);
      await registerAndIngest(name, input);
      const response = await fetch(`${baseUrl}/v1/audit/differences?app_id=app-a&format=json`, {
        headers: { authorization: `Bearer ${adminKey}` },
      });
      const body = await response.json() as { data: Any[] };
      assert.equal(response.status, 200);
      assert.equal(body.data.length, 1);
      const row = body.data[0];
      assert.equal(row.difference_reason_code, reason);
      for (const field of [
        "input_snapshot_id", "external_snapshot_id", "matching_keys", "candidates",
        "exclusions", "windows", "joins", "freshness",
      ]) assert.ok(field in row, `${reason} must include ${field}`);
    });
  }

  it("C10 defaults to the replacement while preserving immutable supersession history", async () => {
    const mutation = fixture("33-stage-b-cohort-metrics");
    const baseEvaluation = {
      ...mutation.metric_evaluations[0],
      metric_run_id_prefix: "run-m3-before",
      metric_names: ["d7_roas"],
      privacy_state: "before",
    };
    mutation.metric_evaluations = [
      baseEvaluation,
      {
        ...baseEvaluation,
        metric_run_id_prefix: "run-m3-after",
        computed_at: "2026-08-09T00:03:00.000Z",
        data_freshness: "recalculated",
        privacy_state: "after",
        supersedes_metric_run_id_prefix: "run-m3-before",
      },
    ];
    mutation.privacy_requests = [{
      contract_version: "0.4.0",
      tenant_id: "tenant-a",
      app_id: "app-a",
      privacy_request_id: "privacy:m3-supersession",
      deletion_subject_digest: "5".repeat(64),
      deletion_scope: "installation",
      requested_via: "tenant_admin_api",
      requester_auth_ref: "admin_key:synthetic-m3",
      requested_at: "2026-08-09T00:01:00.000Z",
      completed_at: "2026-08-09T00:02:00.000Z",
      status: "completed",
      reason_code: "privacy_deletion",
      policy_version: "privacy-v0.3",
      affected_records: [{ record_id: "revenue-33-c", lifecycle_status: "redacted" }],
    }];
    await registerAndIngest("m3-supersession", mutation);
    await computeSqlMetricRuns(appPool, mutation, true);
    const beforeDigest = await withTenant(appPool, "tenant-a", async (client) => sha256((await client.query<{ artifact: Any }>(
      "SELECT artifact FROM ledger.metric_runs WHERE metric_run_id='run-m3-before:d7_roas'",
    )).rows[0].artifact));
    const headers = { authorization: `Bearer ${adminKey}` };
    const latest = await (await fetch(`${baseUrl}/v1/reports/metrics?app_id=app-a`, { headers })).json() as { data: Any[] };
    const all = await (await fetch(`${baseUrl}/v1/reports/metrics?app_id=app-a&supersession=all`, { headers })).json() as { data: Any[] };
    assert.equal(latest.data.length, 1);
    assert.equal(latest.data[0].metric_run_id, "run-m3-after:d7_roas");
    assert.equal(latest.data[0].supersedes_metric_run_id, "run-m3-before:d7_roas");
    assert.equal(latest.data[0].reproducibility_status, "redaction_affected");
    assert.equal(all.data.length, 2);
    assert.equal(all.data.find((row) => row.metric_run_id === "run-m3-before:d7_roas")?.superseded, true);
    const afterDigest = await withTenant(appPool, "tenant-a", async (client) => sha256((await client.query<{ artifact: Any }>(
      "SELECT artifact FROM ledger.metric_runs WHERE metric_run_id='run-m3-before:d7_roas'",
    )).rows[0].artifact));
    assert.equal(afterDigest, beforeDigest);
  });

  it("C11 walks keyset pages once even when a new row is inserted between pages", async () => {
    const input = fixture("33-stage-b-cohort-metrics");
    await registerAndIngest("m3-pagination", input);
    await computeSqlMetricRuns(appPool, input, true);
    const headers = { authorization: `Bearer ${adminKey}` };
    const original = await (await fetch(`${baseUrl}/v1/reports/metrics?app_id=app-a&limit=1000`, { headers })).json() as { data: Any[] };
    const seen: string[] = [];
    let cursor: string | undefined;
    let pageNumber = 0;
    do {
      const query = new URLSearchParams({ app_id: "app-a", limit: "3" });
      if (cursor) query.set("after", cursor);
      const page = await (await fetch(`${baseUrl}/v1/reports/metrics?${query}`, { headers })).json() as {
        data: Any[];
        next_cursor?: string;
      };
      seen.push(...page.data.map((row) => row.metric_run_id));
      cursor = page.next_cursor;
      pageNumber += 1;
      if (pageNumber === 2) {
        const insertion = structuredClone(input);
        insertion.metric_evaluations = [{
          ...insertion.metric_evaluations[0],
          metric_run_id_prefix: "run-m3-pagination-insert",
          metric_names: ["cohort_install_count"],
          grouping: { ...insertion.metric_evaluations[0].grouping, country: "ZZ" },
        }];
        await computeSqlMetricRuns(appPool, insertion, true);
      }
    } while (cursor);
    assert.equal(new Set(seen).size, seen.length);
    for (const row of original.data) {
      assert.equal(seen.filter((id) => id === row.metric_run_id).length, 1, `${row.metric_run_id} was skipped or duplicated`);
    }
    assert.ok(pageNumber >= 3);
  });

  it("C14 returns fixed-watermark aggregate counts without record identifiers or payloads", async () => {
    const input = fixture("42-daily-metric-date");
    await registerAndIngest("42-daily-metric-date", input);
    await computeSqlMetricRuns(appPool, input, true);
    const query = new URLSearchParams({
      app_id: "app-a",
      watermark_at_most: "2026-08-21T00:00:00.000Z",
    });
    query.append("metric_name", "daily_click_count");
    query.append("metric_name", "daily_install_count");
    const response = await fetch(`${baseUrl}/v1/reports/records?${query}`, {
      headers: { authorization: `Bearer ${adminKey}` },
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    for (const forbidden of ["installation_id", "click_id", "record_id", "payload", "payload_ref"]) {
      assert.equal(text.includes(forbidden), false, `${forbidden} leaked from aggregate records`);
    }
    const body = JSON.parse(text) as { data: Any[] };
    assert.deepEqual(body.data.map((row) => [row.metric_name, row.count]), [
      ["daily_click_count", "1"],
      ["daily_install_count", "1"],
    ]);
    const identifying = await fetch(`${baseUrl}/v1/reports/records?app_id=app-a&grouping_installation_id=synthetic`, {
      headers: { authorization: `Bearer ${adminKey}` },
    });
    assert.equal(identifying.status, 400);
  });

  it("C16 serves byte-identical aggregate CSV through bearer and dashboard-session paths", async () => {
    const input = fixture("42-daily-metric-date");
    await registerAndIngest("42-daily-metric-date-export", input);
    await computeSqlMetricRuns(appPool, input, true);
    const login = await fetch(`${baseUrl}/dashboard/session`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ admin_key: adminKey }),
    });
    assert.equal(login.status, 303);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    assert.ok(cookie);
    const filters = "watermark_at_most=2026-08-21T00%3A00%3A00.000Z&metric_name=daily_click_count&metric_name=daily_install_count&export=true";
    const api = await fetch(`${baseUrl}/v1/reports/metrics?app_id=app-a&format=csv&${filters}`, {
      headers: { authorization: `Bearer ${adminKey}` },
    });
    const dashboard = await fetch(`${baseUrl}/dashboard/apps/app-a/cohorts.csv?${filters}`, {
      headers: { cookie },
    });
    assert.equal(api.status, 200);
    assert.equal(dashboard.status, 200);
    assert.equal(await dashboard.text(), await api.text());
    const page = await fetch(`${baseUrl}/dashboard/apps/app-a?watermark_at_most=2026-08-21T00%3A00%3A00.000Z`, {
      headers: { cookie },
    });
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /data-metric-run-id="run-42-click:daily_click_count"/);
    assert.equal(html.includes("<script"), false);
  });
});
