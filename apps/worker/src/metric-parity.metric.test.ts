import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { evaluate, jcs, roundHalfEven, sha256 } from "@open-mmp/attribution-core";
import { createAppPool, createSeedPool, requireEnvironment, withTenant } from "@open-mmp/runtime";
import { Client, type Pool } from "pg";
import { ingestFixture } from "./ingestion.js";
import { computeSqlMetricRuns, computeSqlMetricRunsWithClient } from "./metrics/cohort.js";

type Any = Record<string, any>;
const fixtureName = "33-stage-b-cohort-metrics";
const fixtureDirectory = join(process.cwd(), "fixtures", "v0.2", fixtureName);
const input: Any = JSON.parse(readFileSync(join(fixtureDirectory, "input.json"), "utf8"));
const goldenPath = join(fixtureDirectory, "expected_metric_runs.json");
const goldenBefore = readFileSync(goldenPath);
const golden: Any[] = JSON.parse(goldenBefore.toString("utf8"));
const oracle = evaluate(input).metric_runs;

let appPool: Pool;
let seedPool: Pool;
let sqlRuns: Any[];
let persistedRuns: Any[];

describe("M1b SQL metric parity", { concurrency: false }, () => {
  before(async () => {
    appPool = createAppPool();
    seedPool = createSeedPool();
    await ingestFixture(fixtureName, input, appPool, seedPool);
    const scope = input.server_context;
    const expectedIds = oracle.map((run: Any) => run.metric_run_id);
    const preexistingCount = await withTenant(appPool, scope.tenant_id, async (client) => {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ledger.metric_runs
         WHERE tenant_id=$1 AND app_id=$2 AND metric_run_id = ANY($3::text[])`,
        [scope.tenant_id, scope.app_id, expectedIds],
      );
      return result.rows[0].count;
    });
    assert.equal(preexistingCount, "0", "fixture ingestion must not pre-seed SQL cohort outputs");
    sqlRuns = await computeSqlMetricRuns(appPool, input, true);
    const ids = sqlRuns.map((run) => run.metric_run_id);
    persistedRuns = await withTenant(appPool, scope.tenant_id, async (client) => {
      const result = await client.query<{ artifact: Any }>(
        `SELECT artifact FROM ledger.metric_runs
         WHERE tenant_id=$1 AND app_id=$2 AND metric_run_id = ANY($3::text[])
         ORDER BY metric_run_id`,
        [scope.tenant_id, scope.app_id, ids],
      );
      return result.rows.map((row) => row.artifact);
    });
  });

  after(async () => {
    await appPool?.end();
    await seedPool?.end();
  });

  it("B2 SQL cohort metric_runs are JCS-byte-identical to evaluator", () => {
    assert.equal(sqlRuns.length, 7);
    assert.equal(Buffer.compare(Buffer.from(jcs(oracle)), Buffer.from(jcs(golden))), 0);
    assert.equal(Buffer.compare(Buffer.from(jcs(sqlRuns)), Buffer.from(jcs(oracle))), 0);
    assert.equal(Buffer.compare(Buffer.from(jcs(persistedRuns)), Buffer.from(jcs(oracle))), 0);
  });

  it("B3 half_even_div matches TypeScript tie vectors", async () => {
    const vectors = [
      { numerator: 1n, denominator: 2n },
      { numerator: 3n, denominator: 2n },
      { numerator: 5n, denominator: 2n },
      { numerator: -1n, denominator: 2n },
      { numerator: -3n, denominator: 2n },
      { numerator: 1n, denominator: 3n },
      { numerator: 2n, denominator: 3n },
    ];
    const actual = await withTenant(appPool, input.server_context.tenant_id, async (client) => {
      const result = await client.query<{ value: string }>(
        `SELECT ledger.half_even_div(item.numerator, item.denominator)::text AS value
         FROM jsonb_to_recordset($1::jsonb) AS item(numerator numeric, denominator numeric)`,
        [JSON.stringify(vectors.map(({ numerator, denominator }) => ({
          numerator: numerator.toString(),
          denominator: denominator.toString(),
        })))],
      );
      return result.rows.map((row) => row.value);
    });
    assert.deepEqual(actual, vectors.map(({ numerator, denominator }) =>
      roundHalfEven(numerator, denominator).toString()));
    assert.deepEqual(actual.slice(0, 3), ["0", "2", "2"]);
  });

  it("B3 half-up mutation fails SQL/evaluator parity and rolls back", async () => {
    const client = new Client({
      connectionString: requireEnvironment(
        "OPENMMP_MIGRATION_DATABASE_URL",
        process.env.OPENMMP_MIGRATION_DATABASE_URL,
      ),
    });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE openmmp_owner");
      await client.query("SELECT set_config('open_mmp.tenant_id', $1, true)", [input.server_context.tenant_id]);
      await client.query(`
        CREATE OR REPLACE FUNCTION ledger.half_even_div(numerator numeric, denominator numeric)
        RETURNS numeric
        LANGUAGE sql
        IMMUTABLE
        STRICT
        PARALLEL SAFE
        AS $$
          SELECT CASE WHEN numerator < 0 THEN -1 ELSE 1 END *
            (trunc(abs(numerator) / denominator) +
             CASE WHEN mod(abs(numerator), denominator) * 2 >= denominator THEN 1 ELSE 0 END)
        $$
      `);
      const halfUpRuns = await computeSqlMetricRunsWithClient(client, input, false);
      assert.notEqual(jcs(halfUpRuns), jcs(oracle));
      const ltv = halfUpRuns.find((run) => run.metric_name === "cohort_ltv_d7_usd");
      assert.equal(ltv?.value_unscaled, "150000003");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }

    const restored = await computeSqlMetricRuns(appPool, input, false);
    assert.equal(jcs(restored), jcs(oracle));
    assert.equal(sha256(readFileSync(goldenPath)), sha256(goldenBefore));
    assert.equal(Buffer.compare(readFileSync(goldenPath), goldenBefore), 0);
  });

  it("B4 reproduces the independently hand-calculated D7 ROAS and D1 retention", () => {
    const d7Roas = sqlRuns.find((run) => run.metric_name === "d7_roas");
    const retentionD1 = sqlRuns.find((run) => run.metric_name === "retention_d1");
    assert.equal(d7Roas?.value_unscaled, "1500000");
    assert.equal(retentionD1?.value_unscaled, "1000000");
  });

  it("B2 excludes sessions received after the fixed watermark", async () => {
    const mutation = structuredClone(input);
    mutation.metric_evaluations[0] = {
      ...mutation.metric_evaluations[0],
      metric_run_id_prefix: "run-33-late-session",
      input_received_at_watermark: "2026-08-07T23:59:59.999Z",
      metric_names: ["retention_d7", "cohort_install_count"],
    };
    await ingestFixture(fixtureName, mutation, appPool, seedPool);
    const expected = evaluate(mutation).metric_runs;
    const actual = await computeSqlMetricRuns(appPool, mutation, false);
    assert.equal(jcs(actual), jcs(expected));
    assert.equal(actual.find((run) => run.metric_name === "retention_d7")?.value_unscaled, "0");
  });

  it("B2 excludes installs received after the fixed watermark", async () => {
    const mutation = structuredClone(input);
    mutation.records.find((record: Any) => record.record_id === "install-33").received_at =
      "2026-08-09T00:00:00.001Z";
    mutation.metric_evaluations[0] = {
      ...mutation.metric_evaluations[0],
      metric_run_id_prefix: "run-33-late-install",
      metric_names: ["cohort_install_count"],
    };
    await ingestFixture(fixtureName, mutation, appPool, seedPool);
    const expected = evaluate(mutation).metric_runs;
    const actual = await computeSqlMetricRuns(appPool, mutation, false);
    assert.equal(jcs(actual), jcs(expected));
    assert.equal(actual[0]?.value_unscaled, "0");
  });

  it("B2 excludes event conflicts from snapshot and cohort values", async () => {
    const mutation = structuredClone(input);
    mutation.metric_evaluations[0] = {
      ...mutation.metric_evaluations[0],
      metric_run_id_prefix: "run-33-conflict",
      metric_names: ["cohort_ltv_d7_usd", "cohort_install_count"],
    };
    const source = mutation.records.find((record: Any) => record.record_id === "revenue-33-a");
    mutation.records.push(
      {
        ...structuredClone(source),
        record_id: "revenue-33-conflict-a",
        delivery_id: "delivery:revenue-33-conflict-a",
        event_id: "event:revenue-33-conflict",
        received_at: "2026-08-01T13:00:01.000Z",
        processing_sequence: 10,
        payload: { ...structuredClone(source.payload), amount_unscaled: "400000001" },
      },
      {
        ...structuredClone(source),
        record_id: "revenue-33-conflict-b",
        delivery_id: "delivery:revenue-33-conflict-b",
        event_id: "event:revenue-33-conflict",
        received_at: "2026-08-01T13:00:02.000Z",
        processing_sequence: 11,
        payload: { ...structuredClone(source.payload), amount_unscaled: "500000001" },
      },
    );
    await ingestFixture(fixtureName, mutation, appPool, seedPool);
    const expected = evaluate(mutation).metric_runs;
    const actual = await computeSqlMetricRuns(appPool, mutation, false);
    assert.equal(jcs(actual), jcs(expected));
  });

  it("B1 fixes snapshots by watermark and supersedes immutable runs when late input arrives", async () => {
    const mutation = structuredClone(input);
    const lateRevenue = structuredClone(
      mutation.records.find((record: Any) => record.record_id === "revenue-33-c"),
    );
    Object.assign(lateRevenue, {
      record_id: "revenue-33-late",
      delivery_id: "delivery:revenue-33-late",
      event_id: "event:revenue-33-late",
      received_at: "2026-08-09T00:00:00.001Z",
      processing_sequence: 12,
    });
    lateRevenue.payload.impression_id = "impression:revenue-33-late";
    mutation.records.push(lateRevenue);
    const baseEvaluation = {
      ...mutation.metric_evaluations[0],
      metric_run_id_prefix: "run-33-snapshot-before",
      metric_names: ["d7_roas"],
    };
    mutation.metric_evaluations = [
      baseEvaluation,
      { ...baseEvaluation, metric_run_id_prefix: "run-33-snapshot-repeat" },
      {
        ...baseEvaluation,
        metric_run_id_prefix: "run-33-snapshot-after",
        input_received_at_watermark: "2026-08-09T00:00:01.000Z",
        computed_at: "2026-08-09T00:02:00.000Z",
        supersedes_metric_run_id_prefix: "run-33-snapshot-before",
      },
    ];

    await ingestFixture(fixtureName, mutation, appPool, seedPool);
    const expected = evaluate(mutation).metric_runs;
    const actual = await computeSqlMetricRuns(appPool, mutation, false);
    assert.equal(jcs(actual), jcs(expected));
    const before = actual.find((run) => run.metric_run_id.startsWith("run-33-snapshot-before:"));
    const repeat = actual.find((run) => run.metric_run_id.startsWith("run-33-snapshot-repeat:"));
    const afterLate = actual.find((run) => run.metric_run_id.startsWith("run-33-snapshot-after:"));
    if (!before || !repeat || !afterLate) throw new Error("snapshot test metric runs are incomplete");
    assert.equal(repeat.input_snapshot_id, before.input_snapshot_id);
    assert.equal(repeat.value_unscaled, before.value_unscaled);
    assert.notEqual(afterLate.input_snapshot_id, before.input_snapshot_id);
    assert.notEqual(afterLate.value_unscaled, before.value_unscaled);
    assert.equal(afterLate.supersedes_metric_run_id, before.metric_run_id);

    const persistedInput = structuredClone(mutation);
    persistedInput.metric_evaluations = [
      persistedInput.metric_evaluations[0],
      persistedInput.metric_evaluations[2],
    ];
    const persisted = await computeSqlMetricRuns(appPool, persistedInput, true);
    const persistedBefore = persisted.find((run) => run.metric_run_id === before.metric_run_id);
    assert.ok(persistedBefore);

    const storedBefore = await withTenant(appPool, input.server_context.tenant_id, async (client) => {
      const result = await client.query<{ artifact: Any }>(
        "SELECT artifact FROM ledger.metric_runs WHERE metric_run_id=$1",
        [before.metric_run_id],
      );
      return result.rows[0].artifact;
    });
    assert.equal(sha256(storedBefore), sha256(persistedBefore), "supersession must not rewrite the old run");

    const firstSequence = await withTenant(appPool, input.server_context.tenant_id, async (client) =>
      (await client.query<{ value: string }>("SELECT max(ledger_seq)::text AS value FROM ledger.raw_records")).rows[0].value);
    const firstSnapshot = (await computeSqlMetricRuns(appPool, mutation, false))[0].input_snapshot_id;
    await ingestFixture(fixtureName, mutation, appPool, seedPool);
    const secondSequence = await withTenant(appPool, input.server_context.tenant_id, async (client) =>
      (await client.query<{ value: string }>("SELECT max(ledger_seq)::text AS value FROM ledger.raw_records")).rows[0].value);
    const secondSnapshot = (await computeSqlMetricRuns(appPool, mutation, false))[0].input_snapshot_id;
    assert.notEqual(firstSequence, secondSequence, "fixture reload must exercise different ledger sequence values");
    assert.equal(secondSnapshot, firstSnapshot, "ledger_seq must not participate in snapshot identity");
  });

  it("B6 recalculates after privacy redaction and preserves the superseded run", async () => {
    const mutation = structuredClone(input);
    const baseEvaluation = {
      ...mutation.metric_evaluations[0],
      metric_run_id_prefix: "run-33-redaction-before",
      metric_names: ["d7_roas", "cohort_ltv_d7_usd"],
      privacy_state: "before",
    };
    mutation.metric_evaluations = [
      baseEvaluation,
      {
        ...baseEvaluation,
        metric_run_id_prefix: "run-33-redaction-after",
        computed_at: "2026-08-09T00:03:00.000Z",
        data_freshness: "recalculated",
        privacy_state: "after",
        supersedes_metric_run_id_prefix: "run-33-redaction-before",
      },
    ];
    mutation.privacy_requests = [{
      contract_version: "0.2.1",
      tenant_id: input.server_context.tenant_id,
      app_id: input.server_context.app_id,
      privacy_request_id: "privacy:redaction-33",
      deletion_subject_digest: "3".repeat(64),
      deletion_scope: "installation",
      requested_via: "tenant_admin_api",
      requester_auth_ref: "admin_key:synthetic-redaction-33",
      requested_at: "2026-08-09T00:01:00.000Z",
      completed_at: "2026-08-09T00:02:00.000Z",
      status: "completed",
      reason_code: "privacy_deletion",
      policy_version: "privacy-v0.2.1",
      affected_records: [{ record_id: "revenue-33-c", lifecycle_status: "redacted" }],
    }];

    await ingestFixture(fixtureName, mutation, appPool, seedPool);
    const expected = evaluate(mutation).metric_runs;
    const actual = await computeSqlMetricRuns(appPool, mutation, true);
    assert.equal(jcs(actual), jcs(expected));
    const before = actual.filter((run) => run.metric_run_id.startsWith("run-33-redaction-before:"));
    const afterRedaction = actual.filter((run) => run.metric_run_id.startsWith("run-33-redaction-after:"));
    assert.equal(afterRedaction.length, before.length);
    for (const replacement of afterRedaction) {
      const prior = before.find((run) => run.metric_name === replacement.metric_name);
      assert.ok(prior);
      assert.equal(replacement.reproducibility_status, "redaction_affected");
      assert.equal(replacement.supersedes_metric_run_id, prior.metric_run_id);
      assert.notEqual(replacement.input_snapshot_id, prior.input_snapshot_id);
      assert.notEqual(replacement.value_unscaled, prior.value_unscaled);
      const stored = await withTenant(appPool, input.server_context.tenant_id, async (client) =>
        (await client.query<{ artifact: Any }>(
          "SELECT artifact FROM ledger.metric_runs WHERE metric_run_id=$1",
          [prior.metric_run_id],
        )).rows[0].artifact);
      assert.equal(sha256(stored), sha256(prior), "redaction recalculation must not rewrite the prior run");
    }
  });

  it("B8 persists undefined ROAS with an explicit reason", async () => {
    const undefinedFixture = "37-undefined-organic-roas";
    const undefinedInput: Any = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures", "v0.2", undefinedFixture, "input.json"),
      "utf8",
    ));
    await ingestFixture(fixtureName, undefinedInput, appPool, seedPool);
    const expected = evaluate(undefinedInput).metric_runs;
    const actual = await computeSqlMetricRuns(appPool, undefinedInput, true);
    assert.equal(jcs(actual), jcs(expected));
    assert.equal(actual[0].value_state, "undefined");
    assert.equal(actual[0].undefined_reason, "no_attributed_cost");
    assert.equal("value_unscaled" in actual[0], false);
    const stored = await withTenant(appPool, undefinedInput.server_context.tenant_id, async (client) =>
      (await client.query<{ value_state: string; undefined_reason: string; value_unscaled: string | null }>(
        `SELECT value_state, undefined_reason, value_unscaled
         FROM ledger.metric_runs WHERE metric_run_id=$1`,
        [actual[0].metric_run_id],
      )).rows[0]);
    assert.deepEqual(stored, {
      value_state: "undefined",
      undefined_reason: "no_attributed_cost",
      value_unscaled: null,
    });
  });
});
