import assert from "node:assert/strict";
import { it } from "node:test";
import type { Client } from "pg";
import { checkAppliedMigrations, readMigrations } from "./migration-engine.js";
import { migrationDigest, UPGRADE_SOURCES, upgradePreflight, validateUpgradeBackup } from "./upgrade.js";

for (const source of UPGRADE_SOURCES) {
const backup = { format: "openmasu-upgrade-backup-v1", source_tag: source.tag, source_revision: source.revision, postgres_major: source.postgresMajor,
  migration_digest: source.migrationDigest, database_sha256: "a".repeat(64), payload_sha256: "b".repeat(64), payload_snapshot_id: "synthetic:snapshot", master_key_ref: "synthetic:key", privacy_boundary_at: "2026-10-02T00:00:00.000Z" };
it(`upgrade preflight accepts the frozen ${source.tag} source and closed backup declaration`, () => {
  assert.deepEqual(validateUpgradeBackup(backup, source.tag), backup);
  for (const value of [{ ...backup, postgres_major: 16 }, { ...backup, source_revision: "b".repeat(40) }, { ...backup, migration_digest: "b".repeat(64) }, { ...backup, extra: true }, { ...backup, payload_sha256: "bad" }, { ...backup, master_key_ref: null }, { ...backup, privacy_boundary_at: "2026-02-30T00:00:00.000Z" }]) assert.throws(() => validateUpgradeBackup(value, source.tag), /upgrade_backup_invalid/);
  for (const other of UPGRADE_SOURCES.filter((candidate) => candidate.tag !== source.tag)) assert.throws(() => validateUpgradeBackup({ ...backup, source_revision: other.revision, migration_digest: other.migrationDigest }, source.tag), /upgrade_backup_invalid/);
  assert.throws(() => validateUpgradeBackup(backup, "unknown"), /upgrade_source_unsupported/);
});
it(`upgrade source checksums match the unchanged ${source.migrationCount} frozen ${source.tag} migrations and reject gaps or edits`, () => {
  const migrations = readMigrations();
  assert.equal(migrationDigest(migrations.slice(0, source.migrationCount)), source.migrationDigest);
  checkAppliedMigrations(migrations.slice(0, source.migrationCount), migrations);
  assert.throws(() => checkAppliedMigrations([{ ...migrations[0], checksum: "b".repeat(64) }], migrations), /migration_inventory_mismatch/);
  assert.throws(() => checkAppliedMigrations([migrations[1]], migrations), /migration_inventory_mismatch/);
});
it(`upgrade preflight reads the ${source.tag} migration prefix without changing the database`, async () => {
  const migrations = readMigrations();
  const commands: string[] = [];
  const client = { query: async (command: string) => {
    commands.push(command);
    return { rows: command === "SHOW server_version_num" ? [{ server_version_num: "170006" }]
      : command.startsWith("SELECT version,name,checksum") ? migrations.slice(0, source.migrationCount) : [] };
  } } as unknown as Client;
  assert.deepEqual(await upgradePreflight(client, validateUpgradeBackup(backup, source.tag), migrations), {
    applied: source.migrationCount, pending: migrations.length - source.migrationCount,
    source: source.tag, postgres_major: source.postgresMajor, traffic_restart: "manual",
  });
  assert.deepEqual(commands, ["BEGIN READ ONLY", "SET LOCAL statement_timeout='5s'", "SHOW server_version_num",
    "SELECT version,name,checksum FROM public.schema_migrations ORDER BY version", "ROLLBACK"]);
});
}
