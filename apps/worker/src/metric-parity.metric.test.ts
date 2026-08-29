import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { evaluate, jcs, roundHalfEven, sha256 } from "@openmasu/attribution-core";
import { createAppPool, createSeedPool, requireEnvironment, withTenant } from "@openmasu/runtime";
import { Client, type Pool } from "pg";
import { ingestFixture, ingestRuntimeBatch } from "./ingestion.js";
import { computeSqlMetricRuns, computeSqlMetricRunsWithClient } from "./metrics/cohort.js";

type Any = Record<string, any>;
const fixtureName = "33-stage-b-cohort-metrics";
const fixtureDirectory = join(process.cwd(), "fixtures", "v0.4", fixtureName);
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
         ORDER BY metric_run_id COLLATE "C"`,
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
    assert.equal(oracle.length, 8);
    assert.equal(sqlRuns.length, oracle.length);
    assert.equal(sqlRuns.length, golden.length);
    assert.equal(Buffer.compare(Buffer.from(jcs(oracle)), Buffer.from(jcs(golden))), 0);
    assert.equal(Buffer.compare(Buffer.from(jcs(sqlRuns)), Buffer.from(jcs(oracle))), 0);
    assert.equal(Buffer.compare(Buffer.from(jcs(persistedRuns)), Buffer.from(jcs(oracle))), 0);

    const organicRoas = sqlRuns.find((run) => run.metric_run_id === "run-33-organic:d1_roas");
    assert.equal(organicRoas?.value_state, "undefined");
    assert.equal(organicRoas?.undefined_reason, "no_attributed_cost");
    assert.equal("value_unscaled" in (organicRoas ?? {}), false);
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
        "OPENMASU_MIGRATION_DATABASE_URL",
        process.env.OPENMASU_MIGRATION_DATABASE_URL,
      ),
    });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE openmasu_owner");
      await client.query("SELECT set_config('openmasu.tenant_id', $1, true)", [input.server_context.tenant_id]);
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
    const cohortSize = actual.find((run) =>
      run.metric_run_id === "run-33-late-install:cohort_install_count");
    assert.equal(cohortSize?.value_unscaled, "0");
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
      contract_version: "0.4.0",
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
      join(process.cwd(), "fixtures", "v0.4", undefinedFixture, "input.json"),
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

  it("C13 reproduces reviewed daily click and install runs without ledger sequence input", async () => {
    const dailyFixture = "42-daily-metric-date";
    const dailyDirectory = join(process.cwd(), "fixtures", "v0.4", dailyFixture);
    const dailyInput: Any = JSON.parse(readFileSync(join(dailyDirectory, "input.json"), "utf8"));
    const dailyGolden: Any[] = JSON.parse(readFileSync(
      join(dailyDirectory, "expected_metric_runs.json"),
      "utf8",
    ));
    await ingestFixture(dailyFixture, dailyInput, appPool, seedPool);
    const expected = evaluate(dailyInput).metric_runs;
    const first = await computeSqlMetricRuns(appPool, dailyInput, false);
    const firstSequence = await withTenant(appPool, dailyInput.server_context.tenant_id, async (client) =>
      (await client.query<{ value: string }>("SELECT max(ledger_seq)::text AS value FROM ledger.raw_records")).rows[0].value);
    assert.equal(jcs(expected), jcs(dailyGolden));
    assert.equal(jcs(first), jcs(expected));
    assert.equal(first.find((run) => run.metric_name === "daily_click_count")?.value_unscaled, "1");
    assert.equal(first.find((run) => run.metric_name === "daily_install_count")?.value_unscaled, "1");

    await ingestFixture(dailyFixture, dailyInput, appPool, seedPool);
    const secondSequence = await withTenant(appPool, dailyInput.server_context.tenant_id, async (client) =>
      (await client.query<{ value: string }>("SELECT max(ledger_seq)::text AS value FROM ledger.raw_records")).rows[0].value);
    const second = await computeSqlMetricRuns(appPool, dailyInput, false);
    assert.notEqual(secondSequence, firstSequence);
    assert.equal(jcs(second), jcs(first));
    assert.deepEqual(
      second.map((run) => [run.input_snapshot_id, run.grouping.dimension_digest]),
      first.map((run) => [run.input_snapshot_id, run.grouping.dimension_digest]),
    );
  });

  it("C13 applies the UTC calendar day as a lower-inclusive, upper-exclusive window", async () => {
    const dailyFixture = "42-daily-metric-date-boundary";
    const source: Any = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures", "v0.4", "42-daily-metric-date", "input.json"),
      "utf8",
    ));
    const click = source.records.find((record: Any) => record.event_name === "click");
    const variants = [
      ["lower", "2026-08-20T00:00:00.000Z"],
      ["last", "2026-08-20T23:59:59.999Z"],
      ["upper", "2026-08-21T00:00:00.000Z"],
    ].map(([label, timestamp], index) => ({
      ...structuredClone(click),
      record_id: `click-42-${label}`,
      delivery_id: `delivery:click-42-${label}`,
      event_id: `event:click-42-${label}`,
      occurred_at: timestamp,
      received_at: "2026-08-21T00:00:00.000Z",
      processing_sequence: 10 + index,
      payload: {
        ...structuredClone(click.payload),
        click_id: `click-42-${label}_0000000000000000`,
        redirector_click_at: timestamp,
      },
    }));
    source.records.push(...variants);
    source.metric_evaluations = [{
      ...source.metric_evaluations[0],
      metric_run_id_prefix: "run-42-boundary",
    }];
    await ingestFixture(dailyFixture, source, appPool, seedPool);
    const expected = evaluate(source).metric_runs;
    const actual = await computeSqlMetricRuns(appPool, source, false);
    assert.equal(jcs(actual), jcs(expected));
    assert.equal(actual[0].value_unscaled, "3");
  });

  it("C13 separates and sums organic, non-organic, and unattributed installs", async () => {
    const fixture = "42-daily-attribution-status";
    const daily: Any = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures", "v0.4", "42-daily-metric-date", "input.json"),
      "utf8",
    ));
    const paid: Any = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures", "v0.4", "01-valid-install-referrer", "input.json"),
      "utf8",
    ));
    const unknown: Any = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures", "v0.4", "03-unknown-click", "input.json"),
      "utf8",
    ));
    const paidClick = structuredClone(paid.records.find((record: Any) => record.event_name === "click"));
    Object.assign(paidClick, {
      record_id: "click-42-paid",
      delivery_id: "delivery:click-42-paid",
      event_id: "event:click-42-paid",
      occurred_at: "2026-08-20T01:00:00.000Z",
      received_at: "2026-08-20T01:00:01.000Z",
      processing_sequence: 20,
    });
    Object.assign(paidClick.payload, {
      click_id: "click-42-paid_0000000000000000",
      redirector_click_at: "2026-08-20T01:00:00.000Z",
    });
    const paidInstall = structuredClone(paid.records.find((record: Any) => record.event_name === "install"));
    Object.assign(paidInstall, {
      record_id: "install-42-paid",
      delivery_id: "delivery:install-42-paid",
      event_id: "event:install-42-paid",
      occurred_at: "2026-08-20T02:00:00.000Z",
      received_at: "2026-08-20T02:00:01.000Z",
      processing_sequence: 21,
    });
    Object.assign(paidInstall.payload, {
      installation_id: "installation:install-42-paid",
      click_id: "click-42-paid_0000000000000000",
      install_begin_at_server: "2026-08-20T02:00:00.000Z",
      protected_referrer_evidence_ref: "protected:referrer:install-42-paid",
    });
    const unknownInstall = structuredClone(unknown.records[0]);
    Object.assign(unknownInstall, {
      record_id: "install-42-unknown",
      delivery_id: "delivery:install-42-unknown",
      event_id: "event:install-42-unknown",
      occurred_at: "2026-08-20T03:00:00.000Z",
      received_at: "2026-08-20T03:00:01.000Z",
      processing_sequence: 22,
    });
    Object.assign(unknownInstall.payload, {
      installation_id: "installation:install-42-unknown",
      click_id: "unknown-click-42_0000000000000000",
      install_begin_at_server: "2026-08-20T03:00:00.000Z",
      protected_referrer_evidence_ref: "protected:referrer:install-42-unknown",
    });
    daily.records.push(paidClick, paidInstall, unknownInstall);
    const baseEvaluation = {
      ...daily.metric_evaluations[1],
      metric_run_id_prefix: "run-42-install-all",
      grouping: { metric_date: "2026-08-20" },
    };
    daily.metric_evaluations = [
      baseEvaluation,
      ...(["organic", "non_organic", "unattributed"] as const).map((status) => ({
        ...baseEvaluation,
        metric_run_id_prefix: `run-42-install-${status}`,
        grouping: { metric_date: "2026-08-20", attribution_status: status },
      })),
    ];
    await ingestFixture(fixture, daily, appPool, seedPool);
    const expected = evaluate(daily).metric_runs;
    const actual = await computeSqlMetricRuns(appPool, daily, false);
    assert.equal(jcs(actual), jcs(expected));
    const value = (prefix: string): bigint => BigInt(actual.find((run) =>
      run.metric_run_id === `${prefix}:daily_install_count`)?.value_unscaled ?? "-1");
    const total = value("run-42-install-all");
    const parts = value("run-42-install-organic")
      + value("run-42-install-non_organic")
      + value("run-42-install-unattributed");
    assert.equal(total, 3n);
    assert.equal(parts, total);
  });

  it("DL-A-23 and DL-A-24 keep engagement attribution and daily deep-link metrics JCS-identical", async () => {
    const deepFixture = "54-deep-link-open-contract";
    const deepDirectory = join(process.cwd(), "fixtures", "v0.4", deepFixture);
    const deepInput: Any = JSON.parse(readFileSync(join(deepDirectory, "input.json"), "utf8"));
    const deepGolden: Any[] = JSON.parse(readFileSync(join(deepDirectory, "expected_metric_runs.json"), "utf8"));
    await ingestFixture(deepFixture, deepInput, appPool, seedPool);
    const expected = evaluate(deepInput).metric_runs;
    const actual = await computeSqlMetricRuns(appPool, deepInput, false);
    assert.equal(jcs(expected), jcs(deepGolden));
    assert.equal(jcs(actual), jcs(expected));
    assert.deepEqual(actual.map((run) => [run.metric_name, run.value_unscaled]), [
      ["daily_deep_link_opens", "1"],
      ["daily_deep_link_opens_by_status", "1"],
    ]);
    const reasons = evaluate(deepInput).attributions.map((item: Any) => item.reason_code).sort();
    assert.deepEqual(reasons, [
      "deep_link_install_click_reused",
      "deep_link_link_inactive",
      "deep_link_open_attributed",
      "deep_link_unknown_link",
    ]);
  });

  it("M4 reproduces qualified Apple aggregate counts and receipt-date buckets", async () => {
    const appleFixture = "44-apple-aggregate-metrics";
    const appleDirectory = join(process.cwd(), "fixtures", "v0.4", appleFixture);
    const appleInput: Any = JSON.parse(readFileSync(join(appleDirectory, "input.json"), "utf8"));
    const appleGolden: Any[] = JSON.parse(readFileSync(
      join(appleDirectory, "expected_metric_runs.json"),
      "utf8",
    ));
    await ingestFixture(appleFixture, appleInput, appPool, seedPool);
    const appleFacts = await withTenant(appPool, appleInput.server_context.tenant_id, async (client) => {
      const result = await client.query<{
        event_name: string;
        signature_verified: boolean;
        did_win: boolean;
        source_identifier_present: boolean;
        conversion_bucket: string | null;
      }>(
        `SELECT event_name, signature_verified, did_win, source_identifier_present, conversion_bucket
         FROM ledger.apple_postback_facts
         WHERE tenant_id=$1 AND app_id=$2
         ORDER BY logical_event_id COLLATE "C"`,
        [appleInput.server_context.tenant_id, appleInput.server_context.app_id],
      );
      return result.rows;
    });
    assert.equal(appleFacts.length, appleInput.records.length);
    assert.ok(appleFacts.every((fact) => fact.signature_verified && fact.did_win && fact.source_identifier_present));
    assert.ok(appleFacts.every((fact) => fact.conversion_bucket !== null));
    const expected = evaluate(appleInput).metric_runs;
    const actual = await computeSqlMetricRuns(appPool, appleInput, false);
    assert.equal(jcs(expected), jcs(appleGolden));
    assert.equal(jcs(actual), jcs(expected));
    assert.equal(actual.find((run) => run.metric_name === "skan_attributed_installs")?.value_unscaled, "2");
    assert.equal(actual.find((run) => run.metric_name === "aak_attributed_installs")?.value_unscaled, "1");
    assert.equal(actual.find((run) =>
      run.metric_run_id === "run-44-skan-fine-21:skan_conversion_value_distribution")?.value_unscaled, "1");

    await withTenant(appPool, appleInput.server_context.tenant_id, async (client) => {
      await client.query(
        `INSERT INTO ledger.attribution_results (
           attribution_id, tenant_id, app_id, subject_scope, subject_ref,
           effective_at, decided_at, status, method, model, reason_code, artifact
         )
         SELECT attribution_id || ':future', tenant_id, app_id, subject_scope, subject_ref,
           effective_at, '2026-08-22T00:00:00.000Z', 'organic', method, model, reason_code,
           artifact || jsonb_build_object(
             'attribution_id', attribution_id || ':future',
             'decided_at', '2026-08-22T00:00:00.000Z',
             'status', 'organic'
           )
         FROM ledger.attribution_results
         WHERE tenant_id=$1 AND app_id=$2 AND subject_scope='aggregate'
         ORDER BY attribution_id COLLATE "C" LIMIT 1`,
        [appleInput.server_context.tenant_id, appleInput.server_context.app_id],
      );
    });
    const fixedWatermarkActual = await computeSqlMetricRuns(appPool, appleInput, false);
    assert.equal(fixedWatermarkActual.find((run) =>
      run.metric_name === "skan_attributed_installs")?.value_unscaled, "2",
    "an attribution decided after the fixed watermark changed a historical aggregate metric");

    const receiptAuthority = structuredClone(appleInput);
    receiptAuthority.records.find((record: Any) => record.record_id === "skan-fine-44").occurred_at =
      "2026-08-19T01:00:00.000Z";
    await ingestFixture("44-apple-receipt-authority", receiptAuthority, appPool, seedPool);
    const receiptExpected = evaluate(receiptAuthority).metric_runs;
    const receiptActual = await computeSqlMetricRuns(appPool, receiptAuthority, false);
    assert.equal(jcs(receiptActual), jcs(receiptExpected));
    assert.equal(receiptActual.find((run) => run.metric_name === "skan_attributed_installs")?.value_unscaled, "2");

    for (const mutation of [
      { name: "signature", apply: (payload: Any) => { payload.signature_verified = false; } },
      { name: "winner", apply: (payload: Any) => { payload.did_win = false; } },
      { name: "source", apply: (payload: Any) => { delete payload.source_identifier; } },
      {
        name: "conversion",
        apply: (payload: Any) => {
          delete payload.conversion_value;
          delete payload.coarse_conversion_value;
        },
      },
    ]) {
      const disqualified = structuredClone(appleInput);
      mutation.apply(disqualified.records.find((record: Any) => record.record_id === "skan-fine-44").payload);
      await ingestFixture(`44-apple-disqualified-${mutation.name}`, disqualified, appPool, seedPool);
      const disqualifiedExpected = evaluate(disqualified).metric_runs;
      const disqualifiedActual = await computeSqlMetricRuns(appPool, disqualified, false);
      assert.equal(jcs(disqualifiedActual), jcs(disqualifiedExpected));
      assert.equal(disqualifiedActual.find((run) =>
        run.metric_name === "skan_attributed_installs")?.value_unscaled, "1");
    }
  });

  it("keeps AdAttributionKit re-engagement separate from aggregate installs", async () => {
    const fixture = "57-aak-reengagement-current-spec";
    const directory = join(process.cwd(), "fixtures", "v0.4", fixture);
    const currentInput: Any = JSON.parse(readFileSync(join(directory, "input.json"), "utf8"));
    const currentGolden: Any[] = JSON.parse(readFileSync(
      join(directory, "expected_metric_runs.json"),
      "utf8",
    ));
    await ingestFixture(fixture, currentInput, appPool, seedPool);
    const facts = await withTenant(appPool, currentInput.server_context.tenant_id, async (client) => {
      const result = await client.query<{ conversion_type: string | null }>(
        `SELECT conversion_type FROM ledger.apple_postback_facts
         WHERE tenant_id=$1 AND app_id=$2
         ORDER BY conversion_type COLLATE "C"`,
        [currentInput.server_context.tenant_id, currentInput.server_context.app_id],
      );
      return result.rows;
    });
    assert.deepEqual(facts, [
      { conversion_type: "download" },
      { conversion_type: "re-engagement" },
    ]);
    const expected = evaluate(currentInput).metric_runs;
    const actual = await computeSqlMetricRuns(appPool, currentInput, false);
    assert.equal(jcs(expected), jcs(currentGolden));
    assert.equal(jcs(actual), jcs(expected));
    assert.equal(actual.find((run) => run.metric_name === "aak_attributed_installs")?.value_unscaled, "1");
    assert.equal(actual.find((run) =>
      run.metric_name === "aak_attributed_reengagements")?.value_unscaled, "1");
  });

  it("keeps ad revenue unchanged while SQL and evaluators agree on settled purchase/refund net revenue", async () => {
    const commerceFixture = "55-purchase-refund-net-revenue";
    const commerceInput: Any = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures", "v0.4", commerceFixture, "input.json"),
      "utf8",
    ));
    await ingestFixture(commerceFixture, commerceInput, appPool, seedPool);
    const expected = evaluate(commerceInput).metric_runs;
    const actual = await computeSqlMetricRuns(appPool, commerceInput, false);
    assert.equal(jcs(actual), jcs(expected));
    assert.equal(actual.find((run) => run.metric_name === "d0_install_to_24h_ad_revenue_usd")?.value_unscaled,
      "7000000", "purchase/refund facts changed the existing ad-revenue metric");
    assert.deepEqual(
      actual.filter((run) => run.metric_name.startsWith("cohort_purchase_net_revenue_"))
        .map((run) => [run.metric_name, run.value_unscaled]),
      [
        ["cohort_purchase_net_revenue_d0_usd", "10000000"],
        ["cohort_purchase_net_revenue_d1_usd", "6000000"],
        ["cohort_purchase_net_revenue_d3_usd", "6000000"],
        ["cohort_purchase_net_revenue_d7_usd", "6000000"],
      ],
    );
    const facts = await withTenant(appPool, commerceInput.server_context.tenant_id, async (client) => ({
      purchaseStatuses: (await client.query<{ financial_status: string; count: string }>(
        `SELECT financial_status, count(*)::text AS count FROM ledger.purchase_facts
          WHERE tenant_id=$1 AND app_id=$2 GROUP BY financial_status ORDER BY financial_status`,
        [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id],
      )).rows,
      refunds: (await client.query<{
        transaction_id: string; correction_target_record_id: string; financial_status: string;
      }>(
        `SELECT transaction_id, correction_target_record_id, financial_status FROM ledger.refund_facts
          WHERE tenant_id=$1 AND app_id=$2 ORDER BY transaction_id`,
        [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id],
      )).rows,
    }));
    assert.ok(facts.purchaseStatuses.some((row) => row.financial_status === "pending"));
    assert.ok(facts.purchaseStatuses.some((row) => row.financial_status === "reversed"));
    assert.ok(facts.purchaseStatuses.some((row) => row.financial_status === "settled"));
    assert.ok(facts.refunds.every((row) => row.correction_target_record_id.length > 0));

    for (const [field, value] of [
      ["rule_bundle_id", "metric-purchase-other"],
      ["rule_bundle_version", "0.4.7"],
      ["rule_bundle_hash", "7".repeat(64)],
    ] as const) {
      const wrongProvenance = structuredClone(commerceInput);
      wrongProvenance.metric_definitions.find((definition: Any) =>
        definition.metric_name === "cohort_purchase_net_revenue_d0_usd")[field] = value;
      await assert.rejects(
        () => computeSqlMetricRuns(appPool, wrongProvenance, false),
        /metric_definition_series_mismatch:cohort_purchase_net_revenue_d0_usd/,
        `SQL metric path accepted wrong purchase-net ${field}`,
      );
    }

    const overLimit = structuredClone(commerceInput);
    overLimit.metric_evaluations = [{
      ...overLimit.metric_evaluations[0],
      metric_run_id_prefix: "run-55-over-limit",
    }];
    const refund = overLimit.records.find((record: Any) => record.record_id === "refund-55-d0");
    overLimit.records.push({
      ...structuredClone(refund),
      record_id: "refund-55-d2-cap-fill",
      delivery_id: "delivery:refund-55-d2-cap-fill",
      event_id: "event:refund-55-d2-cap-fill",
      occurred_at: "2026-08-03T01:00:00.000Z",
      received_at: "2026-08-03T01:00:01.000Z",
      processing_sequence: 12,
      payload: {
        ...structuredClone(refund.payload),
        transaction_id: "refund-transaction-55-d2-cap-fill",
        amount_unscaled: "4800000",
      },
    }, {
      ...structuredClone(refund),
      record_id: "refund-55-cumulative-over-limit",
      delivery_id: "delivery:refund-55-cumulative-over-limit",
      event_id: "event:refund-55-cumulative-over-limit",
      occurred_at: "2026-08-01T11:00:00.000Z",
      received_at: "2026-08-03T02:00:01.000Z",
      processing_sequence: 13,
      payload: {
        ...structuredClone(refund.payload),
        transaction_id: "refund-transaction-55-cumulative-over-limit",
        amount_unscaled: "4800000",
      },
    });
    const overLimitOutput = evaluate(overLimit);
    assert.ok(overLimitOutput.deliveries.some((delivery) =>
      delivery.record_id === "refund-55-d2-cap-fill"
      && delivery.ingestion_status === "accepted"));
    assert.ok(overLimitOutput.deliveries.some((delivery) =>
      delivery.record_id === "refund-55-cumulative-over-limit"
      && delivery.ingestion_status === "rejected"
      && delivery.reason_code === "refund_target_invalid"));
    await ingestFixture("55-purchase-refund-over-limit", overLimit, appPool, seedPool);
    const overLimitActual = await computeSqlMetricRuns(appPool, overLimit, false);
    assert.equal(jcs(overLimitActual), jcs(overLimitOutput.metric_runs));
    assert.deepEqual(
      overLimitActual.filter((run) => run.metric_name.startsWith("cohort_purchase_net_revenue_"))
        .map((run) => [run.metric_name, run.value_unscaled]),
      [
        ["cohort_purchase_net_revenue_d0_usd", "10000000"],
        ["cohort_purchase_net_revenue_d1_usd", "6000000"],
        ["cohort_purchase_net_revenue_d3_usd", "0"],
        ["cohort_purchase_net_revenue_d7_usd", "0"],
      ],
      "SQL must preserve receipt-order cap semantics rather than reordering by occurrence time",
    );
    assert.equal((await withTenant(appPool, commerceInput.server_context.tenant_id, (client) => client.query(
      `SELECT logical_event_id FROM ledger.refund_facts
        WHERE tenant_id=$1 AND app_id=$2 AND transaction_id=$3`,
      [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id,
        "refund-transaction-55-d2-cap-fill"],
    ))).rowCount, 1, "receipt-order in-cap refund must reach the fact projection");
    assert.equal((await withTenant(appPool, commerceInput.server_context.tenant_id, (client) => client.query(
      `SELECT logical_event_id FROM ledger.refund_facts
        WHERE tenant_id=$1 AND app_id=$2 AND transaction_id=$3`,
      [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id,
        "refund-transaction-55-cumulative-over-limit"],
    ))).rowCount, 0, "over-limit refund must not reach the fact projection");

    const businessConflict = structuredClone(commerceInput);
    businessConflict.metric_evaluations = [{
      ...businessConflict.metric_evaluations[0], metric_run_id_prefix: "run-55-business-conflict",
    }];
    const purchase = businessConflict.records.find((record: Any) => record.record_id === "purchase-55-d0");
    businessConflict.records.push({
      ...structuredClone(purchase), record_id: "purchase-55-business-conflict",
      delivery_id: "delivery:purchase-55-business-conflict", event_id: "event:purchase-55-business-conflict",
      received_at: "2026-08-01T10:00:02.000Z", processing_sequence: 12,
      payload: { ...structuredClone(purchase.payload), amount_unscaled: "8000001" },
    });
    const businessOutput = evaluate(businessConflict);
    assert.ok(businessOutput.deliveries.some((delivery) =>
      delivery.record_id === "purchase-55-d0" && delivery.ingestion_status === "accepted"));
    assert.ok(businessOutput.deliveries.some((delivery) =>
      delivery.record_id === "purchase-55-business-conflict" && delivery.reason_code === "event_id_conflict"));
    await ingestFixture("55-purchase-business-conflict", businessConflict, appPool, seedPool);
    const businessActual = await computeSqlMetricRuns(appPool, businessConflict, false);
    assert.equal(jcs(businessActual), jcs(businessOutput.metric_runs));
    assert.deepEqual(
      businessActual.filter((run) => run.metric_name.startsWith("cohort_purchase_net_revenue_"))
        .map((run) => run.value_unscaled),
      ["10000000", "6000000", "6000000", "6000000"],
      "later business conflict changed purchase-net SQL metrics",
    );
    assert.equal((await withTenant(appPool, commerceInput.server_context.tenant_id, (client) => client.query(
      `SELECT count(*)::int AS count FROM ledger.purchase_facts
        WHERE tenant_id=$1 AND app_id=$2 AND transaction_id='transaction-55-d0'`,
      [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id],
    ))).rows[0].count, 1, "later business conflict created a second purchase fact");

    const refundAdmission = structuredClone(commerceInput);
    refundAdmission.metric_evaluations = [{
      ...refundAdmission.metric_evaluations[0], metric_run_id_prefix: "run-55-refund-admission",
    }];
    const refundTemplate = refundAdmission.records.find((record: Any) => record.record_id === "refund-55-d0");
    refundAdmission.records.push({
      ...structuredClone(refundTemplate),
      record_id: "refund-55-invalid-first",
      delivery_id: "delivery:refund-55-invalid-first",
      event_id: "event:refund-55-invalid-first",
      occurred_at: "2026-08-03T01:00:00.000Z",
      received_at: "2026-08-03T01:00:01.000Z",
      processing_sequence: 12,
      payload: {
        ...structuredClone(refundTemplate.payload),
        transaction_id: "refund-transaction-55-admission",
        amount_unscaled: "6000000",
      },
    }, {
      ...structuredClone(refundTemplate),
      record_id: "refund-55-valid-after-invalid",
      delivery_id: "delivery:refund-55-valid-after-invalid",
      event_id: "event:refund-55-valid-after-invalid",
      occurred_at: "2026-08-03T02:00:00.000Z",
      received_at: "2026-08-03T02:00:01.000Z",
      processing_sequence: 13,
      payload: {
        ...structuredClone(refundTemplate.payload),
        transaction_id: "refund-transaction-55-admission",
        amount_unscaled: "1000000",
      },
    });
    const refundAdmissionOutput = evaluate(refundAdmission);
    assert.ok(refundAdmissionOutput.deliveries.some((delivery) =>
      delivery.record_id === "refund-55-invalid-first"
      && delivery.reason_code === "refund_target_invalid"));
    assert.ok(refundAdmissionOutput.deliveries.some((delivery) =>
      delivery.record_id === "refund-55-valid-after-invalid"
      && delivery.ingestion_status === "accepted"));
    await ingestFixture("55-refund-fully-admissible-business", refundAdmission, appPool, seedPool);
    const refundAdmissionActual = await computeSqlMetricRuns(appPool, refundAdmission, false);
    assert.equal(jcs(refundAdmissionActual), jcs(refundAdmissionOutput.metric_runs));
    assert.deepEqual(
      refundAdmissionActual.filter((run) => run.metric_name.startsWith("cohort_purchase_net_revenue_"))
        .map((run) => run.value_unscaled),
      ["10000000", "6000000", "4750000", "4750000"],
    );
    assert.equal((await withTenant(appPool, commerceInput.server_context.tenant_id, (client) => client.query(
      `SELECT logical_event_id FROM ledger.refund_facts
        WHERE tenant_id=$1 AND app_id=$2 AND transaction_id=$3`,
      [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id,
        "refund-transaction-55-admission"],
    ))).rowCount, 1, "only the fully admissible refund may reserve and project the transaction");

    const explicitFutureSql = structuredClone(commerceInput);
    explicitFutureSql.metric_evaluations = [{
      ...explicitFutureSql.metric_evaluations[0], metric_run_id_prefix: "run-55-explicit-future-sql",
    }];
    const explicitFutureSqlPurchase = explicitFutureSql.records.find((record: Any) =>
      record.record_id === "purchase-55-d0");
    const explicitFutureSqlRefund = explicitFutureSql.records.find((record: Any) =>
      record.record_id === "refund-55-d0");
    explicitFutureSqlRefund.payload.correction_target_record_id = explicitFutureSqlPurchase.record_id;
    explicitFutureSql.records.push({
      ...structuredClone(explicitFutureSqlPurchase),
      record_id: "purchase-55-explicit-future-sql",
      delivery_id: "delivery:purchase-55-explicit-future-sql",
      event_id: "event:purchase-55-explicit-future-sql",
      occurred_at: "2026-08-01T12:00:00.000Z",
      received_at: "2026-08-03T00:00:00.000Z",
      processing_sequence: 12,
      payload: {
        ...structuredClone(explicitFutureSqlPurchase.payload),
        transaction_id: "transaction-55-explicit-future-sql",
      },
    });
    const explicitFutureSqlOutput = evaluate(explicitFutureSql);
    assert.ok(explicitFutureSqlOutput.deliveries.some((delivery) =>
      delivery.record_id === explicitFutureSqlRefund.record_id
      && delivery.ingestion_status === "accepted"));
    await ingestFixture("55-explicit-future-received-sql", explicitFutureSql, appPool, seedPool);
    assert.equal(jcs(await computeSqlMetricRuns(appPool, explicitFutureSql, false)),
      jcs(explicitFutureSqlOutput.metric_runs));
    assert.deepEqual((await withTenant(
      appPool,
      commerceInput.server_context.tenant_id,
      (client) => client.query<{ correction_target_record_id: string }>(
        `SELECT correction_target_record_id FROM ledger.refund_facts
          WHERE tenant_id=$1 AND app_id=$2 AND transaction_id=$3`,
        [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id,
          explicitFutureSqlRefund.payload.transaction_id],
      ),
    )).rows, [{ correction_target_record_id: explicitFutureSqlPurchase.record_id }],
    "SQL projection must exclude a future-received candidate before checking the explicit record ID");

    const explicitFutureTargetSql = structuredClone(explicitFutureSql);
    explicitFutureTargetSql.metric_evaluations = [{
      ...explicitFutureTargetSql.metric_evaluations[0],
      metric_run_id_prefix: "run-55-explicit-future-target-sql",
    }];
    const explicitFutureTargetSqlRefund = explicitFutureTargetSql.records.find((record: Any) =>
      record.record_id === "refund-55-d0");
    explicitFutureTargetSqlRefund.payload.correction_target_record_id =
      "purchase-55-explicit-future-sql";
    const explicitFutureTargetSqlOutput = evaluate(explicitFutureTargetSql);
    assert.ok(explicitFutureTargetSqlOutput.deliveries.some((delivery) =>
      delivery.record_id === explicitFutureTargetSqlRefund.record_id
      && delivery.reason_code === "refund_target_invalid"));
    await ingestFixture(
      "55-explicit-future-target-sql", explicitFutureTargetSql, appPool, seedPool,
    );
    assert.equal(jcs(await computeSqlMetricRuns(appPool, explicitFutureTargetSql, false)),
      jcs(explicitFutureTargetSqlOutput.metric_runs));
    assert.equal((await withTenant(
      appPool,
      commerceInput.server_context.tenant_id,
      (client) => client.query(
        `SELECT logical_event_id FROM ledger.refund_facts
          WHERE tenant_id=$1 AND app_id=$2 AND transaction_id=$3`,
        [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id,
          explicitFutureTargetSqlRefund.payload.transaction_id],
      ),
    )).rowCount, 0,
    "SQL projection must reject an explicit target whose receipt follows the refund");

    const explicitAmbiguousSql = structuredClone(commerceInput);
    explicitAmbiguousSql.metric_evaluations = [{
      ...explicitAmbiguousSql.metric_evaluations[0], metric_run_id_prefix: "run-55-explicit-ambiguous-sql",
    }];
    const explicitAmbiguousSqlPurchase = explicitAmbiguousSql.records.find((record: Any) =>
      record.record_id === "purchase-55-d0");
    const explicitAmbiguousSqlRefund = explicitAmbiguousSql.records.find((record: Any) =>
      record.record_id === "refund-55-d0");
    explicitAmbiguousSqlRefund.payload.correction_target_record_id = explicitAmbiguousSqlPurchase.record_id;
    explicitAmbiguousSql.records.push({
      ...structuredClone(explicitAmbiguousSqlPurchase),
      record_id: "purchase-55-explicit-ambiguous-sql",
      delivery_id: "delivery:purchase-55-explicit-ambiguous-sql",
      event_id: "event:purchase-55-explicit-ambiguous-sql",
      received_at: "2026-08-01T10:00:02.000Z",
      processing_sequence: 12,
      payload: {
        ...structuredClone(explicitAmbiguousSqlPurchase.payload),
        transaction_id: "transaction-55-explicit-ambiguous-sql",
      },
    });
    const explicitAmbiguousSqlOutput = evaluate(explicitAmbiguousSql);
    assert.ok(explicitAmbiguousSqlOutput.deliveries.some((delivery) =>
      delivery.record_id === explicitAmbiguousSqlRefund.record_id
      && delivery.reason_code === "refund_target_invalid"));
    await ingestFixture("55-explicit-ambiguous-sql", explicitAmbiguousSql, appPool, seedPool);
    assert.equal(jcs(await computeSqlMetricRuns(appPool, explicitAmbiguousSql, false)),
      jcs(explicitAmbiguousSqlOutput.metric_runs));
    assert.equal((await withTenant(
      appPool,
      commerceInput.server_context.tenant_id,
      (client) => client.query(
        `SELECT logical_event_id FROM ledger.refund_facts
          WHERE tenant_id=$1 AND app_id=$2 AND transaction_id=$3`,
        [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id,
          explicitAmbiguousSqlRefund.payload.transaction_id],
      ),
    )).rowCount, 0,
    "an explicit record ID must not bypass strict SQL target ambiguity");

    await ingestFixture("55-runtime-refund-admission-base", commerceInput, appPool, seedPool);
    const runtimeInvalidRefund = {
      ...structuredClone(refundTemplate),
      record_id: "refund-55-runtime-invalid-first",
      delivery_id: "delivery:refund-55-runtime-invalid-first",
      event_id: "event:refund-55-runtime-invalid-first",
      occurred_at: "2026-08-03T01:00:00.000Z",
      received_at: "2026-08-03T01:00:01.000Z",
      payload: {
        ...structuredClone(refundTemplate.payload),
        transaction_id: "refund-transaction-55-runtime-admission",
        amount_unscaled: "6000000",
      },
    };
    const runtimeValidRefund = {
      ...structuredClone(runtimeInvalidRefund),
      record_id: "refund-55-runtime-valid-after-invalid",
      delivery_id: "delivery:refund-55-runtime-valid-after-invalid",
      event_id: "event:refund-55-runtime-valid-after-invalid",
      occurred_at: "2026-08-03T02:00:00.000Z",
      received_at: "2026-08-03T02:00:01.000Z",
      payload: {
        ...structuredClone(runtimeInvalidRefund.payload),
        amount_unscaled: "1000000",
      },
    };
    const runtimeAdmission = await ingestRuntimeBatch(
      [runtimeValidRefund, runtimeInvalidRefund].map((record) => ({
        server: commerceInput.server_context, record, batch_id: "runtime-refund-admission",
      })),
      appPool,
      commerceInput.records.map((record: Any) => ({
        server: commerceInput.server_context, record, batch_id: "runtime-refund-history",
      })),
    );
    assert.ok(runtimeAdmission.rejections.some((rejection) =>
      rejection.record_id === runtimeInvalidRefund.record_id
      && rejection.reason_code === "refund_target_invalid"));
    assert.ok(runtimeAdmission.logical_events.some((logical) =>
      logical.record_id === runtimeValidRefund.record_id));
    assert.equal((await withTenant(appPool, commerceInput.server_context.tenant_id, (client) => client.query(
      `SELECT logical_event_id FROM ledger.refund_facts
        WHERE tenant_id=$1 AND app_id=$2 AND transaction_id=$3`,
      [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id,
        runtimeValidRefund.payload.transaction_id],
    ))).rowCount, 1, "runtime persistence must project only the later fully admissible payload");

    const runtimeTargetPurchase = commerceInput.records.find((record: Any) =>
      record.record_id === "purchase-55-d0");
    const runtimeFuturePurchase = {
      ...structuredClone(runtimeTargetPurchase),
      record_id: "purchase-55-runtime-future-received",
      delivery_id: "delivery:purchase-55-runtime-future-received",
      event_id: "event:purchase-55-runtime-future-received",
      occurred_at: "2026-08-01T12:00:00.000Z",
      received_at: "2026-08-03T00:00:00.000Z",
      payload: {
        ...structuredClone(runtimeTargetPurchase.payload),
        transaction_id: "transaction-55-runtime-future-received",
      },
    };
    const runtimeFuturePurchaseResult = await ingestRuntimeBatch(
      [{ server: commerceInput.server_context, record: runtimeFuturePurchase,
        batch_id: "runtime-future-purchase" }],
      appPool,
      commerceInput.records.map((record: Any) => ({
        server: commerceInput.server_context, record, batch_id: "runtime-future-purchase-history",
      })),
    );
    assert.ok(runtimeFuturePurchaseResult.logical_events.some((logical) =>
      logical.record_id === runtimeFuturePurchase.record_id));

    const runtimeExplicitFutureRefund = {
      ...structuredClone(refundTemplate),
      record_id: "refund-55-runtime-explicit-future",
      delivery_id: "delivery:refund-55-runtime-explicit-future",
      event_id: "event:refund-55-runtime-explicit-future",
      occurred_at: "2026-08-02T11:00:00.000Z",
      received_at: "2026-08-02T12:00:00.000Z",
      payload: {
        ...structuredClone(refundTemplate.payload),
        transaction_id: "refund-transaction-55-runtime-explicit-future",
        correction_target_record_id: runtimeTargetPurchase.record_id,
        amount_unscaled: "100000",
      },
    };
    const runtimeExplicitFutureResult = await ingestRuntimeBatch(
      [{ server: commerceInput.server_context, record: runtimeExplicitFutureRefund,
        batch_id: "runtime-explicit-future-refund" }],
      appPool,
      [...commerceInput.records, runtimeFuturePurchase].map((record: Any) => ({
        server: commerceInput.server_context, record, batch_id: "runtime-explicit-future-history",
      })),
    );
    assert.ok(runtimeExplicitFutureResult.logical_events.some((logical) =>
      logical.record_id === runtimeExplicitFutureRefund.record_id));
    assert.deepEqual((await withTenant(
      appPool,
      commerceInput.server_context.tenant_id,
      (client) => client.query<{ correction_target_record_id: string }>(
        `SELECT correction_target_record_id FROM ledger.refund_facts
          WHERE tenant_id=$1 AND app_id=$2 AND transaction_id=$3`,
        [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id,
          runtimeExplicitFutureRefund.payload.transaction_id],
      ),
    )).rows, [{ correction_target_record_id: runtimeTargetPurchase.record_id }],
    "runtime and the DB trigger must both exclude a future-received explicit-target candidate");

    const runtimeExplicitFutureTargetRefund = {
      ...structuredClone(runtimeExplicitFutureRefund),
      record_id: "refund-55-runtime-explicit-future-target",
      delivery_id: "delivery:refund-55-runtime-explicit-future-target",
      event_id: "event:refund-55-runtime-explicit-future-target",
      payload: {
        ...structuredClone(runtimeExplicitFutureRefund.payload),
        transaction_id: "refund-transaction-55-runtime-explicit-future-target",
        correction_target_record_id: runtimeFuturePurchase.record_id,
      },
    };
    const runtimeExplicitFutureTargetResult = await ingestRuntimeBatch(
      [{ server: commerceInput.server_context, record: runtimeExplicitFutureTargetRefund,
        batch_id: "runtime-explicit-future-target-refund" }],
      appPool,
      [...commerceInput.records, runtimeFuturePurchase].map((record: Any) => ({
        server: commerceInput.server_context, record, batch_id: "runtime-explicit-future-target-history",
      })),
    );
    assert.ok(runtimeExplicitFutureTargetResult.rejections.some((rejection) =>
      rejection.record_id === runtimeExplicitFutureTargetRefund.record_id
      && rejection.reason_code === "refund_target_invalid"));
    assert.equal((await withTenant(
      appPool,
      commerceInput.server_context.tenant_id,
      (client) => client.query(
        `SELECT logical_event_id FROM ledger.refund_facts
          WHERE tenant_id=$1 AND app_id=$2 AND transaction_id=$3`,
        [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id,
          runtimeExplicitFutureTargetRefund.payload.transaction_id],
      ),
    )).rowCount, 0,
    "runtime must reject an explicit target received after the refund even when another strict target is unique");

    const runtimeExplicitAmbiguousRefund = {
      ...structuredClone(runtimeExplicitFutureRefund),
      record_id: "refund-55-runtime-explicit-ambiguous",
      delivery_id: "delivery:refund-55-runtime-explicit-ambiguous",
      event_id: "event:refund-55-runtime-explicit-ambiguous",
      occurred_at: "2026-08-03T01:00:00.000Z",
      received_at: "2026-08-04T00:00:00.000Z",
      payload: {
        ...structuredClone(runtimeExplicitFutureRefund.payload),
        transaction_id: "refund-transaction-55-runtime-explicit-ambiguous",
      },
    };
    const runtimeExplicitAmbiguousResult = await ingestRuntimeBatch(
      [{ server: commerceInput.server_context, record: runtimeExplicitAmbiguousRefund,
        batch_id: "runtime-explicit-ambiguous-refund" }],
      appPool,
      [...commerceInput.records, runtimeFuturePurchase, runtimeExplicitFutureRefund]
        .map((record: Any) => ({
          server: commerceInput.server_context, record, batch_id: "runtime-explicit-ambiguous-history",
        })),
    );
    assert.ok(runtimeExplicitAmbiguousResult.rejections.some((rejection) =>
      rejection.record_id === runtimeExplicitAmbiguousRefund.record_id
      && rejection.reason_code === "refund_target_invalid"));
    assert.equal((await withTenant(
      appPool,
      commerceInput.server_context.tenant_id,
      (client) => client.query(
        `SELECT logical_event_id FROM ledger.refund_facts
          WHERE tenant_id=$1 AND app_id=$2 AND transaction_id=$3`,
        [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id,
          runtimeExplicitAmbiguousRefund.payload.transaction_id],
      ),
    )).rowCount, 0,
    "runtime must reject ambiguity before an explicit record ID can select a target");

    const runtimeAmountPurchase = {
      ...structuredClone(runtimeTargetPurchase),
      record_id: "purchase-55-runtime-amount-provenance",
      delivery_id: "delivery:purchase-55-runtime-amount-provenance",
      event_id: "event:purchase-55-runtime-amount-provenance",
      occurred_at: "2026-08-05T00:00:00.000Z",
      received_at: "2026-08-05T00:00:01.000Z",
      payload: {
        ...structuredClone(runtimeTargetPurchase.payload),
        transaction_id: "transaction-55-runtime-amount-provenance",
        original_transaction_id: "original-55-runtime-amount-provenance",
      },
    };
    const runtimeAmountPurchaseResult = await ingestRuntimeBatch(
      [{ server: commerceInput.server_context, record: runtimeAmountPurchase,
        batch_id: "runtime-amount-provenance-purchase" }],
      appPool,
    );
    assert.ok(runtimeAmountPurchaseResult.logical_events.some((logical) =>
      logical.record_id === runtimeAmountPurchase.record_id));

    for (const [mismatch, mutateHistory] of [
      ["unscaled", (history: Any) => { history.payload.amount_unscaled = "8000001"; }],
      ["scale", (history: Any) => { history.payload.amount_scale = 7; }],
    ] as const) {
      const mismatchedHistory = structuredClone(runtimeAmountPurchase);
      mutateHistory(mismatchedHistory);
      const amountMismatchRefund = {
        ...structuredClone(refundTemplate),
        record_id: `refund-55-runtime-amount-${mismatch}`,
        delivery_id: `delivery:refund-55-runtime-amount-${mismatch}`,
        event_id: `event:refund-55-runtime-amount-${mismatch}`,
        occurred_at: "2026-08-06T00:00:00.000Z",
        received_at: "2026-08-06T00:00:01.000Z",
        payload: {
          ...structuredClone(refundTemplate.payload),
          transaction_id: `refund-transaction-55-runtime-amount-${mismatch}`,
          original_transaction_id: runtimeAmountPurchase.payload.original_transaction_id,
          correction_target_record_id: runtimeAmountPurchase.record_id,
          amount_unscaled: "100000",
        },
      };
      const amountMismatchResult = await ingestRuntimeBatch(
        [{ server: commerceInput.server_context, record: amountMismatchRefund,
          batch_id: `runtime-amount-${mismatch}-refund` }],
        appPool,
        [{ server: commerceInput.server_context, record: mismatchedHistory,
          batch_id: `runtime-amount-${mismatch}-history` }],
      );
      assert.ok(amountMismatchResult.rejections.some((rejection) =>
        rejection.record_id === amountMismatchRefund.record_id
        && rejection.reason_code === "refund_target_invalid"),
      `historical purchase amount_${mismatch} drift must invalidate refund target provenance`);
      assert.equal((await withTenant(
        appPool,
        commerceInput.server_context.tenant_id,
        (client) => client.query(
          `SELECT logical_event_id FROM ledger.refund_facts
            WHERE tenant_id=$1 AND app_id=$2 AND transaction_id=$3`,
          [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id,
            amountMismatchRefund.payload.transaction_id],
        ),
      )).rowCount, 0);
    }

    const historicalPurchase = {
      ...structuredClone(purchase),
      record_id: "purchase-55-pre-024",
      delivery_id: "delivery:purchase-55-pre-024",
      event_id: "event:purchase-55-pre-024",
      payload: {
        ...structuredClone(purchase.payload),
        transaction_id: "transaction-55-pre-024",
        original_transaction_id: "transaction-original-55-pre-024",
      },
    };
    const historicalInput = structuredClone(commerceInput);
    historicalInput.records = [historicalPurchase];
    historicalInput.metric_evaluations = [];
    const historicalEvaluation = evaluate(historicalInput);
    const historicalRaw = historicalEvaluation.raw_records[0];
    const historicalLogical = historicalEvaluation.logical_events[0];
    await withTenant(appPool, commerceInput.server_context.tenant_id, async (client) => {
      await client.query(
        `INSERT INTO ledger.raw_records (
           record_id,tenant_id,app_id,producer,producer_version,event_id,delivery_id,
           event_name,schema_version,payload_sha256,occurred_at,occurred_at_source,
           received_at,raw_payload_ref,processing_purpose_id,
           consent_evaluation_policy_version,consent_decision_reason_code,
           withdrawal_recognized_at,alternative_legal_basis_id,
           alternative_legal_basis_policy_version,policy_digest,artifact
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb
         )`,
        [historicalRaw.record_id, historicalRaw.tenant_id, historicalRaw.app_id,
          historicalRaw.producer, historicalRaw.producer_version, historicalRaw.event_id,
          historicalRaw.delivery_id, historicalRaw.event_name, historicalRaw.schema_version,
          historicalRaw.payload_sha256, historicalRaw.occurred_at, historicalRaw.occurred_at_source,
          historicalRaw.received_at, historicalRaw.raw_payload_ref,
          historicalRaw.processing_purpose_id, historicalRaw.consent_evaluation_policy_version,
          historicalRaw.consent_decision_reason_code,
          historicalRaw.withdrawal_recognized_at ?? null,
          historicalRaw.alternative_legal_basis_id ?? null,
          historicalRaw.alternative_legal_basis_policy_version ?? null,
          commerceInput.server_context.policy_digest, JSON.stringify(historicalRaw)],
      );
      await client.query(
        `INSERT INTO ledger.raw_payload_states (
           tenant_id,app_id,record_id,lifecycle_status,changed_at
         ) VALUES ($1,$2,$3,'available',$4)`,
        [historicalRaw.tenant_id, historicalRaw.app_id, historicalRaw.record_id,
          historicalRaw.received_at],
      );
      await client.query(
        `INSERT INTO ledger.logical_events (
           logical_event_id,record_id,tenant_id,app_id,producer,event_id,event_name,
           record_lifecycle,timeliness,artifact
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [historicalLogical.logical_event_id, historicalLogical.record_id,
          historicalLogical.tenant_id, historicalLogical.app_id, historicalLogical.producer,
          historicalLogical.event_id, historicalLogical.event_name,
          historicalLogical.record_lifecycle, historicalLogical.timeliness,
          JSON.stringify(historicalLogical)],
      );
      await client.query(
        `INSERT INTO ledger.purchase_facts (
           logical_event_id,tenant_id,app_id,installation_id,transaction_id,
           amount_unscaled,amount_scale,currency,occurred_at,artifact
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [historicalLogical.logical_event_id, historicalLogical.tenant_id, historicalLogical.app_id,
          historicalPurchase.payload.installation_id, historicalPurchase.payload.transaction_id,
          historicalPurchase.payload.amount_unscaled, historicalPurchase.payload.amount_scale,
          historicalPurchase.payload.currency, historicalPurchase.occurred_at,
          JSON.stringify({ legacy_pre_024_projection: true })],
      );
    });
    const refundAgainstHistorical = {
      ...structuredClone(refundTemplate),
      record_id: "refund-55-against-pre-024",
      delivery_id: "delivery:refund-55-against-pre-024",
      event_id: "event:refund-55-against-pre-024",
      received_at: "2026-08-03T04:00:00.000Z",
      occurred_at: "2026-08-03T03:00:00.000Z",
      payload: {
        ...structuredClone(refundTemplate.payload),
        transaction_id: "refund-transaction-55-against-pre-024",
        original_transaction_id: historicalPurchase.payload.original_transaction_id,
      },
    };
    const historicalResult = await ingestRuntimeBatch(
      [{ server: commerceInput.server_context, record: refundAgainstHistorical, batch_id: "runtime-post-024-refund" }],
      appPool,
      [{ server: commerceInput.server_context, record: historicalPurchase, batch_id: "runtime-pre-024-history" }],
    );
    assert.ok(historicalResult.rejections.some((rejection) =>
      rejection.record_id === refundAgainstHistorical.record_id
      && rejection.reason_code === "refund_target_invalid"),
    "a pre-024 purchase without eligible projected provenance must reject without crashing the batch");
    assert.equal((await withTenant(appPool, commerceInput.server_context.tenant_id, (client) => client.query(
      `SELECT logical_event_id FROM ledger.refund_facts
        WHERE tenant_id=$1 AND app_id=$2 AND transaction_id=$3`,
      [commerceInput.server_context.tenant_id, commerceInput.server_context.app_id,
        refundAgainstHistorical.payload.transaction_id],
    ))).rowCount, 0);

    const legacyInput: Any = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures", "v0.4", "16-correction-refund", "input.json"),
      "utf8",
    ));
    const legacyAttempts = [...legacyInput.records].reverse().map((record: Any) => ({
      server: legacyInput.server_context, record, batch_id: "runtime-legacy-refund-16",
    }));
    const legacyOutput = await ingestRuntimeBatch(legacyAttempts, appPool);
    assert.ok(legacyOutput.deliveries.some((delivery) =>
      delivery.record_id === "refund-16" && delivery.ingestion_status === "accepted"));
    const legacyProjection = await withTenant(appPool, legacyInput.server_context.tenant_id, async (client) => ({
      refunds: (await client.query(
        `SELECT logical_event_id FROM ledger.refund_facts
          WHERE tenant_id=$1 AND app_id=$2 AND transaction_id='refund-a'`,
        [legacyInput.server_context.tenant_id, legacyInput.server_context.app_id],
      )).rowCount,
      corrections: (await client.query<{ corrects_record_id: string }>(
        `SELECT corrects_record_id FROM ledger.corrections
          WHERE tenant_id=$1 AND app_id=$2 AND correction_id='correction:refund-16'`,
        [legacyInput.server_context.tenant_id, legacyInput.server_context.app_id],
      )).rows,
    }));
    assert.equal(legacyProjection.refunds, 0,
      "legacy explicit refunds must not enter the v0.4.8 financial projection");
    assert.deepEqual(legacyProjection.corrections, [{ corrects_record_id: "purchase-16" }],
      "runtime correction must preserve the explicit legacy target when purchase receipt is later");
  });

  it("keeps D30/D90 total-net SQL metrics JCS-identical across elapsed-window boundaries", async () => {
    const fixtureName = "56-d30-d90-total-net-metrics";
    const input: Any = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures", "v0.4", fixtureName, "input.json"),
      "utf8",
    ));
    await ingestFixture(fixtureName, input, appPool, seedPool);
    const expected = evaluate(input).metric_runs;
    const actual = await computeSqlMetricRuns(appPool, input, false);
    assert.equal(jcs(actual), jcs(expected));
    assert.deepEqual(
      actual.map((run) => [run.metric_name, run.value_unscaled]),
      [
        ["cohort_purchase_net_revenue_d30_usd", "8000000"],
        ["cohort_purchase_net_revenue_d90_usd", "30000000"],
        ["cohort_total_net_ltv_d30_usd", "9000000"],
        ["cohort_total_net_ltv_d90_usd", "37000000"],
        ["cohort_total_net_revenue_d30_usd", "9000000"],
        ["cohort_total_net_revenue_d90_usd", "37000000"],
        ["d30_total_net_roas", "900000"],
        ["d90_total_net_roas", "3700000"],
      ],
      "D31 belongs only to D90 and the D91 boundary belongs to neither horizon",
    );

    const wrongBundle = structuredClone(input);
    wrongBundle.metric_definitions.find((definition: Any) =>
      definition.metric_name === "d30_total_net_roas").rule_bundle_hash = "8".repeat(64);
    await assert.rejects(
      () => computeSqlMetricRuns(appPool, wrongBundle, false),
      /metric_definition_series_mismatch:d30_total_net_roas/,
      "SQL metric path accepted a mismatched total-net bundle",
    );
  });
});
