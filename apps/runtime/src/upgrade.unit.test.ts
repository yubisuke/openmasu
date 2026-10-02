import assert from "node:assert/strict";
import { it } from "node:test";
import { checkAppliedMigrations, readMigrations } from "./migration-engine.js";
import { migrationDigest, UPGRADE_SOURCE, validateUpgradeBackup } from "./upgrade.js";

const backup = { format: "openmasu-upgrade-backup-v1", source_tag: UPGRADE_SOURCE.tag, source_revision: UPGRADE_SOURCE.revision, postgres_major: 17,
  migration_digest: UPGRADE_SOURCE.migrationDigest, database_sha256: "a".repeat(64), payload_sha256: "b".repeat(64), payload_snapshot_id: "synthetic:snapshot", master_key_ref: "synthetic:key", privacy_boundary_at: "2026-10-02T00:00:00.000Z" };
it("upgrade preflight accepts only the frozen public source and closed backup declaration", () => {
  assert.deepEqual(validateUpgradeBackup(backup, "v0.2.0"), backup);
  for (const value of [{ ...backup, postgres_major: 16 }, { ...backup, source_revision: "b".repeat(40) }, { ...backup, extra: true }, { ...backup, payload_sha256: "bad" }, { ...backup, master_key_ref: null }, { ...backup, privacy_boundary_at: "2026-02-30T00:00:00.000Z" }]) assert.throws(() => validateUpgradeBackup(value, "v0.2.0"), /upgrade_backup_invalid/);
  assert.throws(() => validateUpgradeBackup(backup, "unknown"), /upgrade_source_unsupported/);
});
it("upgrade source checksums match the unchanged 48 frozen migrations and reject gaps or edits", () => {
  const migrations = readMigrations();
  assert.equal(migrationDigest(migrations.slice(0, 48)), UPGRADE_SOURCE.migrationDigest);
  checkAppliedMigrations(migrations.slice(0, 48), migrations);
  assert.throws(() => checkAppliedMigrations([{ ...migrations[0], checksum: "b".repeat(64) }], migrations), /migration_inventory_mismatch/);
  assert.throws(() => checkAppliedMigrations([migrations[1]], migrations), /migration_inventory_mismatch/);
});
