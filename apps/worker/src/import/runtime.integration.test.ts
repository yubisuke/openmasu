import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { Pool } from "pg";
import {
  createAppPool,
  createMigrationPool,
  EncryptedFilePayloadStore,
  PostgresSchedulerStore,
  runScheduledJob,
  withTenant,
} from "@openmasu/runtime";
import { sha256 } from "@openmasu/attribution-core";
import { runMmpImport, runMmpImportCommand } from "./runner.js";
import { persistCostImport } from "./cost.js";
import { runCostImportCommand, runCostImportFile } from "./cost-cli.js";
import { runGoogleCostImport, runGoogleCostImportCommand } from "./google-cost-cli.js";
import { runMetaCostImport, runMetaCostImportCommand } from "./meta-cost-cli.js";
import { runMaxRevenueImport, runMaxRevenueImportCommand } from "./max-revenue-cli.js";
import { runMetricDefinitionsCommand, runMetricDefinitionsFile } from "../metrics/run.js";
import { expectedMaxTokenAll, receiveMax, type MaxReceiverConfig } from "../../../api/src/max-receiver.js";
import { processMaxInbox } from "./max-worker.js";
import { ensureAdminKeys } from "../../../api/src/admin-auth.js";
import { createRequestHandler } from "../../../api/src/router.js";
import { privacySubjectDigest } from "../../../api/src/privacy.js";
import { TokenBucket } from "../../../api/src/rate-limit.js";

const appPool = createAppPool();
const ownerPool = createMigrationPool();
const temporary = mkdtempSync(join(tmpdir(), "openmasu-runtime-test-"));
const payloadStore = new EncryptedFilePayloadStore(
  join(temporary, "payloads"),
  "synthetic-payload-master-key-000000000000000000000000000001",
);
const mappingPath = "examples/mappings/synthetic-provider-click.json";
const source = readFileSync("examples/synthetic/mmp-raw-events.json", "utf8");

async function reset(): Promise<void> {
  await ownerPool.query("TRUNCATE ledger.audit_logs, control.apps CASCADE");
}

before(reset);
after(async () => {
  await appPool.end();
  await ownerPool.end();
  rmSync(temporary, { recursive: true, force: true });
});

describe("M1a import integration", () => {
  it("A4 content-addresses exact retries and appends duplicate deliveries for equivalent files", async () => {
    const firstFile = join(temporary, "first.json");
    const equivalentFile = join(temporary, "equivalent.json");
    writeFileSync(firstFile, source);
    writeFileSync(equivalentFile, `${source.trim()}\n\n`);
    const succeededBefore = await withTenant(appPool, "tenant-local", async (client) =>
      (await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ledger.audit_logs
          WHERE actor_type='system_job' AND actor_ref='job:mmp_import'
            AND action='job_completed' AND policy_version='job-health-v1'
            AND outcome='succeeded'`,
      )).rows[0].count);
    const first = await runMmpImportCommand({ pool: appPool, mappingPath, filePath: firstFile, now: new Date("2026-08-19T10:00:00.000Z") });
    const skipped = await runMmpImportCommand({ pool: appPool, mappingPath, filePath: firstFile, now: new Date("2026-08-19T10:01:00.000Z") });
    const second = await runMmpImport({ pool: appPool, mappingPath, filePath: equivalentFile, now: new Date("2026-08-19T10:02:00.000Z") });
    assert.equal(first.status, "completed");
    assert.equal(skipped.status, "skipped");
    assert.equal(second.status, "completed");
    await withTenant(appPool, "tenant-local", async (client) => {
      const succeededAfter = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ledger.audit_logs
          WHERE actor_type='system_job' AND actor_ref='job:mmp_import'
            AND action='job_completed' AND policy_version='job-health-v1'
            AND outcome='succeeded'`,
      );
      assert.equal(succeededAfter.rows[0].count - succeededBefore, 2);
      const logical = await client.query("SELECT count(*)::int AS count FROM ledger.logical_events");
      const deliveries = await client.query("SELECT duplicate_resolution, count(*)::int AS count FROM ledger.event_deliveries GROUP BY 1 ORDER BY 1");
      assert.equal(logical.rows[0].count, 1);
      assert.deepEqual(deliveries.rows, [
        { duplicate_resolution: "duplicate_delivery", count: 1 },
        { duplicate_resolution: "unique", count: 1 },
      ]);
    });
  });

  it("A5 keeps identical cost snapshots idempotent and appends one restatement", async () => {
    const base = {
      tenant_id: "tenant-local", app_id: "app-local", network: "synthetic-network",
      campaign_id: "campaign-cost-1", ad_group_id: null, country: "US", date: "2026-08-18",
      amount_unscaled: "1000000", amount_scale: 6, currency: "USD",
      source: "imported_reported" as const, as_of: "2026-08-19T11:00:00.000Z",
    };
    const first = await persistCostImport(appPool, "synthetic-cost", [base]);
    const repeated = await persistCostImport(appPool, "synthetic-cost", [base]);
    const restated = await persistCostImport(appPool, "synthetic-cost", [{ ...base, amount_unscaled: "1250000", as_of: "2026-08-19T12:00:00.000Z" }]);
    assert.equal(first.inserted, 1);
    assert.equal(repeated.inserted, 0);
    assert.equal(restated.inserted, 1);
    await withTenant(appPool, "tenant-local", async (client) => {
      const all = await client.query("SELECT count(*)::int AS count FROM ledger.cost_records");
      const current = await client.query("SELECT spend_unscaled FROM ledger.cost_records_current WHERE campaign_id='campaign-cost-1'");
      assert.equal(all.rows[0].count, 2);
      assert.equal(current.rows[0].spend_unscaled, "1250000");
    });
  });

  it("Issue 41 imports, repeats, and restates a synthetic Meta cost snapshot through the executable runner", async () => {
    const secrets = {
      read: (name: string) => name === "OPENMASU_META_ACCESS_TOKEN" ? "synthetic-meta-token" : undefined,
      require(name: string) {
        const value = this.read(name);
        if (!value) throw new Error(`${name} is required`);
        return value;
      },
    };
    let spend = "2.500000";
    const fetchMeta = async (): Promise<Response> => new Response(JSON.stringify({ data: [{
      account_currency: "USD", campaign_id: "4100000000000001", adset_id: "4100000000000002",
      country: "US", spend, date_start: "2026-08-18", date_stop: "2026-08-18",
    }] }));
    const base = {
      pool: appPool, fetch: fetchMeta, secrets,
      tenantId: "tenant-local", appId: "app-local", accountId: "4100000000000000",
      currency: "USD", since: "2026-08-18", until: "2026-08-18",
      asOf: "2026-08-19T11:30:00.000Z",
    };
    const first = await runMetaCostImportCommand(base);
    const repeated = await runMetaCostImport(base);
    spend = "3.750000";
    const restated = await runMetaCostImport({ ...base, asOf: "2026-08-19T12:30:00.000Z" });
    assert.deepEqual(
      [first.rows, first.inserted, repeated.rows, repeated.inserted, restated.rows, restated.inserted],
      [1, 1, 1, 0, 1, 1],
    );
    await withTenant(appPool, "tenant-local", async (client) => {
      const result = await client.query(`SELECT
        (SELECT count(*) FROM ledger.cost_records WHERE campaign_id='4100000000000001')::int AS snapshots,
        (SELECT spend_unscaled FROM ledger.cost_records_current WHERE campaign_id='4100000000000001') AS current_spend,
        (SELECT count(*) FROM control.import_runs WHERE source_id LIKE 'meta-insights:%' AND status='completed')::int AS completed_runs`);
      assert.deepEqual(result.rows[0], { snapshots: 2, current_spend: "3750000", completed_runs: 3 });
    });
  });

  it("Issue 43 imports, repeats, and restates synthetic Google Ads cost without persisting the customer ID", async () => {
    const secrets = {
      read: (name: string) => name === "OPENMASU_GOOGLE_ADS_ACCESS_TOKEN"
        ? "synthetic-google-access-token"
        : name === "OPENMASU_GOOGLE_ADS_DEVELOPER_TOKEN"
          ? "synthetic-google-developer-token"
          : undefined,
      require(name: string) {
        const value = this.read(name);
        if (!value) throw new Error(`${name} is required`);
        return value;
      },
    };
    let costMicros = "2500000";
    const fetchGoogle = async (_input: string | URL, init?: RequestInit): Promise<Response> => {
      const query = (JSON.parse(String(init?.body)) as { query: string }).query;
      if (query.includes("FROM geo_target_constant")) {
        return new Response(JSON.stringify([{
          results: [{ geoTargetConstant: { id: "2840", countryCode: "US" } }],
        }]));
      }
      if (!query.includes("ad_group.id")) return new Response("[]");
      return new Response(JSON.stringify([{ results: [{
        customer: { currencyCode: "USD" },
        campaign: { id: "4300000000000001", advertisingChannelType: "SEARCH" },
        adGroup: { id: "4300000000000002" },
        geographicView: { countryCriterionId: "2840", locationType: "LOCATION_OF_PRESENCE" },
        segments: { date: "2026-08-18" },
        metrics: { costMicros },
      }] }]));
    };
    const customerId = "4300000000";
    const base = {
      pool: appPool, fetch: fetchGoogle, secrets,
      tenantId: "tenant-local", appId: "app-local", customerId,
      currency: "USD", since: "2026-08-18", until: "2026-08-18",
      asOf: "2026-08-19T11:45:00.000Z",
    };
    const first = await runGoogleCostImportCommand(base);
    const repeated = await runGoogleCostImport(base);
    costMicros = "3750000";
    const restated = await runGoogleCostImport({ ...base, asOf: "2026-08-19T12:45:00.000Z" });
    assert.deepEqual(
      [first.rows, first.inserted, repeated.rows, repeated.inserted, restated.rows, restated.inserted],
      [1, 1, 1, 0, 1, 1],
    );
    const expectedSourceId = `google-ads:${sha256(["customer", customerId]).slice(0, 24)}`;
    await withTenant(appPool, "tenant-local", async (client) => {
      const result = await client.query(`SELECT
        (SELECT count(*) FROM ledger.cost_records WHERE campaign_id='4300000000000001')::int AS snapshots,
        (SELECT spend_unscaled FROM ledger.cost_records_current WHERE campaign_id='4300000000000001') AS current_spend,
        (SELECT count(*) FROM control.import_runs WHERE source_id=$1 AND status='completed')::int AS completed_runs,
        (SELECT count(*) FROM control.import_runs WHERE source_id LIKE $2)::int AS raw_customer_sources`,
      [expectedSourceId, `%${customerId}%`]);
      assert.deepEqual(result.rows[0], {
        snapshots: 2,
        current_spend: "3750000",
        completed_runs: 3,
        raw_customer_sources: 0,
      });
    });
  });

  it("A10 rejects an oversized import before any database insert", async () => {
    const file = join(temporary, "too-many.json");
    writeFileSync(file, source);
    const beforeCount = await ownerPool.query("SELECT count(*)::int AS count FROM control.import_runs");
    await assert.rejects(
      runMmpImport({ pool: appPool, mappingPath, filePath: file, limits: { maxBytes: 1_000_000, maxRows: 0, maxRowBytes: 65_536 } }),
      /exceeds 0 rows/,
    );
    const afterCount = await ownerPool.query("SELECT count(*)::int AS count FROM control.import_runs");
    assert.equal(afterCount.rows[0].count, beforeCount.rows[0].count);
  });

  it("WO16 accepts mixed empty optional columns through one CSV mapping", async () => {
    const file = join(temporary, "synthetic-optional-columns.csv");
    writeFileSync(file, [
      "event_id,occurred_at,click_id,network",
      "synthetic-optional-event-a,2026-08-21T00:00:00,synthetic-optional-click-a,synthetic-network",
      "synthetic-optional-event-b,2026-08-21T00:01:00,synthetic-optional-click-b,",
      "",
    ].join("\n"));
    const imported = await runMmpImport({
      pool: appPool,
      mappingPath: "examples/mappings/synthetic-optional-columns-click.json",
      filePath: file,
      now: new Date("2026-08-21T01:00:00.000Z"),
    });
    assert.deepEqual(
      { status: imported.status, rows: imported.rows, accepted: imported.accepted, rejected: imported.rejected },
      { status: "completed", rows: 2, accepted: 2, rejected: 0 },
    );
    await withTenant(appPool, "tenant-local", async (client) => {
      const rows = await client.query<{ event_id: string; network: string | null }>(`
        SELECT raw.event_id, click.network
          FROM ledger.raw_records AS raw
          JOIN ledger.logical_events AS logical ON logical.record_id=raw.record_id
          JOIN ledger.click_facts AS click ON click.logical_event_id=logical.logical_event_id
         WHERE raw.event_id LIKE 'synthetic-optional-event-%'
         ORDER BY raw.event_id`);
      assert.deepEqual(rows.rows, [
        { event_id: "synthetic-optional-event-a", network: "synthetic-network" },
        { event_id: "synthetic-optional-event-b", network: null },
      ]);
    });
  });

  it("WO16 keeps row-level schema rejection inside a mixed bulk import", async () => {
    const mapping = JSON.parse(readFileSync(mappingPath, "utf8"));
    mapping.source_id = "synthetic-bulk-rejection-clicks";
    const mixedMappingPath = join(temporary, "synthetic-bulk-rejection-mapping.json");
    writeFileSync(mixedMappingPath, JSON.stringify(mapping));
    const valid = { ...JSON.parse(source)[0], event_id: "synthetic-bulk-valid", click_id: "synthetic-bulk-click-valid" };
    const invalid = { ...valid, event_id: "synthetic-bulk-invalid", click_id: "synthetic-bulk-click-invalid", country: "usa" };
    const file = join(temporary, "synthetic-bulk-rejection.json");
    const text = JSON.stringify([valid, invalid]);
    writeFileSync(file, text);
    const digest = createHash("sha256").update(text).digest("hex");
    const invalidRecordId = `record:${sha256([mapping.source_id, digest, 1]).slice(0, 48)}`;
    const imported = await runMmpImport({
      pool: appPool, mappingPath: mixedMappingPath, filePath: file,
      now: new Date("2026-08-21T02:00:00.000Z"),
    });
    assert.deepEqual(
      { accepted: imported.accepted, rejected: imported.rejected, logical: imported.logical_events },
      { accepted: 1, rejected: 1, logical: 1 },
    );
    await withTenant(appPool, "tenant-local", async (client) => {
      const counts = await client.query(`SELECT
        (SELECT count(*) FROM ledger.logical_events WHERE event_id='synthetic-bulk-valid')::int AS accepted,
        (SELECT count(*) FROM ledger.logical_events WHERE event_id='synthetic-bulk-invalid')::int AS invalid_logical,
        (SELECT count(*) FROM ledger.rejections WHERE reason_code='payload_schema_invalid'
          AND artifact->>'record_id'=$1)::int AS invalid_rejections,
        (SELECT count(*) FROM control.import_row_rejections WHERE source_id='synthetic-bulk-rejection-clicks' AND reason_code='row_schema_invalid')::int AS row_rejections`,
      [invalidRecordId]);
      assert.deepEqual(counts.rows[0], {
        accepted: 1, invalid_logical: 0, invalid_rejections: 1, row_rejections: 1,
      });
    });
  });

  it("WO11 carries an attributed install, revenue, and cost through to non-zero D0 ROAS", async () => {
    const beforeJobAudits = await withTenant(appPool, "tenant-local", async (client) => {
      const result = await client.query<{ actor_ref: string; outcome: string; count: number }>(
        `SELECT actor_ref, outcome, count(*)::int AS count
           FROM ledger.audit_logs
          WHERE actor_type='system_job' AND action='job_completed'
            AND policy_version='job-health-v1'
          GROUP BY actor_ref, outcome`,
      );
      return new Map(result.rows.map((row) => [`${row.actor_ref}:${row.outcome}`, row.count]));
    });
    const timestamp = {
      source: "occurred_at",
      timestamp: { default_timezone: "UTC", truncate_to_milliseconds: true },
    };
    const providerContext = {
      provider: { const: "synthetic-cli-provider" },
      provider_attributed: { const: true },
      provider_attribution_strategy: { const: "click_through" },
      provider_campaign_ref: { source: "campaign_id" },
      provider_network: { source: "network" },
      provider_country: { source: "country", uppercase: true },
      provider_confirmed_at: timestamp,
    };
    const mappingBase = {
      version: "1.0.0", kind: "mmp_raw",
      tenant_id: "tenant-local", app_id: "app-local",
      provider: "synthetic-cli-provider", format: "json",
    };
    const installMappingPath = join(temporary, "synthetic-cli-install-mapping.json");
    const installFile = join(temporary, "synthetic-cli-install.json");
    writeFileSync(installMappingPath, JSON.stringify({
      ...mappingBase,
      source_id: "synthetic-cli-install-events",
      rules: [
        { target: "event_name", expression: { const: "install" } },
        { target: "event_id", expression: { source: "event_id", prefix: "install:" } },
        { target: "occurred_at", expression: timestamp },
        { target: "processing_purpose_id", expression: { const: "attribution" } },
        { target: "payload", expression: { object: {
          installation_id: { source: "installation_id" },
          referrer_status: { const: "none" },
          install_type: { const: "first_install" },
          country: { source: "country", uppercase: true },
          import_context: { object: {
            ...providerContext,
            provider_install_ref: { source: "provider_install_ref" },
          } },
        } } },
      ],
    }));
    writeFileSync(installFile, JSON.stringify([{
      event_id: "event", occurred_at: "2026-08-20T01:00:00",
      installation_id: "synthetic-cli-installation",
      provider_install_ref: "synthetic-cli-provider-install",
      campaign_id: "synthetic-cli-campaign",
      network: "synthetic-cli-network", country: "us",
    }]));

    const revenueMappingPath = join(temporary, "synthetic-cli-revenue-mapping.json");
    const revenueFile = join(temporary, "synthetic-cli-revenue.json");
    writeFileSync(revenueMappingPath, JSON.stringify({
      ...mappingBase,
      source_id: "synthetic-cli-revenue-events",
      rules: [
        { target: "event_name", expression: { const: "ad_revenue" } },
        { target: "event_id", expression: { source: "event_id", prefix: "revenue:" } },
        { target: "occurred_at", expression: timestamp },
        { target: "processing_purpose_id", expression: { const: "revenue_measurement" } },
        { target: "payload", expression: { object: {
          subject_scope: { const: "installation_level" },
          installation_id: { source: "installation_id" },
          ad_network: { source: "network" },
          country: { source: "country", uppercase: true },
          amount_unscaled: { source: "amount_unscaled" },
          amount_scale: { const: 6 },
          currency: { const: "USD" },
          currency_source: { const: "reported" },
          revenue_source: { const: "imported_reported" },
          import_context: { object: providerContext },
        } } },
      ],
    }));
    writeFileSync(revenueFile, JSON.stringify([{
      event_id: "event", occurred_at: "2026-08-20T02:00:00",
      installation_id: "synthetic-cli-installation",
      campaign_id: "synthetic-cli-campaign",
      network: "synthetic-cli-network", country: "us",
      amount_unscaled: "5000000",
    }]));

    const install = await runMmpImportCommand({
      pool: appPool, mappingPath: installMappingPath, filePath: installFile,
      now: new Date("2026-08-20T03:00:00.000Z"),
    });
    const revenue = await runMmpImportCommand({
      pool: appPool, mappingPath: revenueMappingPath, filePath: revenueFile,
      now: new Date("2026-08-20T03:01:00.000Z"),
    });
    const costFile = join(temporary, "synthetic-cli-cost.csv");
    writeFileSync(costFile, [
      "network,campaign_id,country,date,cost_micros,currency,as_of",
      "synthetic-cli-network,synthetic-cli-campaign,us,2026-08-20,2500000,USD,2026-08-20T12:00:00.000Z",
      "",
    ].join("\n"));
    const cost = await runCostImportCommand({
      pool: appPool,
      mappingPath: "examples/mappings/synthetic-manual-cost.json",
      filePath: costFile,
    });
    const runs = await runMetricDefinitionsCommand({
      pool: appPool,
      date: "2026-08-20",
      definitionsPath: "examples/metrics/synthetic-d0-roas.json",
    });
    assert.deepEqual(
      { status: install.status, accepted: install.accepted, rejected: install.rejected },
      { status: "completed", accepted: 1, rejected: 0 },
    );
    assert.deepEqual(
      { status: revenue.status, accepted: revenue.accepted, rejected: revenue.rejected },
      { status: "completed", accepted: 1, rejected: 0 },
    );
    assert.equal(cost.inserted, 1);
    assert.equal(cost.rows, 1);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].metric_name, "d0_roas");
    assert.equal(runs[0].value_state ?? "present", "present");
    assert.equal(runs[0].value_unscaled, "2000000");
    await withTenant(appPool, "tenant-local", async (client) => {
      const result = await client.query(`SELECT
        (SELECT count(*) FROM ledger.raw_records_current WHERE event_id='install:event' AND processing_purpose_id='attribution')::int AS install_purpose,
        (SELECT count(*) FROM ledger.raw_records_current WHERE event_id='revenue:event' AND processing_purpose_id='revenue_measurement')::int AS revenue_purpose,
        (SELECT count(*) FROM ledger.attribution_results WHERE subject_ref='synthetic-cli-installation' AND status='non_organic')::int AS attributions,
        (SELECT count(*) FROM ledger.ad_revenue_facts WHERE installation_id='synthetic-cli-installation' AND amount_unscaled='5000000')::int AS revenue,
        (SELECT count(*) FROM ledger.cost_records_current WHERE campaign_id='synthetic-cli-campaign' AND spend_unscaled='2500000')::int AS costs,
        (SELECT count(*) FROM ledger.metric_runs WHERE metric_name='d0_roas' AND value_state='present' AND value_unscaled='2000000' AND grouping->>'campaign_id'='synthetic-cli-campaign')::int AS runs`);
      assert.deepEqual(result.rows[0], {
        install_purpose: 1, revenue_purpose: 1, attributions: 1, revenue: 1, costs: 1, runs: 1,
      });
      const audits = await client.query<{ actor_ref: string; outcome: string; count: number }>(
        `SELECT actor_ref, outcome, count(*)::int AS count
           FROM ledger.audit_logs
          WHERE actor_type='system_job' AND action='job_completed'
            AND policy_version='job-health-v1'
          GROUP BY actor_ref, outcome
          ORDER BY actor_ref, outcome`,
      );
      const expectedDeltas = new Map([
        ["job:cost_import:succeeded", 1],
        ["job:metric_run:succeeded", 1],
        ["job:mmp_import:succeeded", 2],
      ]);
      for (const row of audits.rows) {
        const key = `${row.actor_ref}:${row.outcome}`;
        const delta = row.count - (beforeJobAudits.get(key) ?? 0);
        assert.equal(delta, expectedDeltas.get(key) ?? 0, `unexpected WO11 job outcome delta for ${key}`);
        expectedDeltas.delete(key);
      }
      assert.equal(expectedDeltas.size, 0);
    });
  });

  it("records one failed metric command after scope preflight", async () => {
    const definitions = join(temporary, "synthetic-failed-job-metrics.json");
    writeFileSync(definitions, JSON.stringify({
      tenant_id: "tenant-local",
      app_id: "app-local",
      evaluations: [],
    }));
    await assert.rejects(runMetricDefinitionsCommand({
      pool: appPool,
      date: "2026-08-20",
      definitionsPath: definitions,
    }), /requires fx_policy and at least one evaluation/);
    await withTenant(appPool, "tenant-local", async (client) => {
      const result = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM ledger.audit_logs
          WHERE actor_type='system_job' AND actor_ref='job:metric_run'
            AND action='job_completed' AND policy_version='job-health-v1'
            AND outcome='failed' AND reason_code='job_failed'
            AND target_scope='app' AND target_ref='app-local'`,
      );
      assert.equal(result.rows[0].count, 1);
    });
  });

  it("records wrong-kind mapping failures after reading a valid tenant/app scope", async () => {
    await assert.rejects(runCostImportCommand({
      pool: appPool,
      mappingPath,
      filePath: join(temporary, "not-read-by-wrong-kind-cost.json"),
    }), /requires a manual_cost mapping/);
    await assert.rejects(runMmpImportCommand({
      pool: appPool,
      mappingPath: "examples/mappings/synthetic-manual-cost.json",
      filePath: join(temporary, "not-read-by-wrong-kind-mmp.csv"),
    }), /requires an mmp_raw mapping/);
    await withTenant(appPool, "tenant-local", async (client) => {
      const result = await client.query<{ actor_ref: string; count: number }>(
        `SELECT actor_ref, count(*)::int AS count
           FROM ledger.audit_logs
          WHERE actor_type='system_job' AND action='job_completed'
            AND policy_version='job-health-v1' AND outcome='failed'
            AND actor_ref IN ('job:mmp_import','job:cost_import')
          GROUP BY actor_ref
          ORDER BY actor_ref`,
      );
      assert.deepEqual(result.rows, [
        { actor_ref: "job:cost_import", count: 1 },
        { actor_ref: "job:mmp_import", count: 1 },
      ]);
    });
  });

  it("WO16 backfills a historical cohort with an explicit late-input watermark", async () => {
    const file = join(temporary, "synthetic-backfill-install.json");
    writeFileSync(file, JSON.stringify([{
      primary_event_id: "synthetic-backfill-event", legacy_event_id: "",
      occurred_at: "2026-07-01T12:00:00", installation_id: "synthetic-backfill-installation",
    }]));
    await runMmpImport({
      pool: appPool,
      mappingPath: "examples/mappings/synthetic-fallback-install.json",
      filePath: file,
      now: new Date("2026-08-21T12:00:00.000Z"),
    });
    const definitions = join(temporary, "synthetic-backfill-metrics.json");
    writeFileSync(definitions, JSON.stringify({
      tenant_id: "tenant-local", app_id: "app-local",
      fx_policy: {
        policy_version: "synthetic-backfill-fx", target_currency: "USD", target_scale: 6,
        rounding_mode: "half_even", rates: [{
          currency: "USD", rate_unscaled: "100000000", rate_scale: 8,
          source: "synthetic-backfill-rate", as_of: "2026-08-21T00:00:00.000Z",
        }],
      },
      metric_definitions: [{
        metric_name: "synthetic_backfill_cohort_size",
        metric_definition_version: "0.4.0",
        anchor_event: "install", aggregation_time_zone: "UTC", value_type: "count",
        definition: {
          calculation: "cohort_size", window: { type: "elapsed", day: 0 }, numerator: "cohort_size",
        },
        rule_bundle_id: "synthetic-backfill-metric", rule_bundle_version: "0.4.0",
        rule_bundle_hash: "2222222222222222222222222222222222222222222222222222222222222222",
      }],
      evaluations: [{ metric_names: ["synthetic_backfill_cohort_size"], grouping: { cohort_date: "2026-07-01" } }],
    }));
    const legacy = await runMetricDefinitionsFile({
      pool: appPool, date: "2026-07-01", definitionsPath: definitions, persist: false,
    });
    const backfilled = await runMetricDefinitionsFile({
      pool: appPool, date: "2026-08-01", watermark: "2026-08-22T00:00:00.000Z",
      definitionsPath: definitions, persist: false,
    });
    assert.equal(legacy[0].value_unscaled, "0");
    assert.equal(backfilled[0].value_unscaled, "1");
    assert.equal(backfilled[0].grouping.dimensions.cohort_date, "2026-07-01");
    assert.equal(backfilled[0].input_received_at_watermark, "2026-08-22T00:00:00.000Z");
  });

  it("WO12 imports an exact synthetic decimal cost CSV without rounding", async () => {
    const file = join(temporary, "synthetic-decimal-cost.csv");
    writeFileSync(file, [
      "network,campaign_id,country,date,cost_decimal,currency,as_of",
      "synthetic-decimal-network,synthetic-decimal-campaign,us,2026-08-20,1.23,USD,2026-08-20T12:30:00.000Z",
      "",
    ].join("\n"));
    const imported = await runCostImportFile({
      pool: appPool,
      mappingPath: "examples/mappings/synthetic-decimal-cost.json",
      filePath: file,
    });
    assert.equal(imported.inserted, 1);
    assert.equal(imported.rows, 1);
    await withTenant(appPool, "tenant-local", async (client) => {
      const result = await client.query(`SELECT spend_unscaled, spend_scale, currency
        FROM ledger.cost_records_current
        WHERE campaign_id='synthetic-decimal-campaign'`);
      assert.deepEqual(result.rows, [{ spend_unscaled: "1230000", spend_scale: 6, currency: "USD" }]);
    });
  });

  it("WO11 rolls back raw, delivery, logical event, and facts as one record unit", async () => {
    const row = { ...JSON.parse(source)[0], event_id: "synthetic-atomic-event-11", click_id: "synthetic-click-atomicity" };
    const text = JSON.stringify([row]);
    const file = join(temporary, "atomic-projection.json");
    writeFileSync(file, text);
    const digest = createHash("sha256").update(text).digest("hex");
    const recordId = `record:${sha256(["synthetic-provider-clicks", digest, 0]).slice(0, 48)}`;
    await ownerPool.query(`CREATE OR REPLACE FUNCTION testing.reject_synthetic_click() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.click_id = 'synthetic-click-atomicity' THEN RAISE EXCEPTION 'synthetic projection fault'; END IF;
        RETURN NEW;
      END $$`);
    await ownerPool.query(`CREATE TRIGGER reject_synthetic_click BEFORE INSERT ON ledger.click_facts
      FOR EACH ROW EXECUTE FUNCTION testing.reject_synthetic_click()`);
    try {
      await assert.rejects(
        runMmpImport({ pool: appPool, mappingPath, filePath: file, now: new Date("2026-08-20T09:00:00.000Z") }),
        /synthetic projection fault/,
      );
      await withTenant(appPool, "tenant-local", async (client) => {
        const counts = await client.query(`SELECT
          (SELECT count(*) FROM ledger.raw_records WHERE event_id='synthetic-atomic-event-11')::int AS raw,
          (SELECT count(*) FROM ledger.logical_events WHERE event_id='synthetic-atomic-event-11')::int AS logical,
          (SELECT count(*) FROM ledger.click_facts WHERE click_id='synthetic-click-atomicity')::int AS facts,
          (SELECT count(*) FROM ledger.event_deliveries WHERE record_id=$1)::int AS deliveries,
          (SELECT count(*) FROM control.import_runs WHERE source_snapshot_digest=$2 AND status='failed')::int AS failed_runs`, [recordId, digest]);
        assert.deepEqual(counts.rows[0], { raw: 0, logical: 0, facts: 0, deliveries: 0, failed_runs: 1 });
      });
    } finally {
      await ownerPool.query("DROP TRIGGER IF EXISTS reject_synthetic_click ON ledger.click_facts");
      await ownerPool.query("DROP FUNCTION IF EXISTS testing.reject_synthetic_click()");
    }
  });

  it("WO11 rejects a producer event ID reused by a different event type across mappings", async () => {
    const sharedId = "synthetic-cross-type-event-11";
    const clickMapping = {
      version: "1.0.0", kind: "mmp_raw", source_id: "synthetic-cross-type-clicks",
      tenant_id: "tenant-local", app_id: "app-local", provider: "synthetic-cross-type-provider", format: "json",
      rules: [
        { target: "event_name", expression: { const: "click" } },
        { target: "event_id", expression: { source: "shared_id" } },
        { target: "occurred_at", expression: { source: "occurred_at", timestamp: { default_timezone: "UTC", truncate_to_milliseconds: true } } },
        { target: "payload", expression: { object: {
          click_id: { source: "click_id" },
          tracking_link_id: { const: "synthetic-cross-type-link-11" },
          campaign_id: { const: "synthetic-cross-type-campaign-11" },
          redirector_time_status: { const: "missing" },
        } } },
      ],
    };
    const installMapping = {
      ...clickMapping,
      source_id: "synthetic-cross-type-installs",
      rules: [
        { target: "event_name", expression: { const: "install" } },
        { target: "event_id", expression: { source: "shared_id" } },
        { target: "occurred_at", expression: { source: "occurred_at", timestamp: { default_timezone: "UTC", truncate_to_milliseconds: true } } },
        { target: "payload", expression: { object: {
          installation_id: { source: "installation_id" }, referrer_status: { const: "none" }, install_type: { const: "first_install" },
        } } },
      ],
    };
    const clickMappingPath = join(temporary, "cross-type-click.json");
    const installMappingPath = join(temporary, "cross-type-install.json");
    const clickFile = join(temporary, "cross-type-click-rows.json");
    const installFile = join(temporary, "cross-type-install-rows.json");
    writeFileSync(clickMappingPath, JSON.stringify(clickMapping));
    writeFileSync(installMappingPath, JSON.stringify(installMapping));
    writeFileSync(clickFile, JSON.stringify([{
      shared_id: sharedId, occurred_at: "2026-08-20T10:00:00", click_id: "synthetic-cross-type-click-11",
    }]));
    const installText = JSON.stringify([{
      shared_id: sharedId, occurred_at: "2026-08-20T10:01:00", installation_id: "synthetic-cross-type-installation-11",
    }]);
    writeFileSync(installFile, installText);
    await runMmpImport({ pool: appPool, mappingPath: clickMappingPath, filePath: clickFile, now: new Date("2026-08-20T11:00:00.000Z") });
    await runMmpImport({ pool: appPool, mappingPath: installMappingPath, filePath: installFile, now: new Date("2026-08-20T11:01:00.000Z") });
    const installRecordId = `record:${sha256([installMapping.source_id, createHash("sha256").update(installText).digest("hex"), 0]).slice(0, 48)}`;
    await withTenant(appPool, "tenant-local", async (client) => {
      const result = await client.query(`SELECT
        (SELECT count(*) FROM ledger.logical_events WHERE producer='import:synthetic-cross-type-provider' AND event_id=$1 AND event_name='click')::int AS click_logical,
        (SELECT count(*) FROM ledger.logical_events WHERE producer='import:synthetic-cross-type-provider' AND event_id=$1 AND event_name='install')::int AS install_logical,
        (SELECT count(*) FROM ledger.click_facts WHERE click_id='synthetic-cross-type-click-11')::int AS click_facts,
        (SELECT count(*) FROM ledger.install_facts WHERE installation_id='synthetic-cross-type-installation-11')::int AS install_facts,
        (SELECT count(*) FROM ledger.event_deliveries WHERE record_id=$2 AND duplicate_resolution='event_id_conflict')::int AS conflicts,
        (SELECT count(*) FROM ledger.rejections WHERE record_id=$2 AND reason_code='event_id_conflict')::int AS rejections`,
      [sharedId, installRecordId]);
      assert.deepEqual(result.rows[0], {
        click_logical: 1, install_logical: 0, click_facts: 1, install_facts: 0, conflicts: 1, rejections: 1,
      });
    });
  });
});

describe("MAX receiver integration", () => {
  const config: MaxReceiverConfig = {
    tenantId: "tenant-local", appId: "app-local", pathSecret: "synthetic-path",
    eventKey: "synthetic-event-key", tokenMode: "all_with_event_fallback",
    maxParameters: 40, maxQueryBytes: 8192,
  };
  const send = async (eventId: string, revenue = "0.123456"): Promise<{ status: number; elapsed: number }> => {
    const parameters = new URLSearchParams({ event_id: eventId, revenue, ts: "1787097600", ad_unit_id: "synthetic-unit", network: "synthetic-network", cc: "US" });
    parameters.set("event_token_all", expectedMaxTokenAll(parameters, config.eventKey));
    const response = responseCapture();
    const started = performance.now();
    await receiveMax({ url: `/v1/ingest/max/synthetic-path?${parameters}` } as IncomingMessage, response.value, { pool: appPool, payloadStore, config });
    return { status: response.status(), elapsed: (performance.now() - started) / 1000 };
  };

  const eventState = async (eventId: string) => withTenant(appPool, config.tenantId, async (client) => {
    const result = await client.query<{
      inboxes: number; receipt_times: number; unique_accepted: number;
      duplicate_accepted: number; conflict_rejected: number; canonical_links: number;
      raw_records: number; logical_events: number; revenue_facts: number; conflict_rejections: number;
    }>(
      `WITH max_records AS (
         SELECT ('record:max:' || inbox_id::text) AS record_id, received_at
           FROM ledger.ingest_inbox
          WHERE tenant_id=$1 AND app_id=$2
            AND producer='import:applovin-max' AND event_id=$3
       ), deliveries AS (
         SELECT delivery.*
           FROM ledger.event_deliveries AS delivery
           JOIN max_records AS max_record ON delivery.record_id::text=max_record.record_id
          WHERE delivery.tenant_id=$1 AND delivery.app_id=$2
       )
       SELECT
         (SELECT count(*)::int FROM max_records) AS inboxes,
         (SELECT count(DISTINCT received_at)::int FROM max_records) AS receipt_times,
         (SELECT count(*)::int FROM deliveries WHERE ingestion_status='accepted' AND duplicate_resolution='unique') AS unique_accepted,
         (SELECT count(*)::int FROM deliveries WHERE ingestion_status='accepted' AND duplicate_resolution='duplicate_delivery') AS duplicate_accepted,
         (SELECT count(*)::int FROM deliveries WHERE ingestion_status='rejected' AND duplicate_resolution='event_id_conflict') AS conflict_rejected,
         (SELECT count(*)::int
            FROM deliveries AS later
            JOIN deliveries AS first ON later.canonical_record_id=first.record_id
           WHERE later.duplicate_resolution IN ('duplicate_delivery','event_id_conflict')
             AND first.duplicate_resolution='unique') AS canonical_links,
         (SELECT count(*)::int
            FROM ledger.raw_records AS raw
            JOIN max_records AS max_record ON raw.record_id::text=max_record.record_id
           WHERE raw.tenant_id=$1 AND raw.app_id=$2) AS raw_records,
         (SELECT count(*)::int FROM ledger.logical_events
           WHERE tenant_id=$1 AND app_id=$2
             AND producer='import:applovin-max' AND event_id=$3) AS logical_events,
         (SELECT count(*)::int
            FROM ledger.ad_revenue_facts AS revenue
            JOIN ledger.logical_events AS logical USING (logical_event_id)
            JOIN max_records AS max_record ON logical.record_id::text=max_record.record_id
           WHERE revenue.tenant_id=$1 AND revenue.app_id=$2) AS revenue_facts,
         (SELECT count(*)::int
            FROM ledger.rejections AS rejection
           JOIN max_records AS max_record ON rejection.record_id::text=max_record.record_id
           WHERE rejection.tenant_id=$1 AND rejection.app_id=$2
             AND rejection.reason_code='event_id_conflict'
             AND rejection.artifact->>'payload_disposition'='protected'
             AND rejection.artifact->>'retained'='protected_conflict_evidence') AS conflict_rejections`,
      [config.tenantId, config.appId, eventId],
    );
    return result.rows[0];
  });

  it("A6 verifies, durably enqueues, returns 204, and deduplicates in the worker", async () => {
    const eventId = "abcdef0123456789abcdef0123456789abcdef01";
    const first = await send(eventId);
    assert.equal(await processMaxInbox(appPool, payloadStore, "tenant-local"), 1);
    const second = await send(eventId);
    assert.equal(await processMaxInbox(appPool, payloadStore, "tenant-local"), 1);
    assert.equal(first.status, 204);
    assert.equal(second.status, 204);
    assert.ok(first.elapsed < 1);
    assert.deepEqual(await eventState(eventId), {
      inboxes: 2, receipt_times: 2, unique_accepted: 1,
      duplicate_accepted: 1, conflict_rejected: 0, canonical_links: 1,
      raw_records: 1, logical_events: 1, revenue_facts: 1, conflict_rejections: 0,
    });
  });

  it("processes MAX inbox work through isolated one-connection job and scheduler pools", async () => {
    const connectionString = process.env.OPENMASU_APP_DATABASE_URL;
    assert.ok(connectionString, "OPENMASU_APP_DATABASE_URL is required");
    const eventId = "abcdef0123456789abcdef0123456789abcdef02";
    assert.equal((await send(eventId)).status, 204);
    const jobPool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 1_000 });
    const schedulerPool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 1_000 });
    let processed = 0;
    try {
      const outcome = await runScheduledJob({
        store: new PostgresSchedulerStore(schedulerPool),
        tenantId: config.tenantId,
        job: "max_inbox",
        policy: { intervalMs: 1_000, retryMs: 1_000, leaseMs: 60_000 },
        task: async () => { processed = await processMaxInbox(jobPool, payloadStore, config.tenantId); },
        now: () => new Date("2026-08-26T02:00:00.000Z"),
      });
      assert.equal(outcome, "succeeded");
      assert.equal(processed, 1);
      assert.deepEqual(await eventState(eventId), {
        inboxes: 1, receipt_times: 1, unique_accepted: 1,
        duplicate_accepted: 0, conflict_rejected: 0, canonical_links: 0,
        raw_records: 1, logical_events: 1, revenue_facts: 1, conflict_rejections: 0,
      });
    } finally {
      await Promise.all([jobPool.end(), schedulerPool.end()]);
    }
  });

  it("A6 rejects a changed MAX payload that reuses an event ID", async () => {
    const eventId = "abcdef0123456789abcdef0123456789abcdef03";
    assert.equal((await send(eventId, "0.123456")).status, 204);
    assert.equal(await processMaxInbox(appPool, payloadStore, "tenant-local"), 1);
    assert.equal((await send(eventId, "0.654321")).status, 204);
    assert.equal(await processMaxInbox(appPool, payloadStore, "tenant-local"), 1);
    assert.deepEqual(await eventState(eventId), {
      inboxes: 2, receipt_times: 2, unique_accepted: 1,
      duplicate_accepted: 0, conflict_rejected: 1, canonical_links: 1,
      raw_records: 2, logical_events: 1, revenue_facts: 1, conflict_rejections: 1,
    });
  });

  it("Issue 61 keeps MAX reporting snapshots idempotent, restatable, and separate from S2S cohort evidence", async () => {
    const eventId = "abcdef0123456789abcdef0123456789abcdef61";
    assert.equal((await send(eventId, "0.500000")).status, 204);
    assert.equal(await processMaxInbox(appPool, payloadStore, "tenant-local"), 1);
    const secrets = {
      read: (name: string) => name === "OPENMASU_MAX_REPORT_KEY" ? "synthetic-max-report-key" : undefined,
      require(name: string) {
        const value = this.read(name);
        if (!value) throw new Error(`${name} is required`);
        return value;
      },
    };
    let estimatedRevenue = "1.250000";
    const fetchReport = async (): Promise<Response> => new Response(JSON.stringify({
      code: 200,
      count: 1,
      results: [{
        day: "2026-08-23",
        country: "us",
        max_ad_unit_id: "synthetic-unit-61",
        network: "synthetic-network",
        estimated_revenue: estimatedRevenue,
      }],
    }));
    const base = {
      pool: appPool,
      fetch: fetchReport,
      secrets,
      tenantId: "tenant-local",
      appId: "app-local",
      start: "2026-08-23",
      end: "2026-08-23",
      asOf: "2026-08-24T08:00:00.000Z",
      now: new Date("2026-08-24T09:00:00.000Z"),
    };
    const first = await runMaxRevenueImportCommand(base);
    const repeated = await runMaxRevenueImport(base);
    estimatedRevenue = "2.500000";
    const restated = await runMaxRevenueImport({ ...base, asOf: "2026-08-24T10:00:00.000Z" });
    assert.deepEqual(
      [first.rows, first.inserted, repeated.inserted, restated.inserted],
      [1, 1, 0, 1],
    );
    await withTenant(appPool, "tenant-local", async (client) => {
      const result = await client.query(`SELECT
        (SELECT count(*) FROM ledger.aggregate_revenue_snapshots
          WHERE max_ad_unit_id='synthetic-unit-61')::int AS report_history,
        (SELECT amount_unscaled FROM ledger.aggregate_revenue_snapshots_current
          WHERE max_ad_unit_id='synthetic-unit-61') AS report_current,
        (SELECT count(*) FROM ledger.ad_revenue_facts AS revenue
          JOIN ledger.logical_events AS logical USING (logical_event_id)
          WHERE logical.producer='import:applovin-max' AND logical.event_id=$1)::int AS s2s_facts,
        (SELECT count(*) FROM ledger.ad_revenue_facts AS revenue
          JOIN ledger.logical_events AS logical USING (logical_event_id)
          JOIN ledger.install_facts AS install
            ON install.tenant_id=revenue.tenant_id AND install.app_id=revenue.app_id
           AND install.installation_id=revenue.installation_id
          WHERE logical.producer='import:applovin-max' AND logical.event_id=$1)::int AS cohort_joined,
        (SELECT count(*) FROM ledger.logical_events
          WHERE producer='import:max-reporting')::int AS reporting_logical_events,
        (SELECT count(*) FROM ledger.audit_logs
          WHERE actor_ref='job:max_revenue_import' AND outcome='succeeded')::int AS completed_jobs`,
      [eventId]);
      assert.deepEqual(result.rows[0], {
        report_history: 2,
        report_current: "2500000",
        s2s_facts: 1,
        cohort_joined: 0,
        reporting_logical_events: 0,
        completed_jobs: 1,
      });
    });
  });

  it("WO11 rejects an invalid inbox payload, completes the run, and stays idempotent", async () => {
    const eventId = "abcdef0123456789abcdef0123456789abcdef11";
    const parameters = new URLSearchParams({
      event_id: eventId, revenue: "0.123456", ts: "1787097600",
      ad_unit_id: "synthetic-unit", network: "synthetic-network", cc: "USA",
    });
    parameters.set("event_token_all", expectedMaxTokenAll(parameters, config.eventKey));
    const response = responseCapture();
    await receiveMax({ url: `/v1/ingest/max/synthetic-path?${parameters}` } as IncomingMessage, response.value, { pool: appPool, payloadStore, config });
    assert.equal(response.status(), 204);
    const inbox = await withTenant(appPool, "tenant-local", async (client) =>
      (await client.query<{ inbox_id: string; raw_query_ref: string; raw_query_digest: string }>(
        "SELECT inbox_id::text, raw_query_ref, raw_query_digest FROM ledger.ingest_inbox WHERE event_id=$1",
        [eventId],
      )).rows[0]);
    assert.equal(await processMaxInbox(appPool, payloadStore, "tenant-local"), 1);
    assert.equal(await processMaxInbox(appPool, payloadStore, "tenant-local"), 0);
    await assert.rejects(payloadStore.read(inbox.raw_query_ref));
    await withTenant(appPool, "tenant-local", async (client) => {
      const result = await client.query(`SELECT
        (SELECT count(*) FROM ledger.rejections WHERE record_id=$1 AND reason_code='payload_schema_invalid')::int AS rejections,
        (SELECT count(*) FROM ledger.event_deliveries WHERE record_id=$1 AND ingestion_status='rejected' AND payload_disposition='discarded')::int AS deliveries,
        (SELECT count(*) FROM ledger.raw_records WHERE record_id=$1)::int AS raw,
        (SELECT count(*) FROM ledger.logical_events WHERE record_id=$1)::int AS logical,
        (SELECT count(*) FROM control.import_runs WHERE source_snapshot_digest=$2 AND status='completed')::int AS completed_runs,
        (SELECT count(*) FROM control.import_attempts a JOIN control.import_runs r USING (import_run_id) WHERE r.source_snapshot_digest=$2)::int AS attempts,
        (SELECT count(*) FROM control.import_row_rejections x JOIN control.import_runs r USING (import_run_id) WHERE r.source_snapshot_digest=$2 AND x.reason_code='row_schema_invalid')::int AS row_rejections`,
      [`record:max:${inbox.inbox_id}`, inbox.raw_query_digest]);
      assert.deepEqual(result.rows[0], {
        rejections: 1, deliveries: 1, raw: 0, logical: 0,
        completed_runs: 1, attempts: 0, row_rejections: 1,
      });
    });
  });

  it("A6 rejects tampering and denied identifiers without writing a payload", async () => {
    for (const query of [
      "event_id=bad&revenue=1&event_token_all=tampered",
      "event_id=bad&idfa=synthetic-denied-id&event_token_all=tampered",
    ]) {
      const response = responseCapture();
      await receiveMax({ url: `/v1/ingest/max/synthetic-path?${query}` } as IncomingMessage, response.value, { pool: appPool, payloadStore, config });
      assert.ok([400, 401].includes(response.status()));
    }
    await withTenant(appPool, "tenant-local", async (client) => {
      const audit = await client.query("SELECT count(*)::int AS count FROM ledger.audit_logs WHERE outcome='failed'");
      assert.ok(audit.rows[0].count >= 2);
      const denied = await client.query(
        "SELECT count(*)::int AS count FROM ledger.ingest_inbox WHERE artifact::text LIKE $1",
        ["%synthetic-denied-id%"],
      );
      assert.equal(denied.rows[0].count, 0);
    });
    assert.equal(await payloadStore.scanFor("synthetic-denied-id"), false);
  });

  it("A10 rejects a postback above the parameter limit before persistence", async () => {
    const limited = { ...config, maxParameters: 2 };
    const before = await withTenant(appPool, "tenant-local", async (client) =>
      (await client.query("SELECT count(*)::int AS count FROM ledger.ingest_inbox")).rows[0].count,
    );
    const parameters = new URLSearchParams({ event_id: "parameter-limit-synthetic", revenue: "0.1", ts: "1787097600" });
    parameters.set("event_token_all", expectedMaxTokenAll(parameters, limited.eventKey));
    const response = responseCapture();
    await receiveMax(
      { url: `/v1/ingest/max/synthetic-path?${parameters}` } as IncomingMessage,
      response.value,
      { pool: appPool, payloadStore, config: limited },
    );
    const after = await withTenant(appPool, "tenant-local", async (client) =>
      (await client.query("SELECT count(*)::int AS count FROM ledger.ingest_inbox")).rows[0].count,
    );
    assert.equal(response.status(), 400);
    assert.equal(after, before);
  });

  it("A10 returns 429 before a second postback is persisted", async () => {
    const server = createServer(createRequestHandler({
      pool: appPool, readerPool: appPool, payloadStore, maxConfig: config,
      publicBaseUrl: "http://localhost:8080", redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: false, publicBaseUrl: "http://localhost:8080", tenantId: config.tenantId, sessionTtlSeconds: 43200 },
      maxBucket: new TokenBucket(0.0001, 1, performance.now()),
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const parameters = new URLSearchParams({ event_id: "rate-limit-synthetic", revenue: "0.1", ts: "1787097600" });
    parameters.set("event_token_all", expectedMaxTokenAll(parameters, config.eventKey));
    try {
      const first = await fetch(`http://127.0.0.1:${address.port}/v1/ingest/max/synthetic-path?${parameters}`);
      const second = await fetch(`http://127.0.0.1:${address.port}/v1/ingest/max/synthetic-path?${parameters}`);
      assert.equal(first.status, 204);
      assert.equal(second.status, 429);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("admin privacy integration", () => {
  it("A9 authenticates, deletes through append-only artifacts, supersedes D0, and rejects the device path", async () => {
    const adminKey = "synthetic-admin-key-00000000000000000000000000000001";
    const previousKey = "synthetic-admin-key-previous-000000000000000000000001";
    const privacyDigestKey = "synthetic-private-digest-key";
    await ensureAdminKeys(appPool, { tenantId: "tenant-local", appId: "app-local" }, [adminKey, previousKey], "2026-08-19T13:00:00.000Z");
    const metric = {
      metric_run_id: "metric:privacy-baseline", metric_name: "d0_install_to_24h_ad_revenue_usd",
      metric_definition_version: "0.3.0", input_snapshot_id: "a".repeat(64),
      input_received_at_watermark: "2026-08-19T12:59:59.999Z", input_ledger_position: "2026-08-19T12:00:00.000Z|synthetic",
      computed_at: "2026-08-19T13:00:00.000Z", data_freshness: "complete", aggregation_time_zone: "UTC",
      rule_bundle_id: "metric-default", rule_bundle_version: "0.3.0", rule_bundle_hash: "b".repeat(64),
      rounding_mode: "half_even", reproducibility_status: "fully_reproducible",
      value_type: "money", value_unscaled: "0", amount_scale: 6, currency: "USD",
    };
    await withTenant(appPool, "tenant-local", (client) => client.query(
      `INSERT INTO ledger.metric_runs (
        metric_run_id, tenant_id, app_id, metric_name, metric_definition_version,
        grouping, grouping_digest, input_snapshot_id, input_received_at_watermark,
        input_ledger_position, computed_at, data_freshness, aggregation_time_zone,
        rule_bundle_id, rule_bundle_version, rule_bundle_hash, rounding_mode,
        reproducibility_status, value_type, value_state, value_unscaled, amount_scale, currency, artifact
      ) VALUES ($1,'tenant-local','app-local',$2,$3,'{}'::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'present',$17,$18,$19,$20::jsonb)
      ON CONFLICT DO NOTHING`,
      [metric.metric_run_id, metric.metric_name, metric.metric_definition_version, "c".repeat(64), metric.input_snapshot_id,
        metric.input_received_at_watermark, metric.input_ledger_position, metric.computed_at, metric.data_freshness,
        metric.aggregation_time_zone, metric.rule_bundle_id, metric.rule_bundle_version, metric.rule_bundle_hash,
        metric.rounding_mode, metric.reproducibility_status, metric.value_type, metric.value_unscaled,
        metric.amount_scale, metric.currency, JSON.stringify(metric)],
    ).then(() => undefined));
    const config: MaxReceiverConfig = {
      tenantId: "tenant-local", appId: "app-local", pathSecret: "synthetic-path",
      eventKey: "synthetic-event-key", tokenMode: "all", maxParameters: 40, maxQueryBytes: 8192,
    };
    const payloadReference = await withTenant(appPool, "tenant-local", async (client) =>
      (await client.query<{ raw_query_ref: string }>("SELECT raw_query_ref FROM ledger.ingest_inbox ORDER BY received_at LIMIT 1")).rows[0].raw_query_ref,
    );
    assert.equal(await payloadStore.scanFor("0.123456"), false);
    assert.match((await payloadStore.read(payloadReference)).toString("utf8"), /0\.123456/);
    const server = createServer(createRequestHandler({
      pool: appPool, readerPool: appPool, payloadStore, maxConfig: config,
      publicBaseUrl: "http://localhost:8080", redirectorBaseUrl: "http://localhost:8090",
      dashboard: { enabled: false, publicBaseUrl: "http://localhost:8080", tenantId: config.tenantId, sessionTtlSeconds: 43200 },
      privacySubjectDigestKey: privacyDigestKey,
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/v1/admin/privacy-requests`;
    const base = { tenant_id: "tenant-local", app_id: "app-local", deletion_scope: "app", deletion_subject_ref: "app-local" };
    try {
      const unauthorized = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...base, requested_via: "tenant_admin_api" }) });
      assert.equal(unauthorized.status, 401);
      const device = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${adminKey}`, "content-type": "application/json" }, body: JSON.stringify({ ...base, deletion_scope: "installation", deletion_subject_ref: "installation:synthetic", requested_via: "on_device_sdk" }) });
      assert.equal(device.status, 501);
      assert.deepEqual(await device.json(), { error: "on_device_path_not_implemented" });
      const success = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${previousKey}`, "content-type": "application/json" }, body: JSON.stringify({ ...base, requested_via: "tenant_admin_api" }) });
      assert.equal(success.status, 201);
      const artifact = await success.json() as Record<string, unknown>;
      assert.equal(artifact.deletion_subject_ref, undefined);
      assert.equal(artifact.deletion_subject_digest, privacySubjectDigest(privacyDigestKey, {
        ...base,
        deletion_scope: "app",
      }));
      assert.notEqual(artifact.deletion_subject_digest, sha256([
        base.tenant_id, base.app_id, base.deletion_scope, base.deletion_subject_ref,
      ]));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await withTenant(appPool, "tenant-local", async (client) => {
      const counts = await client.query(`SELECT
        (SELECT count(*) FROM ledger.privacy_tombstones)::int AS tombstones,
        (SELECT count(*) FROM ledger.corrections)::int AS corrections,
        (SELECT count(*) FROM ledger.metric_runs WHERE supersedes_metric_run_id='metric:privacy-baseline')::int AS superseding,
        (SELECT count(*) FROM ledger.audit_logs WHERE actor_type='admin_key' AND outcome='succeeded')::int AS audits`);
      assert.ok(counts.rows[0].tombstones > 0);
      assert.ok(counts.rows[0].corrections > 0);
      assert.equal(counts.rows[0].superseding, 1);
      assert.equal(counts.rows[0].audits, 1);
    });
    await assert.rejects(payloadStore.read(payloadReference));
  });
});

function responseCapture(): { value: ServerResponse; status: () => number } {
  let code = 0;
  const value = {
    writeHead(status: number) { code = status; return this; },
    end() { return this; },
  } as unknown as ServerResponse;
  return { value, status: () => code };
}
