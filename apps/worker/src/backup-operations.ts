import { randomBytes } from "node:crypto";
import { cp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { EncryptedFilePayloadStore, processPrivacyDeletionJobs, withTenant } from "@openmasu/runtime";
import { checkBackup, createPrivateDirectory, payloadInventory, verifyBackupKey, verifyRestoredDatabase, type PrivacyBoundary } from "@openmasu/runtime/backup";
import { reapplyCompletedPrivacyRequests } from "./privacy-reapply.js";

// Only this operation creates/unlocks the target. No caller-selected existing database is accepted.
export async function restoreBackup(input: {
  admin: Client; adminUrl: string; directory: string; payloadOutput: string; masterKey: string; masterKeyRef: string;
  revision: string; maximumAgeHours: number; privacyIntakeStopped: boolean;
  currentBoundary: () => Promise<PrivacyBoundary>;
  restoreArchive: (databaseUrl: string, archive: string) => Promise<void>;
}): Promise<{ ready: true; database: string; tenants: number; privacy_requests: number; metrics_recalculated: number; traffic_restart: "manual" }> {
  if (!input.privacyIntakeStopped) throw new Error("backup_privacy_intake_stopped_ack_required");
  const check = async () => checkBackup({ directory: input.directory, boundary: await input.currentBoundary(),
    revision: input.revision, maximumAgeHours: input.maximumAgeHours });
  const manifest = await check();
  verifyBackupKey(manifest, input.masterKey, input.masterKeyRef);
  const role = (await input.admin.query("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
  const unsafeRoles = (await input.admin.query("SELECT count(*)::int AS count FROM pg_roles WHERE rolname IN ('openmasu_app','openmasu_reader','openmasu_seed') AND rolsuper")).rows[0].count;
  if (!role?.rolsuper || unsafeRoles !== 0) throw new Error("backup_restore_role_boundary_invalid");
  const output = await createPrivateDirectory(input.payloadOutput);
  const database = `openmasu_restore_${randomBytes(12).toString("hex")}`;
  // Keep a private cleanup receipt even if pg_restore or privacy replay fails.
  await writeFile(join(output, "restore-state.json"), JSON.stringify({ database, bundle_id: manifest.bundle_id, ready: false }) + "\n", { flag: "wx", mode: 0o600 });
  await input.admin.query(`CREATE DATABASE "${database}" WITH OWNER openmasu_owner TEMPLATE template0 CONNECTION LIMIT 0`);
  const url = new URL(input.adminUrl);
  url.pathname = `/${database}`;
  await input.restoreArchive(url.toString(), join(input.directory, "database.dump"));
  for (const name of ["objects", "keys"]) await cp(join(input.directory, "payloads", name), join(output, name), { recursive: true, force: false, errorOnExist: true });
  for (const name of ["objects", "keys"] as const) {
    const inventory = await payloadInventory(join(output, name));
    if (inventory.sha256 !== manifest[name].sha256 || inventory.files !== manifest[name].files) throw new Error("backup_restored_payload_mismatch");
  }
  const client = new Client({ connectionString: url.toString() });
  const pool = new Pool({ connectionString: url.toString() });
  let privacyRequests = 0;
  let recalculated = 0;
  let tenants: string[] = [];
  try {
    await client.connect();
    tenants = await verifyRestoredDatabase(client, manifest);
    const payloadStore = new EncryptedFilePayloadStore(output, input.masterKey);
    await payloadStore.verifyWrappedKeys();
    for (const tenantId of tenants) {
      let drained = false;
      for (let cycle = 0; cycle < 10_000; cycle++) {
        const result = await processPrivacyDeletionJobs({ pool, payloadStore, tenantId });
        if (result.processing === 0 && result.jobs === 0) { drained = true; break; }
        if (result.processing > 0 && result.payloadsPurged === 0) break;
      }
      if (!drained) throw new Error("backup_privacy_drain_incomplete");
      const replay = await reapplyCompletedPrivacyRequests({ pool, payloadStore, tenantId });
      if (replay.unsupported_metric_runs !== 0) throw new Error("backup_privacy_replay_unsupported");
      privacyRequests += replay.privacy_requests;
      recalculated += replay.metrics_recalculated;
      const pending = await withTenant(pool, tenantId, async (connection) => Number((await connection.query(`
        SELECT (SELECT count(*) FROM control.privacy_deletion_jobs j WHERE tenant_id=$1 AND (status<>'completed'
          OR NOT EXISTS (SELECT 1 FROM ledger.privacy_requests p WHERE p.privacy_request_id=j.privacy_request_id AND p.status='completed' AND p.completed_at IS NOT NULL)))
          + (SELECT count(*) FROM ledger.privacy_requests WHERE tenant_id=$1 AND (status<>'completed' OR completed_at IS NULL)) AS count`, [tenantId])).rows[0].count));
      if (pending !== 0) throw new Error("backup_privacy_replay_incomplete");
    }
    await verifyRestoredDatabase(client, manifest);
    await check(); // Recheck external checkpoint freshness and bundle integrity before promotion.
  } finally { await pool.end(); await client.end(); }
  // Superusers are the only clients permitted until every recognized deletion is applied.
  await writeFile(join(output, "restore-state.json"), JSON.stringify({ database, bundle_id: manifest.bundle_id, privacy_applied: true }) + "\n", { mode: 0o600 });
  await input.admin.query(`ALTER DATABASE "${database}" CONNECTION LIMIT -1`);
  return { ready: true, database, tenants: tenants.length, privacy_requests: privacyRequests,
    metrics_recalculated: recalculated, traffic_restart: "manual" };
}
