import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { createAppPool, createMigrationPool, EncryptedFilePayloadStore, withTenant } from "@open-mmp/runtime";
import { runMmpImport } from "./runner.js";
import { persistCostImport } from "./cost.js";
import { expectedMaxTokenAll, receiveMax, type MaxReceiverConfig } from "../../../api/src/max-receiver.js";
import { processMaxInbox } from "./max-worker.js";
import { ensureAdminKeys } from "../../../api/src/admin-auth.js";
import { createRequestHandler } from "../../../api/src/router.js";
import { TokenBucket } from "../../../api/src/rate-limit.js";

const appPool = createAppPool();
const ownerPool = createMigrationPool();
const temporary = mkdtempSync(join(tmpdir(), "openmmp-runtime-test-"));
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
    const first = await runMmpImport({ pool: appPool, mappingPath, filePath: firstFile, now: new Date("2026-08-19T10:00:00.000Z") });
    const skipped = await runMmpImport({ pool: appPool, mappingPath, filePath: firstFile, now: new Date("2026-08-19T10:01:00.000Z") });
    const second = await runMmpImport({ pool: appPool, mappingPath, filePath: equivalentFile, now: new Date("2026-08-19T10:02:00.000Z") });
    assert.equal(first.status, "completed");
    assert.equal(skipped.status, "skipped");
    assert.equal(second.status, "completed");
    await withTenant(appPool, "tenant-local", async (client) => {
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
});

describe("MAX receiver integration", () => {
  const config: MaxReceiverConfig = {
    tenantId: "tenant-local", appId: "app-local", pathSecret: "synthetic-path",
    eventKey: "synthetic-event-key", tokenMode: "all_with_event_fallback",
    maxParameters: 40, maxQueryBytes: 8192,
  };
  it("A6 verifies, durably enqueues, returns 204, and deduplicates in the worker", async () => {
    const send = async (eventId: string): Promise<{ status: number; elapsed: number }> => {
      const parameters = new URLSearchParams({ event_id: eventId, revenue: "0.123456", ts: "1787097600", ad_unit_id: "synthetic-unit", network: "synthetic-network", cc: "US" });
      parameters.set("event_token_all", expectedMaxTokenAll(parameters, config.eventKey));
      const response = responseCapture();
      const started = performance.now();
      await receiveMax({ url: `/v1/ingest/max/synthetic-path?${parameters}` } as IncomingMessage, response.value, { pool: appPool, payloadStore, config });
      return { status: response.status(), elapsed: (performance.now() - started) / 1000 };
    };
    const first = await send("abcdef0123456789abcdef0123456789abcdef01");
    await processMaxInbox(appPool, payloadStore, "tenant-local");
    const second = await send("abcdef0123456789abcdef0123456789abcdef01");
    await processMaxInbox(appPool, payloadStore, "tenant-local");
    assert.equal(first.status, 204);
    assert.equal(second.status, 204);
    assert.ok(first.elapsed < 1);
    await withTenant(appPool, "tenant-local", async (client) => {
      const all = await client.query("SELECT duplicate_resolution, count(*)::int AS count FROM ledger.event_deliveries GROUP BY 1 ORDER BY 1");
      assert.ok(all.rows.some((row) => row.duplicate_resolution === "duplicate_delivery"));
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
      pool: appPool, payloadStore, maxConfig: config, maxBucket: new TokenBucket(0.0001, 1, performance.now()),
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
    await ensureAdminKeys(appPool, { tenantId: "tenant-local", appId: "app-local" }, [adminKey, previousKey], "2026-08-19T13:00:00.000Z");
    const metric = {
      metric_run_id: "metric:privacy-baseline", metric_name: "d0_install_to_24h_ad_revenue_usd",
      metric_definition_version: "0.2.0", input_snapshot_id: "a".repeat(64),
      input_received_at_watermark: "2026-08-19T12:59:59.999Z", input_ledger_position: "2026-08-19T12:00:00.000Z|synthetic",
      computed_at: "2026-08-19T13:00:00.000Z", data_freshness: "complete", aggregation_time_zone: "UTC",
      rule_bundle_id: "metric-default", rule_bundle_version: "0.2.0", rule_bundle_hash: "b".repeat(64),
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
    const server = createServer(createRequestHandler({ pool: appPool, payloadStore, maxConfig: config }));
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
