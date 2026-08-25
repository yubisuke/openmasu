import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ensureAdminKeys } from "../../api/src/admin-auth.js";
import { createRequestHandler } from "../../api/src/router.js";
import type { MaxReceiverConfig } from "../../api/src/max-receiver.js";
import type { PayloadStore } from "@open-mmp/runtime";
import { createAppPool, createSeedPool } from "@open-mmp/runtime";
import type { Pool } from "pg";
import { ingestFixture } from "./ingestion.js";
import { computeSqlMetricRuns } from "./metrics/cohort.js";
import { sha256 } from "@open-mmp/attribution-core";

type Any = Record<string, any>;
const adminKey = "synthetic-report-admin-key-000000000000000000000001";

function fixture(name: string): Any {
  return JSON.parse(readFileSync(join(process.cwd(), "fixtures", "v0.2", name, "input.json"), "utf8"));
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
    server = createServer(createRequestHandler({ pool: appPool, payloadStore: unusedPayloadStore, maxConfig: config }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server?.close((error) => error ? reject(error) : resolve()));
    await appPool?.end();
    await seedPool?.end();
  });

  it("B7 protects reporting with the admin key and preserves JSON/CSV values and metadata", async () => {
    const unauthorized = await fetch(`${baseUrl}/v1/reports/metrics?format=json`);
    assert.equal(unauthorized.status, 401);
    const headers = { authorization: `Bearer ${adminKey}` };
    const jsonResponse = await fetch(`${baseUrl}/v1/reports/metrics?format=json`, { headers });
    const csvResponse = await fetch(`${baseUrl}/v1/reports/metrics?format=csv`, { headers });
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
  });

  it("B8 exports undefined ROAS as absent value plus reason", async () => {
    const input = fixture("37-undefined-organic-roas");
    await registerAndIngest("37-undefined-organic-roas", input);
    await computeSqlMetricRuns(appPool, input, true);
    const response = await fetch(`${baseUrl}/v1/reports/metrics?format=json`, {
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
      const response = await fetch(`${baseUrl}/v1/audit/differences?format=json`, {
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
});
