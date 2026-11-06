import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { assertUpgradeTarget, sourceIdentity } from "../../apps/runtime/src/source-identity.js";
import { migrateDatabase, readMigrations } from "../../apps/runtime/src/migration-engine.js";
import { UPGRADE_SOURCE, upgradePreflight, validateUpgradeBackup } from "../../apps/runtime/src/upgrade.js";

// This probe belongs to the existing disposable Compose pilot, not a live
// recovery command. The ordinary backup suite owns populated/privacy fixtures.
const url = process.env.OPENMASU_MIGRATION_DATABASE_URL!;
assert.equal(process.env.OPENMASU_DEPLOYMENT_PURPOSE, "synthetic_disposable");
assert.equal(new URL(url).hostname, "postgres");
const identity = sourceIdentity(); assert.ok(identity.runtime);
assert.equal(identity.runtime.source_tag, null);
assert.throws(() => assertUpgradeTarget(`runtime-v${identity.runtime!.runtime_version}`), /upgrade_target_identity_mismatch/);
let admin = new Client({ connectionString: url }); await admin.connect();
assert.equal((await admin.query("SELECT purpose FROM control.deployment_purpose WHERE singleton")).rows[0].purpose, "synthetic_disposable");
assert.equal((await admin.query("SELECT count(*)::int AS n FROM ledger.raw_records")).rows[0].n, 0);
await admin.end();
let adminConnected = false;
const temporary = mkdtempSync(join(tmpdir(), "openmasu-runtime-operations-"));
const backup = join(temporary, "backup"), boundary = join(temporary, "boundary.json"), restored = join(temporary, "payloads");
const databases: string[] = [];
function cli(command: string, args: string[]): Record<string, any> {
  const result = spawnSync(process.execPath, ["--import", "tsx", "apps/worker/src/backup-cli.ts", command, ...args],
    { env: process.env, encoding: "utf8", maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, `artifact backup ${command}: ${result.stderr}`);
  return JSON.parse(result.stdout.trim());
}
try {
  for (const name of ["objects", "keys"]) mkdirSync(join(process.env.OPENMASU_PAYLOAD_STORE_DIR!, name), { recursive: true });
  assert.equal(cli("create", ["--writers-stopped", "--output", backup, "--master-key-ref", "key:synthetic-artifact"]).backup_complete, true);
  assert.equal(cli("boundary", ["--writers-stopped", "--output", boundary]).privacy_boundary_written, true);
  assert.equal(cli("check", ["--directory", backup, "--boundary", boundary]).backup_valid, true);
  const result = cli("restore", ["--directory", backup, "--boundary", boundary, "--payload-output", restored,
    "--master-key-ref", "key:synthetic-artifact", "--privacy-intake-stopped"]);
  assert.equal(result.ready, true); assert.equal(result.traffic_restart, "manual");
  assert.match(result.database, /^openmasu_restore_[a-f0-9]{24}$/); databases.push(result.database);
  admin = new Client({ connectionString: url }); await admin.connect(); adminConnected = true;
  const oldName = `openmasu_artifact_upgrade_${randomBytes(8).toString("hex")}`;
  await admin.query(`CREATE DATABASE "${oldName}" OWNER openmasu_owner`); databases.push(oldName);
  const oldUrl = new URL(url); oldUrl.pathname = `/${oldName}`;
  const old = new Client({ connectionString: oldUrl.toString() }); await old.connect();
  try {
    const migrations = readMigrations();
    assert.equal(await migrateDatabase(old, migrations.slice(0, UPGRADE_SOURCE.migrationCount), undefined, "persistent"), 48);
    const declaration = validateUpgradeBackup({ format: "openmasu-upgrade-backup-v1", source_tag: UPGRADE_SOURCE.tag,
      source_revision: UPGRADE_SOURCE.revision, postgres_major: 17, migration_digest: UPGRADE_SOURCE.migrationDigest,
      database_sha256: "a".repeat(64), payload_sha256: "b".repeat(64), payload_snapshot_id: "synthetic:artifact",
      master_key_ref: "key:synthetic-artifact", privacy_boundary_at: "2026-08-01T00:00:00.000Z" }, UPGRADE_SOURCE.tag);
    // This is a migration preflight proof, not an invented backup authenticity receipt.
    assert.equal((await upgradePreflight(old, declaration)).pending, migrations.length - 48);
    assert.equal(await migrateDatabase(old, migrations, undefined, "persistent"), migrations.length - 48);
    assert.equal((await upgradePreflight(old, declaration)).pending, 0);
    assert.equal(await migrateDatabase(old, migrations, undefined, "persistent"), 0);
  } finally { await old.end(); }
  console.log("Runtime artifact operations passed: backup=create/check/restore upgrade=48-to-current privacy=reapplied candidate-upgrade=refused.");
} finally {
  // Restore cluster-role login state for the original disposable pilot DB.
  // Only the two generated test databases are eligible for removal.
  try {
    if (!adminConnected) { admin = new Client({ connectionString: url }); await admin.connect(); adminConnected = true; }
    await migrateDatabase(admin, readMigrations(), undefined, "synthetic_disposable");
    for (const database of databases) {
      assert.match(database, /^openmasu_(?:restore_[a-f0-9]{24}|artifact_upgrade_[a-f0-9]{16})$/);
      await admin.query(`DROP DATABASE "${database}"`);
    }
  } finally { await admin.end(); rmSync(temporary, { recursive: true, force: true }); }
}
