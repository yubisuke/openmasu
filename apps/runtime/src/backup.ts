import { createHash, createHmac, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Client } from "pg";
import { checkAppliedMigrations, readMigrations, type Migration } from "./migration-engine.js";
import { fileDigest, migrationDigest } from "./upgrade.js";
import { EncryptedFilePayloadStore } from "./payload-store.js";

export interface PrivacyBoundary {
  format: "openmasu-privacy-boundary-v1";
  captured_at: string;
  request_count: number;
  request_digest: string;
  tenant_digest: string;
}
interface Inventory { sha256: string; files: number }
export interface BackupManifest {
  format: "openmasu-backup-v1";
  bundle_id: string;
  captured_at: string;
  completed_at: string;
  source_revision: string;
  postgres_major: 17;
  migration_digest: string;
  master_key_ref: string;
  master_key_check: string;
  database_sha256: string;
  objects: Inventory;
  keys: Inventory;
  privacy: PrivacyBoundary;
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

export function validatePrivacyBoundary(value: unknown): PrivacyBoundary {
  const row = value as PrivacyBoundary | null;
  if (!row || row.format !== "openmasu-privacy-boundary-v1" || !iso(row.captured_at)
    || !Number.isSafeInteger(row.request_count) || row.request_count < 0 || !hex(row.request_digest) || !hex(row.tenant_digest)
    || Object.keys(row).length !== 5) throw new Error("backup_privacy_boundary_invalid");
  return row;
}

// Include every recognized request, including processing jobs and future-dated input.
// Lifecycle state is excluded: completing an already recognized request is not a new boundary.
export async function readPrivacyBoundary(client: Client): Promise<PrivacyBoundary> {
  const requests = (await client.query(`
    SELECT * FROM (SELECT tenant_id,app_id,privacy_request_id,requested_at,request_digest
      FROM control.privacy_deletion_jobs
    UNION ALL
    SELECT p.tenant_id,p.app_id,p.privacy_request_id,p.requested_at,NULL AS request_digest
      FROM ledger.privacy_requests p
      WHERE NOT EXISTS (SELECT 1 FROM control.privacy_deletion_jobs j WHERE j.privacy_request_id=p.privacy_request_id)) requests
    ORDER BY tenant_id COLLATE "C",app_id COLLATE "C",privacy_request_id COLLATE "C"
  `)).rows;
  const tenants = (await client.query('SELECT DISTINCT tenant_id COLLATE "C" AS tenant_id FROM control.apps ORDER BY tenant_id')).rows;
  return { format: "openmasu-privacy-boundary-v1", captured_at: new Date().toISOString(),
    request_count: requests.length, request_digest: digest(requests), tenant_digest: digest(tenants) };
}

export function assertSamePrivacy(left: PrivacyBoundary, right: PrivacyBoundary): void {
  if (left.request_count !== right.request_count || left.request_digest !== right.request_digest || left.tenant_digest !== right.tenant_digest) {
    throw new Error("backup_privacy_boundary_mismatch");
  }
}

export async function requireBackupOperator(client: Client): Promise<void> {
  if (!(await client.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0]?.rolsuper) throw new Error("backup_superuser_required");
}

async function schemaDigest(client: Client): Promise<string> {
  const version = Number((await client.query("SHOW server_version_num")).rows[0].server_version_num);
  if (Math.floor(version / 10_000) !== 17) throw new Error("backup_postgres_unsupported");
  const rows = (await client.query<Omit<Migration, "source">>("SELECT version,name,checksum FROM public.schema_migrations ORDER BY version")).rows;
  const migrations = readMigrations();
  checkAppliedMigrations(rows, migrations);
  if (rows.length !== migrations.length) throw new Error("backup_migrations_incomplete");
  return migrationDigest(rows);
}

async function regularFile(path: string): Promise<void> {
  if (!(await lstat(path)).isFile()) throw new Error("backup_regular_file_required");
}

export async function payloadInventory(directory: string): Promise<Inventory> {
  if (!(await lstat(directory)).isDirectory()) throw new Error("backup_payload_directory_invalid");
  const entries = (await readdir(directory)).sort();
  const rows: unknown[] = [];
  for (const name of entries) {
    await regularFile(join(directory, name));
    rows.push([name, (await stat(join(directory, name))).size, await fileDigest(join(directory, name))]);
  }
  return { sha256: digest(rows), files: entries.length };
}

// New private destinations only. Resolve existing ancestors so a symlink cannot bypass the repository boundary.
export async function createPrivateDirectory(path: string): Promise<string> {
  const parent = await realpath(resolve(path, ".."));
  const destination = join(parent, resolve(path).split(/[\\/]/).at(-1)!);
  const repository = await realpath(process.cwd());
  const rel = relative(repository, destination);
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("backup_destination_must_be_outside_repository");
  await mkdir(destination, { mode: 0o700 }); // EEXIST intentionally rejects reuse/overwrite.
  return destination;
}

function keyCheck(secret: string, bundleId: string): string {
  if (Buffer.byteLength(secret) < 32) throw new Error("backup_master_key_invalid");
  return createHmac("sha256", secret).update(`openmasu-backup-v1:${bundleId}`).digest("hex");
}

export async function createBackup(input: {
  client: Client; output: string; payloadRoot: string; masterKey: string; masterKeyRef: string;
  revision: string; writersStopped: boolean; dump: (path: string) => Promise<void>;
}): Promise<BackupManifest> {
  if (!input.writersStopped) throw new Error("backup_writers_stopped_ack_required");
  if (!/^[a-f0-9]{40}$/.test(input.revision) || !/^[A-Za-z0-9._:-]{1,128}$/.test(input.masterKeyRef)) throw new Error("backup_identity_invalid");
  const bundleId = randomUUID();
  const masterKeyCheck = keyCheck(input.masterKey, bundleId);
  await requireBackupOperator(input.client);
  const output = await createPrivateDirectory(input.output);
  await input.client.query("BEGIN");
  try {
    await input.client.query("SET LOCAL lock_timeout='5s'");
    await input.client.query("SELECT pg_advisory_xact_lock(hashtext('openmasu:backup'))");
    const others = (await input.client.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'")).rows[0].count;
    if (others !== 0) throw new Error("backup_writers_not_stopped");
    const tables = (await input.client.query<{ schema: string; name: string }>(
      "SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('control','ledger','ephemeral','testing','public') AND c.relkind IN ('r','p') ORDER BY n.nspname,c.relname",
    )).rows;
    for (const table of tables) await input.client.query(`LOCK TABLE ${quote(table.schema)}.${quote(table.name)} IN SHARE MODE`);
    const privacy = await readPrivacyBoundary(input.client);
    const migrations = await schemaDigest(input.client);
    const objects = await payloadInventory(join(input.payloadRoot, "objects"));
    const keys = await payloadInventory(join(input.payloadRoot, "keys"));
    await new EncryptedFilePayloadStore(input.payloadRoot, input.masterKey).verifyWrappedKeys();
    await input.dump(join(output, "database.dump"));
    await regularFile(join(output, "database.dump"));
    if ((await stat(join(output, "database.dump"))).size === 0) throw new Error("backup_database_empty");
    await mkdir(join(output, "payloads"), { mode: 0o700 });
    for (const name of ["objects", "keys"]) await cp(join(input.payloadRoot, name), join(output, "payloads", name), { recursive: true, errorOnExist: true, force: false });
    for (const [name, expected] of [["objects", objects], ["keys", keys]] as const) {
      for (const root of [input.payloadRoot, join(output, "payloads")]) {
        if (JSON.stringify(await payloadInventory(join(root, name))) !== JSON.stringify(expected)) throw new Error("backup_payload_changed");
      }
    }
    const manifest: BackupManifest = { format: "openmasu-backup-v1", bundle_id: bundleId, captured_at: privacy.captured_at,
      completed_at: new Date().toISOString(), source_revision: input.revision, postgres_major: 17,
      migration_digest: migrations, master_key_ref: input.masterKeyRef, master_key_check: masterKeyCheck,
      database_sha256: await fileDigest(join(output, "database.dump")), objects, keys, privacy };
    await input.client.query("COMMIT");
    // A failed/partial attempt has no manifest and cannot pass preflight.
    await writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return manifest;
  } catch (error) { await input.client.query("ROLLBACK"); throw error; }
}

export async function checkBackup(input: {
  directory: string; boundary: PrivacyBoundary; revision: string; maximumAgeHours: number;
  boundaryMaximumAgeMinutes?: number; now?: Date;
}): Promise<BackupManifest> {
  await regularFile(join(input.directory, "manifest.json"));
  const row = JSON.parse(await readFile(join(input.directory, "manifest.json"), "utf8")) as BackupManifest;
  if (!row || row.format !== "openmasu-backup-v1" || !/^[a-f0-9-]{36}$/.test(row.bundle_id)
    || !iso(row.captured_at) || !iso(row.completed_at) || !/^[a-f0-9]{40}$/.test(input.revision) || row.source_revision !== input.revision || row.postgres_major !== 17
    || !hex(row.migration_digest) || !hex(row.database_sha256) || !hex(row.master_key_check)
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(row.master_key_ref)) throw new Error("backup_manifest_invalid");
  validatePrivacyBoundary(row.privacy);
  if (row.privacy.captured_at !== row.captured_at) throw new Error("backup_manifest_invalid");
  const boundary = validatePrivacyBoundary(input.boundary);
  const now = (input.now ?? new Date()).getTime();
  const checkpointAge = now - Date.parse(boundary.captured_at);
  const backupAge = now - Date.parse(row.captured_at);
  const checkpointLimit = input.boundaryMaximumAgeMinutes ?? 15;
  if (!Number.isFinite(input.maximumAgeHours) || input.maximumAgeHours <= 0 || !Number.isFinite(checkpointLimit) || checkpointLimit <= 0
    || backupAge < 0 || backupAge > input.maximumAgeHours * 3_600_000 || Date.parse(row.completed_at) < Date.parse(row.captured_at)
    || Date.parse(row.completed_at) > now || checkpointAge < 0 || checkpointAge > checkpointLimit * 60_000
    || Date.parse(boundary.captured_at) < Date.parse(row.captured_at)) throw new Error("backup_freshness_failed");
  assertSamePrivacy(row.privacy, boundary);
  if (row.migration_digest !== migrationDigest(readMigrations())) throw new Error("backup_migration_inventory_mismatch");
  await regularFile(join(input.directory, "database.dump"));
  if (await fileDigest(join(input.directory, "database.dump")) !== row.database_sha256) throw new Error("backup_database_checksum_mismatch");
  for (const name of ["objects", "keys"] as const) {
    const actual = await payloadInventory(join(input.directory, "payloads", name));
    if (!row[name] || row[name].sha256 !== actual.sha256 || row[name].files !== actual.files) throw new Error("backup_payload_checksum_mismatch");
  }
  return row;
}

export function verifyBackupKey(manifest: BackupManifest, masterKey: string, reference: string): void {
  if (reference !== manifest.master_key_ref || keyCheck(masterKey, manifest.bundle_id) !== manifest.master_key_check) throw new Error("backup_master_key_mismatch");
}

export async function verifyRestoredDatabase(client: Client, manifest: BackupManifest): Promise<string[]> {
  if (await schemaDigest(client) !== manifest.migration_digest) throw new Error("backup_restored_migrations_mismatch");
  assertSamePrivacy(await readPrivacyBoundary(client), manifest.privacy);
  return (await client.query<{ tenant_id: string }>('SELECT DISTINCT tenant_id COLLATE "C" AS tenant_id FROM control.apps ORDER BY tenant_id')).rows.map((row) => row.tenant_id);
}
