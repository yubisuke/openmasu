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
import { compareSnapshots, parseSnapshot } from "../../api/src/cohort-comparison.js";
import { renderComparison } from "../../api/src/dashboard/comparison-report.js";
import { renderAttributionReport } from "../../api/src/dashboard/attribution-report.js";
import { issueDashboardSession } from "../../api/src/session.js";

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

  function differenceArtifact(
    reconciliationId: string,
    differenceReasonCode: string,
    overrides: Any = {},
  ): Any {
    return {
      contract_version: "0.4.0",
      reconciliation_id: reconciliationId,
      tenant_id: "tenant-a",
      app_id: "app-a",
      input_snapshot_id: `internal-snapshot:${reconciliationId}`,
      external_snapshot_id: `external-snapshot:${reconciliationId}`,
      difference_reason_code: differenceReasonCode,
      difference_reason_version: "0.4.0",
      matching_keys: [],
      candidates: [],
      exclusions: [],
      windows: [],
      joins: [],
      freshness: "current",
      ...overrides,
    };
  }

  async function insertDifferences(artifacts: Any[]): Promise<void> {
    await withTenant(appPool, "tenant-a", async (client) => {
      for (const artifact of artifacts) {
        await client.query(
          `INSERT INTO ledger.reconciliation_results (
            reconciliation_id,tenant_id,app_id,input_snapshot_id,external_snapshot_id,
            difference_reason_code,difference_reason_version,freshness,
            supersedes_reconciliation_id,artifact
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
          [
            artifact.reconciliation_id, artifact.tenant_id, artifact.app_id,
            artifact.input_snapshot_id, artifact.external_snapshot_id,
            artifact.difference_reason_code, artifact.difference_reason_version,
            artifact.freshness, artifact.supersedes_reconciliation_id ?? null,
            JSON.stringify(artifact),
          ],
        );
      }
    });
  }

  async function waitForReconciliationLockWaiter(): Promise<void> {
    const lockKey = "openmasu:reconciliation-selection:8:tenant-a:app-a";
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const locks = await seedPool.query<{ waiting: number }>(
        `SELECT count(*) FILTER (WHERE NOT granted)::int AS waiting
           FROM pg_locks
          WHERE locktype='advisory'
            AND classid=((hashtextextended($1,0) >> 32) & 4294967295)::oid
            AND objid=(hashtextextended($1,0) & 4294967295)::oid`,
        [lockKey],
      );
      if ((locks.rows[0]?.waiting ?? 0) === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("the expected reconciliation selection lock waiter did not appear");
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

  it("saves a dashboard comparison through reader scope without GET writes or incomplete downloads", async () => {
    await withTenant(appPool, "tenant-synthetic-other", async client => client.query(
      "INSERT INTO control.apps (tenant_id,app_id,created_at) VALUES ('tenant-synthetic-other','app-synthetic-other','2026-08-01T00:00:00.000Z') ON CONFLICT DO NOTHING"));
    const login = await fetch(`${baseUrl}/dashboard/session`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ admin_key: adminKey }),
    });
    assert.equal(login.status, 303);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    assert.ok(cookie);
    const filters = "metric_name=d1_roas&date_from=2026-08-01&date_to=2026-08-02&grouping_attribution_status=non_organic&watermark_at_most=2026-08-09T00%3A00%3A00Z";
    const endpoint = `${baseUrl}/dashboard/apps/app-a/comparison.json?${filters}`;
    const counts = async () => withTenant(appPool, "tenant-a", async client => (await client.query(`SELECT
      (SELECT count(*) FROM ledger.audit_logs)::text AS audits,
      (SELECT count(*) FROM ledger.raw_records)::text AS raw,
      (SELECT count(*) FROM ledger.event_deliveries)::text AS deliveries,
      (SELECT count(*) FROM ledger.metric_runs)::text AS metrics,
      (SELECT count(*) FROM ephemeral.dashboard_sessions)::text AS sessions`)).rows[0]);
    const beforeCounts = await counts();
    const selected = await fetch(`${baseUrl}/dashboard/apps/app-a?${filters}`, { headers: { cookie } });
    assert.equal(selected.status, 200);
    assert.match(await selected.text(), /Save comparison JSON/);
    const saved = await fetch(endpoint, { headers: { cookie } });
    assert.equal(saved.status, 200);
    assert.equal(saved.headers.get("content-disposition"), 'attachment; filename="openmasu-comparison.json"');
    assert.equal(saved.headers.get("cache-control"), "no-store");
    const body = await saved.text(), snapshot = parseSnapshot(JSON.parse(body));
    assert.equal(snapshot.rows.length, 1);
    const compared = compareSnapshots(snapshot, snapshot);
    assert.equal(compared.status, "compared"); assert.equal(compared.rows[0].status, "equal");
    assert.match(renderComparison(compared), /definition_backed/);
    const equivalentCutoff = await fetch(endpoint.replace("00Z", "00.000000Z"), { headers: { cookie } });
    assert.equal(equivalentCutoff.status, 200); assert.equal(await equivalentCutoff.text(), body);
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { headers: { authorization: `Bearer ${adminKey}` } })).status, 401);
    assert.equal((await fetch(`${baseUrl}/v1/reports/metrics?app_id=app-a`, { headers: { cookie } })).status, 401);
    assert.equal((await fetch(endpoint.replace("/app-a/", "/unknown-app/"), { headers: { cookie } })).status, 404);
    assert.equal((await fetch(endpoint.replace("/app-a/", "/app-synthetic-other/"), { headers: { cookie } })).status, 404);
    for (const bad of ["", `${filters}&limit=1&metric_name=d3_roas`, `${filters}&comparison_aggregation=invalid`,
      filters.replace("non_organic", "organic").replace("d1_roas", "missing_metric"),
      filters.replace("grouping_attribution_status=non_organic&", "") + "&limit=1"]) {
      const failure = await fetch(`${baseUrl}/dashboard/apps/app-a/comparison.json?${bad}`, { headers: { cookie } });
      assert.equal(failure.status, 400, bad);
      assert.equal(failure.headers.get("content-disposition"), null);
    }
    assert.deepEqual(await counts(), beforeCounts, "dashboard GET, including refusal, must not write any ledger or session state");
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

  it("paginates stored differences without silent truncation and rejects partial exports", async () => {
    const artifacts = Array.from({ length: 7 }, (_, index) =>
      differenceArtifact(`reconciliation:pagination:${index}`, "candidate_missing"));
    await insertDifferences(artifacts);

    const headers = { authorization: `Bearer ${adminKey}` };
    const seen: string[] = [];
    const superseded = new Map<string, boolean>();
    let cursor: string | undefined;
    let pageNumber = 0;
    do {
      const query = new URLSearchParams({
        app_id: "app-a",
        difference_reason_code: "candidate_missing",
        supersession: "all",
        limit: "3",
      });
      if (cursor) query.set("after", cursor);
      const response = await fetch(`${baseUrl}/v1/audit/differences?${query}`, { headers });
      const page = await response.json() as { data: Any[]; next_cursor?: string };
      assert.equal(response.status, 200);
      assert.ok(page.data.length >= 1 && page.data.length <= 3);
      seen.push(...page.data.map((row) => row.reconciliation_id));
      for (const row of page.data) superseded.set(row.reconciliation_id, row.superseded);
      cursor = page.next_cursor;
      pageNumber += 1;
      if (pageNumber === 1) {
        assert.ok(cursor);
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Any;
        assert.match(decoded.selectionSequence, /^(0|[1-9]\d*)$/);
        await insertDifferences([
          differenceArtifact("reconciliation:pagination:3a-late", "candidate_missing"),
          differenceArtifact("reconciliation:pagination:replacement-late", "candidate_missing", {
            supersedes_reconciliation_id: artifacts[4].reconciliation_id,
          }),
        ]);
      }
    } while (cursor);
    assert.deepEqual(seen, artifacts.map((artifact) => artifact.reconciliation_id));
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(superseded.get(artifacts[4].reconciliation_id), false);

    const latestArtifacts = Array.from({ length: 4 }, (_, index) =>
      differenceArtifact(`reconciliation:snapshot-latest:${index}`, "scope_mismatch"));
    await insertDifferences(latestArtifacts);
    const latestSeen: string[] = [];
    cursor = undefined;
    pageNumber = 0;
    do {
      const query = new URLSearchParams({
        app_id: "app-a",
        difference_reason_code: "scope_mismatch",
        supersession: "latest",
        limit: "2",
      });
      if (cursor) query.set("after", cursor);
      const response = await fetch(`${baseUrl}/v1/audit/differences?${query}`, { headers });
      const page = await response.json() as { data: Any[]; next_cursor?: string };
      assert.equal(response.status, 200);
      latestSeen.push(...page.data.map((row) => row.reconciliation_id));
      cursor = page.next_cursor;
      pageNumber += 1;
      if (pageNumber === 1) {
        await insertDifferences([
          differenceArtifact("reconciliation:snapshot-latest:2a-late", "scope_mismatch"),
          differenceArtifact("reconciliation:snapshot-latest:replacement-late", "scope_mismatch", {
            supersedes_reconciliation_id: latestArtifacts[2].reconciliation_id,
          }),
        ]);
      }
    } while (cursor);
    assert.deepEqual(latestSeen, latestArtifacts.map((artifact) => artifact.reconciliation_id));

    const csvPage = await fetch(
      `${baseUrl}/v1/audit/differences?app_id=app-a&difference_reason_code=candidate_missing&supersession=all&format=csv&limit=3`,
      { headers },
    );
    assert.equal(csvPage.status, 200);
    assert.ok(csvPage.headers.get("x-next-cursor"));
    assert.equal((await csvPage.text()).trimEnd().split("\n").length, 4);

    const overflow = await fetch(
      `${baseUrl}/v1/audit/differences?app_id=app-a&difference_reason_code=candidate_missing&supersession=all&format=csv&export=true&limit=3`,
      { headers },
    );
    assert.equal(overflow.status, 400);
    assert.deepEqual(await overflow.json(), { error: "export_limit_exceeded" });

  });

  it("holds the first difference page until an in-flight same-scope insert commits", async () => {
    const artifact = differenceArtifact(
      "reconciliation:snapshot-in-flight:0",
      "currency_policy_mismatch",
    );
    const writer = await appPool.connect();
    let transactionOpen = false;
    try {
      await writer.query("BEGIN");
      transactionOpen = true;
      await writer.query("SELECT set_config('openmasu.tenant_id', 'tenant-a', true)");
      await writer.query(
        `INSERT INTO ledger.reconciliation_results (
          reconciliation_id,tenant_id,app_id,input_snapshot_id,external_snapshot_id,
          difference_reason_code,difference_reason_version,freshness,artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          artifact.reconciliation_id, artifact.tenant_id, artifact.app_id,
          artifact.input_snapshot_id, artifact.external_snapshot_id,
          artifact.difference_reason_code, artifact.difference_reason_version,
          artifact.freshness, JSON.stringify(artifact),
        ],
      );

      const responsePromise = fetch(
        `${baseUrl}/v1/audit/differences?app_id=app-a&difference_reason_code=currency_policy_mismatch&supersession=all`,
        { headers: { authorization: `Bearer ${adminKey}` } },
      );
      await waitForReconciliationLockWaiter();

      await writer.query("COMMIT");
      transactionOpen = false;
      const response = await responsePromise;
      assert.equal(response.status, 200);
      const page = await response.json() as { data: Any[] };
      assert.deepEqual(page.data.map((row) => row.reconciliation_id), [artifact.reconciliation_id]);
    } finally {
      if (transactionOpen) await writer.query("ROLLBACK");
      writer.release();
    }
  });

  it("assigns a stored-difference selection sequence only after the first-page lock releases", async () => {
    const artifact = differenceArtifact(
      "reconciliation:snapshot-reader-first:0",
      "redaction_caused_recalculation",
      { freshness: "recalculated" },
    );
    const reader = await readerPool.connect();
    const writer = await appPool.connect();
    let readerTransactionOpen = false;
    let writerTransactionOpen = false;
    let insertion: Promise<unknown> | undefined;
    try {
      await reader.query("BEGIN");
      readerTransactionOpen = true;
      await reader.query("SELECT set_config('openmasu.tenant_id', 'tenant-a', true)");
      await reader.query("SELECT ledger.acquire_reconciliation_selection_lock('tenant-a','app-a')");

      await writer.query("BEGIN");
      writerTransactionOpen = true;
      await writer.query("SELECT set_config('openmasu.tenant_id', 'tenant-a', true)");
      insertion = writer.query(
        `INSERT INTO ledger.reconciliation_results (
          reconciliation_id,tenant_id,app_id,input_snapshot_id,external_snapshot_id,
          difference_reason_code,difference_reason_version,freshness,artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          artifact.reconciliation_id, artifact.tenant_id, artifact.app_id,
          artifact.input_snapshot_id, artifact.external_snapshot_id,
          artifact.difference_reason_code, artifact.difference_reason_version,
          artifact.freshness, JSON.stringify(artifact),
        ],
      );

      await waitForReconciliationLockWaiter();
      const cutoffResult = await reader.query<{ selection_seq: string }>(
        `SELECT COALESCE(MAX(reconciliation_selection_seq),0)::text AS selection_seq
           FROM ledger.reconciliation_results
          WHERE tenant_id='tenant-a' AND app_id='app-a'`,
      );
      const cutoff = BigInt(cutoffResult.rows[0].selection_seq);

      await reader.query("COMMIT");
      readerTransactionOpen = false;
      await insertion;
      await writer.query("COMMIT");
      writerTransactionOpen = false;

      const stored = await withTenant(readerPool, "tenant-a", async (client) => client.query<{ selection_seq: string }>(
        `SELECT reconciliation_selection_seq::text AS selection_seq
           FROM ledger.reconciliation_results
          WHERE reconciliation_id=$1`,
        [artifact.reconciliation_id],
      ));
      assert.ok(BigInt(stored.rows[0].selection_seq) > cutoff);
    } finally {
      if (readerTransactionOpen) await reader.query("ROLLBACK");
      if (writerTransactionOpen) await writer.query("ROLLBACK");
      await insertion?.catch(() => undefined);
      reader.release();
      writer.release();
    }
  });

  it("paginates fixed-watermark aggregate counts and preserves privacy on every page", async () => {
    const input = fixture("42-daily-metric-date");
    input.metric_evaluations = [];
    input.records = Array.from({ length: 7 }, (_, index) => {
      const day = String(index + 1).padStart(2, "0");
      return {
        ...structuredClone(input.records[0]),
        record_id: `click-pagination-${day}`,
        delivery_id: `delivery:click-pagination-${day}`,
        event_id: `event:click-pagination-${day}`,
        occurred_at: `2026-08-${day}T12:00:00.000Z`,
        received_at: `2026-08-${day}T12:00:01.000Z`,
        payload: {
          ...structuredClone(input.records[0].payload),
          click_id: `click-pagination-${day}_0000000000000000`,
          campaign_id: `campaign-pagination-${day}`,
          redirector_click_at: `2026-08-${day}T12:00:00.000Z`,
        },
      };
    });
    await registerAndIngest("m3-record-pagination", input);

    const headers = { authorization: `Bearer ${adminKey}` };
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({
        app_id: "app-a",
        metric_name: "daily_click_count",
        date_from: "2026-08-01",
        date_to: "2026-08-08",
        watermark_at_most: "2026-08-31T00:00:00.000Z",
        limit: "3",
      });
      if (cursor) query.set("after", cursor);
      const response = await fetch(`${baseUrl}/v1/reports/records?${query}`, { headers });
      const text = await response.text();
      assert.equal(response.status, 200);
      for (const forbidden of ["installation_id", "click_id", "record_id", "payload", "payload_ref"]) {
        assert.equal(text.includes(forbidden), false, `${forbidden} leaked from a paginated record page`);
      }
      const page = JSON.parse(text) as { data: Any[]; next_cursor?: string };
      assert.ok(page.data.length >= 1 && page.data.length <= 3);
      seen.push(...page.data.map((row) => `${row.metric_name}:${row.grouping.metric_date}`));
      cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual(seen, Array.from({ length: 7 }, (_, index) =>
      `daily_click_count:2026-08-${String(index + 1).padStart(2, "0")}`));
    assert.equal(new Set(seen).size, seen.length);

    const csvPage = await fetch(
      `${baseUrl}/v1/reports/records?app_id=app-a&metric_name=daily_click_count&date_from=2026-08-01&date_to=2026-08-08&watermark_at_most=2026-08-31T00%3A00%3A00.000Z&format=csv&limit=3`,
      { headers },
    );
    assert.equal(csvPage.status, 200);
    assert.ok(csvPage.headers.get("x-next-cursor"));
    assert.equal((await csvPage.text()).trimEnd().split("\n").length, 4);

    const overflow = await fetch(
      `${baseUrl}/v1/reports/records?app_id=app-a&metric_name=daily_click_count&date_from=2026-08-01&date_to=2026-08-08&watermark_at_most=2026-08-31T00%3A00%3A00.000Z&format=csv&export=true&limit=3`,
      { headers },
    );
    assert.equal(overflow.status, 400);
    assert.deepEqual(await overflow.json(), { error: "export_limit_exceeded" });

    const login = await fetch(`${baseUrl}/dashboard/session`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ admin_key: adminKey }),
    });
    assert.equal(login.status, 303);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";", 1)[0];
    const recordsPage = await fetch(
      `${baseUrl}/dashboard/apps/app-a/records?metric_name=daily_click_count&date_from=2026-08-01&date_to=2026-08-08&watermark_at_most=2026-08-31T00%3A00%3A00.000Z&limit=1`,
      { headers: { cookie } },
    );
    const recordsHtml = await recordsPage.text();
    assert.equal(recordsPage.status, 200);
    assert.match(recordsHtml, /Next aggregate-record page/);
    assert.equal(recordsHtml.includes("<script"), false);
  });

  it("aligns saved retention cohorts through the reader dashboard with unchanged filters values scope and page boundaries", async () => {
    const input = fixture("33-stage-b-cohort-metrics");
    const base = input.metric_evaluations[0];
    input.metric_evaluations = ["2026-08-01", "2026-08-02"].map(date => ({ ...structuredClone(base),
      metric_names: ["retention_d1", "retention_d7"], metric_run_id_prefix: `retention-matrix-${date}`,
      grouping: { ...base.grouping, cohort_date: date } }));
    await registerAndIngest("synthetic-retention-matrix", input);
    await computeSqlMetricRuns(appPool, input, true);
    const readKey = "synthetic-retention-matrix-reader-key-000000000000001";
    await ensureAdminKeys(appPool, { tenantId: "tenant-a", appId: "app-a" }, [{ key: readKey, role: "read_only" }]);
    const login = await fetch(`${baseUrl}/dashboard/session`, { method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ admin_key: readKey }) });
    assert.equal(login.status, 303);
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const filters = "metric_name=retention_d1&metric_name=retention_d7&grouping_country=JP&grouping_attribution_status=non_organic&watermark_at_most=2026-08-09T00%3A00%3A00.000Z";
    const apiResponse = await fetch(`${baseUrl}/v1/reports/metrics?app_id=app-a&${filters}`, { headers: { authorization: `Bearer ${readKey}` } });
    assert.equal(apiResponse.status, 200);
    const api = await apiResponse.json() as { data: Any[] };
    assert.equal(api.data.length, 4);
    const read = async (query = filters) => {
      const response = await fetch(`${baseUrl}/dashboard/apps/app-a?${query}`, { headers: { cookie } });
      assert.equal(response.status, 200); return response.text();
    };
    const html = await read();
    assert.equal((html.match(/data-retention-matrix=/g) ?? []).length, 1);
    for (const row of api.data) {
      const day = row.comparison_context.definition.definition.window.day;
      assert.ok(html.includes(`data-retention-cohort="${row.grouping.cohort_date}" data-retention-day="${day}"`));
      assert.ok(html.includes(`data-retention-run-id="${row.metric_run_id}"`));
      if (row.grouping.cohort_date === "2026-08-01") {
        assert.equal(row.value_unscaled, "1000000");
        assert.ok(html.includes(`data-retention-run-id="${row.metric_run_id}" data-retention-value-unscaled="1000000" data-ratio-scale="6">1 ×`));
      } else { assert.equal(row.value_state, "undefined"); assert.equal(row.undefined_reason, "empty_cohort"); }
      const detail = `/dashboard/apps/app-a/metrics/${encodeURIComponent(row.metric_run_id)}/explanation`;
      assert.ok(html.includes(detail)); assert.equal((await fetch(`${baseUrl}${detail}`, { headers: { cookie } })).status, 200);
    }
    assert.match(html, /— \(empty_cohort\)/); assert.match(html, /Conservative window end not reached/);
    const first = await read(`${filters}&limit=3`);
    assert.match(first, /Not fetched on this page/);
    const href = /href="([^"]+)"[^>]*>Next metric page/.exec(first)![1].replaceAll("&amp;", "&");
    const nextParams = new URL(href, baseUrl).searchParams;
    assert.equal(nextParams.get("grouping_country"), "JP"); assert.equal(nextParams.get("grouping_attribution_status"), "non_organic");
    const last = await read(nextParams.toString());
    assert.match(last, /Partial selection: preceding or following pages are not loaded/);
    assert.doesNotMatch(last, />Next metric page</);
    assert.doesNotMatch(await read(filters.replace("grouping_country=JP", "grouping_country=GB")), /data-retention-matrix=/);
    assert.equal((await fetch(`${baseUrl}/dashboard/apps/app-a?${filters}`, { redirect: "manual" })).status, 401);
    assert.equal((await fetch(`${baseUrl}/dashboard/apps/unknown-matrix-app?${filters}`, { headers: { cookie } })).status, 404);
    const afterApi = await fetch(`${baseUrl}/v1/reports/metrics?app_id=app-a&${filters}`, { headers: { authorization: `Bearer ${readKey}` } });
    assert.deepEqual(await afterApi.json(), api);
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

  it("counts stored acquisition reasons once as of the cutoff with reader API/SSR and current privacy", async () => {
    const tenant = "tenant-attribution-report", app = "app-attribution-report";
    const key = "synthetic-attribution-reader-key-0000000000000000000001";
    const [keyId] = await ensureAdminKeys(appPool, { tenantId: tenant, appId: app }, [{ key, role: "read_only" }]);
    const session = await issueDashboardSession(appPool, tenant, keyId, 3600);
    const rowId = (name: string) => `synthetic-attribution-${name}`;
    const installation = (name: string) => `installation:${rowId(name)}`;
    const record = async (name: string, occurred = "2026-08-01T12:00:00.000Z", received = "2026-08-01T12:00:01.000Z", kind = "install", accepted = true,
      scope = { tenant, app }) => withTenant(appPool, scope.tenant, async client => {
      const id = rowId(name);
      await client.query(`INSERT INTO control.apps(tenant_id,app_id,created_at) VALUES ($1::text,$2::text,$3::text) ON CONFLICT DO NOTHING`, [scope.tenant, scope.app, received]);
      await client.query(`INSERT INTO ledger.raw_records
        (record_id,tenant_id,app_id,producer,producer_version,event_id,delivery_id,event_name,schema_version,payload_sha256,
         occurred_at,occurred_at_source,received_at,raw_payload_ref,consent_evaluation_policy_version,consent_decision_reason_code,artifact)
        VALUES ($1::text,$2::text,$3::text,'sdk-android','synthetic','event:'||$1::text,'delivery:'||$1::text,$4::text,'0.4.0',$5::text,
          $6::text,'device',$7::text,'synthetic-private-payload','synthetic','consent_not_required','{}')`,
      [id, scope.tenant, scope.app, kind, "a".repeat(64), occurred, received]);
      await client.query(`INSERT INTO ledger.raw_payload_states(tenant_id,app_id,record_id,lifecycle_status,changed_at) VALUES ($1,$2,$3,'available',$4)`,
        [scope.tenant, scope.app, id, received]);
      // A retained delivery without an accepted logical/fact row must never enter the denominator.
      for (let attempt = 0; attempt < (name === "a" ? 2 : 1); attempt++) await client.query(`INSERT INTO ledger.event_deliveries
        (delivery_attempt_id,delivery_id,record_id,tenant_id,app_id,received_at,ingestion_status,duplicate_resolution,timeliness,clock_skew_suspected,
         payload_disposition,consent_evaluation_policy_version,consent_decision_reason_code,artifact)
        VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,'none','on_time',false,'retained','synthetic','consent_not_required','{}')`,
      [`delivery:${id}`, id, scope.tenant, scope.app, received, attempt ? "duplicate_delivery" : accepted ? "accepted" : "rejected"]);
      if (!accepted) return;
      await client.query(`INSERT INTO ledger.logical_events(logical_event_id,record_id,tenant_id,app_id,producer,event_id,event_name,timeliness,artifact)
        VALUES ($1::text,$1::text,$2::text,$3::text,'sdk-android','event:'||$1::text,$4::text,'on_time','{}')`, [id, scope.tenant, scope.app, kind]);
      if (kind === "install") await client.query(`INSERT INTO ledger.install_facts(logical_event_id,tenant_id,app_id,installation_id,install_type,occurred_at,artifact)
        VALUES ($1,$2,$3,$4,'first_install',$5,'{}')`, [id, scope.tenant, scope.app, installation(name), occurred]);
    });
    const decision = async (name: string, subject: string, status: string, method: string, reason: string, patch: Any = {}) => {
      const artifact = { attribution_id: rowId(name), tenant_id: tenant, app_id: app, subject_scope: "installation_level", subject_ref: installation(subject),
        effective_at: "2026-08-01T12:00:00.000Z", decided_at: "2026-08-02T00:00:00.000Z", input_cutoff_at: "2026-08-02T00:00:00.000Z",
        status, method, reason_code: reason, model: "none", evidence_refs: [], ...patch };
      await withTenant(appPool, tenant, client => client.query(`INSERT INTO ledger.attribution_results
        (attribution_id,tenant_id,app_id,subject_scope,subject_ref,effective_at,decided_at,status,method,model,reason_code,artifact)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [artifact.attribution_id, tenant, app, artifact.subject_scope, artifact.subject_ref, artifact.effective_at, artifact.decided_at,
        artifact.status, artifact.method, artifact.model, artifact.reason_code, JSON.stringify(artifact)]));
    };
    for (const name of ["a", "b", "c", "d", "e", "future-decision", "late-evidence"]) await record(name);
    await record("upper", "2026-08-02T00:00:00.000Z", "2026-08-02T00:00:01.000Z");
    await record("tokyo-lower", "2026-07-31T15:00:00.000Z");
    await record("before-tokyo", "2026-07-31T14:59:59.999Z");
    await record("late-receive", undefined, "2026-08-04T00:00:00.000Z");
    await record("evidence-click", undefined, "2026-08-04T00:00:00.000Z", "click");
    await record("rejected", undefined, undefined, "install", false);
    await record("other-app", undefined, undefined, "install", true, { tenant, app: "other-attribution-app" });
    await record("other-tenant", undefined, undefined, "install", true, { tenant: "other-attribution-tenant", app: "foreign-attribution-app" });
    await decision("a-old", "a", "organic", "none", "no_referrer");
    await decision("a-new", "a", "non_organic", "install_referrer", "valid_install_referrer", {
      decided_at: "2026-08-02T00:00:00.001Z", input_cutoff_at: "2026-08-02T00:00:00.001Z", supersedes_attribution_id: rowId("a-old") });
    await decision("b-base", "b", "unattributed", "none", "unknown_click_id");
    await decision("b-cutoff-future", "b", "unattributed", "none", "window_expired", { input_cutoff_at: "2026-08-04T00:00:00.000Z", supersedes_attribution_id: rowId("b-base") });
    await decision("d-organic", "d", "organic", "none", "no_referrer");
    await decision("e-window", "e", "unattributed", "none", "window_expired");
    await decision("future", "future-decision", "organic", "none", "no_referrer", { decided_at: "2026-08-04T00:00:00.000Z" });
    await decision("late", "late-evidence", "non_organic", "install_referrer", "valid_install_referrer", {
      evidence_refs: [{ tenant_id: tenant, app_id: app, ref: rowId("evidence-click") }] });
    for (const scope of ["aggregate", "engagement_level"]) await decision(`excluded-${scope}`, "a", "unattributed", "none", "synthetic-private-reason", {
      subject_scope: scope, decided_at: "2026-08-02T01:00:00.000Z" });
    const apiServer = createServer(createRequestHandler({ pool: appPool, readerPool, payloadStore: {} as PayloadStore,
      maxConfig: { tenantId: tenant, appId: app, pathSecret: "synthetic", eventKey: "synthetic", tokenMode: "all", maxParameters: 40, maxQueryBytes: 8192 },
      publicBaseUrl: "http://localhost:8080", redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: true, publicBaseUrl: "http://localhost:8080", tenantId: tenant, sessionTtlSeconds: 3600 } }));
    await new Promise<void>(resolve => apiServer.listen(0, "127.0.0.1", resolve));
    const address = apiServer.address(); assert.ok(address && typeof address === "object");
    const root = `http://127.0.0.1:${address.port}`, path = `/v1/admin/apps/${app}/attribution`, headers = { authorization: `Bearer ${key}` };
    const query = { date_from: "2026-08-01", date_to: "2026-08-02", time_zone: "UTC", watermark_at_most: "2026-08-03T00:00:00.000Z" };
    const read = async (patch: Record<string, string> = {}) => {
      const response = await fetch(`${root}${path}?${new URLSearchParams({ ...query, ...patch })}`, { headers });
      const text = await response.text(); assert.equal(response.status, 200, text);
      assert.doesNotMatch(text, /installation_id|subject_ref|record_id|evidence_refs|artifact|synthetic-private|synthetic-attribution-/);
      return JSON.parse(text);
    };
    const bucket = (result: Any, reason: string | null) => result.data.filter((row: Any) => row.reason_code === reason).reduce((sum: number, row: Any) => sum + Number(row.count), 0);
    try {
      assert.equal((await fetch(`${root}${path}`)).status, 401);
      assert.equal((await fetch(`${root}/dashboard/apps/${app}/attribution`, { headers })).status, 401);
      assert.equal((await fetch(`${root}/v1/admin/apps/foreign-attribution-app/attribution?${new URLSearchParams(query)}`, { headers })).status, 404);
      const normal = await read(); assert.equal(normal.denominator, "7");
      assert.deepEqual(normal.data.map((row: Any) => [row.recording_state, row.status, row.method, row.reason_code, row.count]), [
        ["not_recorded", null, null, null, "3"], ["recorded", "non_organic", "install_referrer", "valid_install_referrer", "1"],
        ["recorded", "organic", "none", "no_referrer", "1"], ["recorded", "unattributed", "none", "unknown_click_id", "1"],
        ["recorded", "unattributed", "none", "window_expired", "1"]]);
      assert.equal(normal.data.reduce((sum: number, row: Any) => sum + Number(row.count), 0), Number(normal.denominator));
      const before = await read({ watermark_at_most: "2026-08-02T00:00:00Z" }); assert.equal(bucket(before, "no_referrer"), 2);
      assert.deepEqual(await read({ watermark_at_most: "2026-08-02T00:00:00.000000Z" }), { ...before, selection: { ...before.selection, watermark_at_most: "2026-08-02T00:00:00.000000Z" } });
      assert.equal(bucket(await read({ watermark_at_most: "2026-08-02T00:00:00.000999Z" }), "valid_install_referrer"), 0);
      assert.equal(bucket(await read({ watermark_at_most: "2026-08-02T00:00:00.001000Z" }), "valid_install_referrer"), 1);
      const later = await read({ watermark_at_most: "2026-08-05T00:00:00Z" }); assert.equal(later.denominator, "8");
      assert.equal(bucket(later, "valid_install_referrer"), 2); assert.equal(bucket(later, "window_expired"), 2); assert.equal(bucket(later, null), 2);
      assert.equal((await read({ time_zone: "Asia/Tokyo" })).denominator, "8");
      assert.equal((await read({ date_from: "2026-09-01", date_to: "2026-09-02" })).denominator, "0");
      const cookie = `openmasu_dashboard=${session.token}`;
      const page = await fetch(`${root}/dashboard/apps/${app}/attribution?${new URLSearchParams(query)}`, { headers: { cookie } });
      assert.equal(page.status, 200); assert.equal(page.headers.get("cache-control"), "no-store");
      assert.equal(await page.text(), renderAttributionReport(app, normal));
      for (const extra of ["&installation_id=private", "&date_from=2026-08-01"]) assert.equal((await fetch(`${root}${path}?${new URLSearchParams(query)}${extra}`, { headers })).status, 400);
      await withTenant(appPool, tenant, async client => {
        for (const [name, state] of [["d", "redacted"], ["e", "purged"]]) await client.query(`INSERT INTO ledger.raw_payload_states
          (tenant_id,app_id,record_id,lifecycle_status,changed_at) VALUES ($1,$2,$3,$4,'2026-08-06T00:00:00.000Z')`, [tenant, app, rowId(name), state]);
      });
      const privacy = await read(); assert.equal(privacy.denominator, "5");
      assert.equal(bucket(privacy, "no_referrer"), 0); assert.equal(bucket(privacy, "window_expired"), 0); assert.equal(bucket(privacy, null), 3);
    } finally { await new Promise<void>((resolve, reject) => apiServer.close(error => error ? reject(error) : resolve())); }
  });
});
