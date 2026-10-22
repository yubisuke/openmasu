import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Client } from "pg";
import { checkAppliedMigrations, readMigrations, type Migration } from "./migration-engine.js";

export const UPGRADE_SOURCE = Object.freeze({
  tag: "v0.2.0", revision: "68b8c483a30c3804a216a655d964788d0204185f", postgresMajor: 17,
  migrationCount: 48, migrationDigest: "d4c18ba078913cfefa420ea6adfcf3d7386994a614f3b197e6222276bc4905c6",
});
export const UPGRADE_SOURCES = Object.freeze([
  UPGRADE_SOURCE,
  Object.freeze({
    tag: "v0.3.0-rc.1", revision: "90a0f5fe56b75e8fdefd2f759e33b3ae538b79c2", postgresMajor: 17,
    migrationCount: 55, migrationDigest: "dbff0d98396a48dfc9c25d66bcbaab373c344cd2bee43dea561be024d4842276",
  }),
]);
function upgradeSource(tag: string): (typeof UPGRADE_SOURCES)[number] {
  const source = UPGRADE_SOURCES.find((candidate) => candidate.tag === tag);
  if (!source) throw new Error("upgrade_source_unsupported");
  return source;
}
export function migrationDigest(rows: readonly Omit<Migration, "source">[]): string {
  return createHash("sha256").update(JSON.stringify(rows.map(({ version, name, checksum }) => ({ version, name, checksum })))).digest("hex");
}
export interface UpgradeBackup {
  format: "openmasu-upgrade-backup-v1"; source_tag: string; source_revision: string;
  postgres_major: number; migration_digest: string; database_sha256: string; payload_sha256: string;
  payload_snapshot_id: string; master_key_ref: string; privacy_boundary_at: string;
}
export function validateUpgradeBackup(value: unknown, from: string): UpgradeBackup {
  const source = upgradeSource(from);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("upgrade_backup_invalid");
  const row = value as UpgradeBackup;
  const keys = ["format", "source_tag", "source_revision", "postgres_major", "migration_digest", "database_sha256", "payload_sha256", "payload_snapshot_id", "master_key_ref", "privacy_boundary_at"];
  if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))
    || Object.entries(row).some(([key, entry]) => key !== "postgres_major" && typeof entry !== "string")
    || row.format !== "openmasu-upgrade-backup-v1" || row.source_tag !== from || row.source_revision !== source.revision
    || row.postgres_major !== source.postgresMajor || row.migration_digest !== source.migrationDigest
    || !/^[0-9a-f]{64}$/.test(row.database_sha256) || !/^[0-9a-f]{64}$/.test(row.payload_sha256)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(row.payload_snapshot_id) || !/^[A-Za-z0-9._:-]{1,128}$/.test(row.master_key_ref)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.privacy_boundary_at)
    || !Number.isFinite(Date.parse(row.privacy_boundary_at)) || new Date(row.privacy_boundary_at).toISOString() !== row.privacy_boundary_at) throw new Error("upgrade_backup_invalid");
  return row;
}
export async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
export async function verifyBackupFiles(backup: UpgradeBackup, databasePath: string, payloadPath: string): Promise<void> {
  if (await fileDigest(databasePath) !== backup.database_sha256 || await fileDigest(payloadPath) !== backup.payload_sha256) throw new Error("upgrade_backup_checksum_mismatch");
}
export async function upgradePreflight(client: Client, backup: UpgradeBackup, migrations = readMigrations()): Promise<{ applied: number; pending: number; source: string; postgres_major: number; traffic_restart: "manual" }> {
  validateUpgradeBackup(backup, backup.source_tag);
  const source = upgradeSource(backup.source_tag);
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout='5s'");
    const version = Number((await client.query("SHOW server_version_num")).rows[0].server_version_num);
    if (Math.floor(version / 10_000) !== source.postgresMajor) throw new Error("upgrade_postgres_unsupported");
    const rows = (await client.query<Omit<Migration, "source">>("SELECT version,name,checksum FROM public.schema_migrations ORDER BY version")).rows;
    if (rows.length < source.migrationCount || migrationDigest(rows.slice(0, source.migrationCount)) !== backup.migration_digest) throw new Error("upgrade_source_inventory_mismatch");
    checkAppliedMigrations(rows, migrations);
    return { applied: rows.length, pending: migrations.length - rows.length, source: source.tag, postgres_major: source.postgresMajor, traffic_restart: "manual" };
  } finally { await client.query("ROLLBACK"); }
}
