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
const fixtureDirectory = join(process.cwd(), "fixtures", "v0.3", fixtureName);
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
      contract_version: "0.3.0",
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
      join(process.cwd(), "fixtures", "v0.3", undefinedFixture, "input.json"),
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
    const dailyDirectory = join(process.cwd(), "fixtures", "v0.3", dailyFixture);
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
      join(process.cwd(), "fixtures", "v0.3", "42-daily-metric-date", "input.json"),
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
      join(process.cwd(), "fixtures", "v0.3", "42-daily-metric-date", "input.json"),
      "utf8",
    ));
    const paid: Any = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures", "v0.3", "01-valid-install-referrer", "input.json"),
      "utf8",
    ));
    const unknown: Any = JSON.parse(readFileSync(
      join(process.cwd(), "fixtures", "v0.3", "03-unknown-click", "input.json"),
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

  it("M4 reproduces qualified Apple aggregate counts and receipt-date buckets", async () => {
    const appleFixture = "44-apple-aggregate-metrics";
    const appleDirectory = join(process.cwd(), "fixtures", "v0.3", appleFixture);
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
});
