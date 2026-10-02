import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Client } from "pg";
import { checkAppliedMigrations, readMigrations, type Migration } from "./migration-engine.js";

export const UPGRADE_SOURCE = Object.freeze({
  tag: "v0.2.0", revision: "68b8c483a30c3804a216a655d964788d0204185f", postgresMajor: 17,
  migrationCount: 48, migrationDigest: "d4c18ba078913cfefa420ea6adfcf3d7386994a614f3b197e6222276bc4905c6",
});
export function migrationDigest(rows: readonly Omit<Migration, "source">[]): string {
  return createHash("sha256").update(JSON.stringify(rows.map(({ version, name, checksum }) => ({ version, name, checksum })))).digest("hex");
}
export interface UpgradeBackup {
  format: "openmasu-upgrade-backup-v1"; source_tag: string; source_revision: string;
  postgres_major: number; migration_digest: string; database_sha256: string; payload_sha256: string;
  payload_snapshot_id: string; master_key_ref: string; privacy_boundary_at: string;
}
export function validateUpgradeBackup(value: unknown, from: string): UpgradeBackup {
  if (from !== UPGRADE_SOURCE.tag) throw new Error("upgrade_source_unsupported");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("upgrade_backup_invalid");
  const row = value as UpgradeBackup;
  const keys = ["format", "source_tag", "source_revision", "postgres_major", "migration_digest", "database_sha256", "payload_sha256", "payload_snapshot_id", "master_key_ref", "privacy_boundary_at"];
  if (Object.keys(row).length !== keys.length || keys.some((key) => !(key in row))
    || Object.entries(row).some(([key, entry]) => key !== "postgres_major" && typeof entry !== "string")
    || row.format !== "openmasu-upgrade-backup-v1" || row.source_tag !== from || row.source_revision !== UPGRADE_SOURCE.revision
    || row.postgres_major !== UPGRADE_SOURCE.postgresMajor || row.migration_digest !== UPGRADE_SOURCE.migrationDigest
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
  await client.query("BEGIN READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout='5s'");
    const version = Number((await client.query("SHOW server_version_num")).rows[0].server_version_num);
    if (Math.floor(version / 10_000) !== UPGRADE_SOURCE.postgresMajor || backup.postgres_major !== UPGRADE_SOURCE.postgresMajor) throw new Error("upgrade_postgres_unsupported");
    const rows = (await client.query<Omit<Migration, "source">>("SELECT version,name,checksum FROM public.schema_migrations ORDER BY version")).rows;
    if (rows.length < UPGRADE_SOURCE.migrationCount || migrationDigest(rows.slice(0, UPGRADE_SOURCE.migrationCount)) !== backup.migration_digest) throw new Error("upgrade_source_inventory_mismatch");
    checkAppliedMigrations(rows, migrations);
    return { applied: rows.length, pending: migrations.length - rows.length, source: UPGRADE_SOURCE.tag, postgres_major: 17, traffic_restart: "manual" };
  } finally { await client.query("ROLLBACK"); }
}
