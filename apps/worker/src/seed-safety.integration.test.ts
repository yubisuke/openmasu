import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { Client, Pool } from "pg";
import { createMigrationPool, createSeedPool } from "@openmasu/runtime";
import { migrateDatabase } from "../../runtime/src/migration-engine.js";
import { resetLedger } from "./test-support/fixture-ingestion.js";
import { withSyntheticSeedLock } from "./test-support/seed-safety.js";

const execFileAsync = promisify(execFile);

it("persistent and missing DB purposes refuse synthetic seeding without changing fixture or ledger canaries", {
  timeout: 120_000,
}, async () => {
  const migrationUrl = process.env.OPENMASU_MIGRATION_DATABASE_URL;
  const seedUrl = process.env.OPENMASU_SEED_DATABASE_URL;
  const appUrl = process.env.OPENMASU_APP_DATABASE_URL;
  assert.ok(migrationUrl && seedUrl && appUrl);
  const databaseName = `openmasu_seed_safety_${randomBytes(6).toString("hex")}`;
  assert.match(databaseName, /^openmasu_seed_safety_[a-f0-9]{12}$/);
  const isolatedUrl = (source: string) => {
    const url = new URL(source);
    url.pathname = `/${databaseName}`;
    return url.toString();
  };
  const admin = createMigrationPool();
  let created = false;
  let client: Client | undefined;
  let seedPool: Pool | undefined;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}" OWNER openmasu_owner`);
    created = true;
    client = new Client({ connectionString: isolatedUrl(migrationUrl) });
    await client.connect();
    await migrateDatabase(client, undefined, undefined, "persistent");
    assert.deepEqual((await client.query("SELECT purpose FROM control.deployment_purpose WHERE singleton")).rows,
      [{ purpose: "persistent" }]);
    assert.deepEqual((await client.query(
      `SELECT has_table_privilege('openmasu_seed','testing.fixture_runs','DELETE') AS fixture_delete,
              has_table_privilege('openmasu_seed','ledger.audit_logs','TRUNCATE') AS ledger_truncate,
              has_table_privilege('openmasu_seed','control.deployment_purpose','UPDATE') AS purpose_update`,
    )).rows, [{ fixture_delete: false, ledger_truncate: false, purpose_update: false }]);
    seedPool = new Pool({ connectionString: isolatedUrl(seedUrl), max: 2 });
    const auditId = randomUUID();
    const fixtureName = "synthetic-seed-safety-canary";
    await client.query(
      "INSERT INTO testing.fixture_inputs (fixture_name,input_digest,input) VALUES ($1,$2,$3::jsonb)",
      [fixtureName, "1".repeat(64), JSON.stringify({ synthetic: true, canary: "must-survive" })],
    );
    await client.query("INSERT INTO testing.fixture_runs (fixture_name,input_digest) VALUES ($1,$2)",
      [fixtureName, "1".repeat(64)]);
    await client.query(
      `INSERT INTO ledger.audit_logs (
        audit_log_id,tenant_id,app_id,occurred_at,actor_type,actor_ref,action,
        target_scope,target_ref,policy_version,request_digest,outcome
      ) VALUES ($1,'tenant-synthetic-seed-safety',NULL,$2,'system_job','synthetic-seed-safety',
        'synthetic_canary','tenant','tenant-synthetic-seed-safety','synthetic-test',$3,'succeeded')`,
      [auditId, new Date().toISOString(), "2".repeat(64)],
    );
    const snapshot = async () => ({
      inputs: (await client!.query("SELECT * FROM testing.fixture_inputs ORDER BY fixture_name")).rows,
      runs: (await client!.query("SELECT * FROM testing.fixture_runs ORDER BY fixture_name")).rows,
      ledger: (await client!.query("SELECT * FROM ledger.audit_logs WHERE audit_log_id=$1", [auditId])).rows,
    });
    const original = await snapshot();
    assert.equal(original.inputs.length, 1);
    assert.equal(original.runs.length, 1);
    assert.equal(original.ledger.length, 1);
    let callbackEntered = false;
    const refusesWithoutChanges = async () => {
      await assert.rejects(withSyntheticSeedLock(seedPool!, async () => {
        callbackEntered = true;
        await seedPool!.query("DELETE FROM testing.fixture_runs");
      }), /synthetic_seed_requires_disposable/);
      assert.equal(callbackEntered, false);
      await assert.rejects(resetLedger(seedPool!), /synthetic_seed_requires_disposable/);
      assert.deepEqual(await snapshot(), original);
    };
    await refusesWithoutChanges();
    await assert.rejects(migrateDatabase(client, undefined, undefined, "synthetic_disposable"), /deployment_purpose_mismatch/);
    await assert.rejects(execFileAsync(process.execPath, ["--import", "tsx", "apps/worker/src/seed.ts"], {
      cwd: process.cwd(), timeout: 15_000,
      env: {
        ...process.env,
        OPENMASU_DEPLOYMENT_PURPOSE: "synthetic_disposable",
        OPENMASU_MIGRATION_DATABASE_URL: isolatedUrl(migrationUrl),
        OPENMASU_SEED_DATABASE_URL: isolatedUrl(seedUrl),
        OPENMASU_APP_DATABASE_URL: isolatedUrl(appUrl),
      },
    }), (error: unknown) => {
      const failure = error as { code?: unknown; stderr?: string; stdout?: string };
      assert.equal(failure.code, 1);
      assert.match(failure.stderr ?? "", /synthetic_seed_requires_disposable/);
      assert.doesNotMatch(failure.stdout ?? "", /Seeded .* synthetic fixtures/);
      return true;
    });
    assert.deepEqual(await snapshot(), original, "a synthetic CLI environment cannot override the persistent DB purpose");

    // Only this disposable test database is modified; never remove the shared runtime marker.
    await client.query("DELETE FROM control.deployment_purpose WHERE singleton");
    await refusesWithoutChanges();
  } finally {
    if (seedPool) await seedPool.end();
    if (client) await client.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
});

describe("WO13 synthetic seed serialization", { concurrency: false }, () => {
  let pool: Pool;

  before(() => {
    pool = createSeedPool();
  });

  after(async () => {
    await pool.end();
  });

  it("serializes concurrent synthetic seed jobs with one session advisory lock", async () => {
    const order: string[] = [];
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>((resolve) => { enterFirst = resolve; });
    const release = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withSyntheticSeedLock(pool, async () => {
      order.push("first-enter");
      enterFirst();
      await release;
      order.push("first-exit");
    });
    await entered;
    const second = withSyntheticSeedLock(pool, async () => {
      order.push("second-enter");
    });
    try {
      await delay(100);
      assert.deepEqual(order, ["first-enter"]);
    } finally {
      releaseFirst();
    }
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-enter", "first-exit", "second-enter"]);
  });
});
