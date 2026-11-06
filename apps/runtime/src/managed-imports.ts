import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { compareImportHeaders } from "@openmasu/contracts/import-mapping-headers";
import { uuidV7, withTenant, type PayloadStore } from "./index.js";
import { acquirePrivacyTenantXactFence } from "./privacy-fence.js";
import { parseCsvHeader } from "./import-normalization.js";
import { importMappingSelection, loadImportMappingRevision } from "./import-mapping-registry.js";

export const managedImportLimits = { maxBytes: 4 * 1024 * 1024, maxRows: 10_000, maxRowBytes: 64 * 1024 } as const;
export type ImportScope = { tenantId: string; appId: string };
export type ManagedPreview = {
  rows: { read: number; selected: number; filtered: number; accepted: number; rejected: number };
  rejections: Array<{ reason_code: string; count: number }>;
  compatibility: string; execution_ready: boolean;
};
export type ManagedImportResult = { import_run_id: string; rows: number; accepted: number; rejected: number; status: string };
export type ManagedUpload = {
  upload_id: string; mapping_id: string; revision: number; mapping_digest: string; source_digest: string;
  confirmation_digest: string; source_bytes: number; state: string; preview: ManagedPreview | null;
  result: ManagedImportResult | null; safe_reason: string | null; attempts: number; created_at: string; expires_at: string;
};
export class ManagedImportError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export const sourceDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const columns = "upload_id::text,mapping_id,revision,mapping_digest,source_digest,confirmation_digest,source_bytes,state,preview,result,safe_reason,attempts,created_at,expires_at";
export function managedUploadId(value: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new ManagedImportError("import_upload_not_found", 404);
  return value;
}
export async function listManagedUploads(pool: Pool, scope: ImportScope): Promise<ManagedUpload[]> {
  return withTenant(pool, scope.tenantId, async client => (await client.query<ManagedUpload>(
    `SELECT ${columns} FROM ephemeral.managed_import_uploads WHERE tenant_id=$1 AND app_id=$2 ORDER BY created_at DESC,upload_id DESC LIMIT 100`,
    [scope.tenantId, scope.appId])).rows);
}
export async function readManagedUpload(pool: Pool, scope: ImportScope, id: string): Promise<ManagedUpload> {
  const row = await withTenant(pool, scope.tenantId, async client => (await client.query<ManagedUpload>(
    `SELECT ${columns} FROM ephemeral.managed_import_uploads WHERE tenant_id=$1 AND app_id=$2 AND upload_id=$3`,
    [scope.tenantId, scope.appId, managedUploadId(id)])).rows[0]);
  if (!row) throw new ManagedImportError("import_upload_not_found", 404);
  return row;
}
export async function createManagedUpload(pool: Pool, store: PayloadStore, scope: ImportScope, selection: unknown,
  source: Buffer, now = new Date(), onUploaded?: (client: PoolClient, id: string) => Promise<void>): Promise<string> {
  if (!source.length || source.length > managedImportLimits.maxBytes) throw new ManagedImportError("import_upload_size", 413);
  const selected = await loadImportMappingRevision(pool, store, scope, importMappingSelection(selection));
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
    const comparison = compareImportHeaders(selected.mapping, selected.approved_manifest, parseCsvHeader(text));
    if (comparison.required_sources_missing) throw Error("missing");
  } catch { throw new ManagedImportError("import_upload_header_invalid"); }
  const id = uuidV7(), digest = sourceDigest(source), at = now.toISOString();
  const confirmation = sha256(["managed-csv-v1", scope.tenantId, scope.appId, id, selected.metadata.mapping_digest, digest]);
  let reference: string | undefined;
  try {
    await withTenant(pool, scope.tenantId, async client => {
      await acquirePrivacyTenantXactFence(client, scope.tenantId, "shared");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([scope.tenantId, scope.appId, "managed-upload"])]);
      const count = (await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM ephemeral.managed_import_uploads
        WHERE tenant_id=$1 AND app_id=$2 AND protected_ref IS NOT NULL`, [scope.tenantId, scope.appId])).rows[0].count;
      if (count >= 10) throw new ManagedImportError("import_upload_capacity", 409);
      reference = await store.write({ ...scope, objectId: `managed-import-${id}` }, source);
      await client.query(`INSERT INTO ephemeral.managed_import_uploads
        (upload_id,tenant_id,app_id,mapping_id,revision,mapping_digest,source_digest,confirmation_digest,source_bytes,protected_ref,state,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'uploaded',$11,$12)`,
      [id,scope.tenantId,scope.appId,selected.metadata.mapping_id,selected.metadata.revision,selected.metadata.mapping_digest,
        digest,confirmation,source.length,reference,at,new Date(now.valueOf()+86_400_000).toISOString()]);
      await onUploaded?.(client, id);
    });
    return id;
  } catch (error) {
    // Do not erase bytes after an uncertain COMMIT; the bounded worker owns expiry.
    if (reference) {
      const exists = await withTenant(pool, scope.tenantId, client => client.query(
        "SELECT 1 FROM ephemeral.managed_import_uploads WHERE tenant_id=$1 AND app_id=$2 AND upload_id=$3", [scope.tenantId,scope.appId,id])).catch(() => undefined);
      if (exists?.rowCount === 0) await store.purge(reference).catch(() => undefined);
    }
    throw error;
  }
}
export async function loadManagedUploadBytes(pool: Pool, store: PayloadStore, scope: ImportScope, row: ManagedUpload) {
  const selected = await loadImportMappingRevision(pool, store, scope, row);
  const reference = await withTenant(pool, scope.tenantId, async client => (await client.query<{ protected_ref: string | null }>(
    "SELECT protected_ref FROM ephemeral.managed_import_uploads WHERE tenant_id=$1 AND app_id=$2 AND upload_id=$3",
    [scope.tenantId,scope.appId,row.upload_id])).rows[0]?.protected_ref);
  if (!reference || selected.metadata.mapping_digest !== row.mapping_digest) throw new ManagedImportError("import_upload_unavailable", 409);
  let bytes: Buffer;
  try { bytes = await store.read(reference); } catch { throw new ManagedImportError("import_upload_unavailable", 409); }
  if (bytes.length !== row.source_bytes || sourceDigest(bytes) !== row.source_digest) throw new ManagedImportError("import_upload_changed", 409);
  return { ...selected, bytes };
}
export async function confirmManagedUpload(pool: Pool, store: PayloadStore, scope: ImportScope, id: string, token: string,
  now = new Date(), onConfirmed?: (client: PoolClient, id: string) => Promise<void>): Promise<void> {
  const row = await readManagedUpload(pool, scope, id);
  if (token !== row.confirmation_digest) throw new ManagedImportError("import_confirmation_changed", 409);
  if (row.state === "completed") return;
  if (row.expires_at <= now.toISOString()) throw new ManagedImportError("import_upload_expired", 410);
  if (!row.preview?.execution_ready || !["previewed","queued","importing"].includes(row.state)) throw new ManagedImportError("import_preview_required", 409);
  const selected = await loadManagedUploadBytes(pool, store, scope, row);
  await withTenant(pool, scope.tenantId, async client => {
    await acquirePrivacyTenantXactFence(client, scope.tenantId, "shared");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([scope.tenantId,scope.appId,selected.mapping.source_id,row.source_digest])]);
    const current = (await client.query<{ state: string }>(`SELECT state FROM ephemeral.managed_import_uploads
      WHERE tenant_id=$1 AND app_id=$2 AND upload_id=$3 FOR UPDATE`, [scope.tenantId,scope.appId,id])).rows[0];
    if (!current || !["previewed","queued","importing","completed"].includes(current.state)) throw new ManagedImportError("import_upload_unavailable", 409);
    if (["completed","queued","importing"].includes(current.state)) return;
    const keys = [scope.tenantId,scope.appId,selected.mapping.source_id,row.source_digest];
    const prior = (await client.query<{ mapping_digest: string; result: ManagedImportResult | null }>(
      "SELECT mapping_digest,result FROM control.managed_import_receipts WHERE tenant_id=$1 AND app_id=$2 AND source_id=$3 AND source_digest=$4", keys)).rows[0];
    if (prior && prior.mapping_digest !== row.mapping_digest) throw new ManagedImportError("import_mapping_binding_conflict", 409);
    if (!prior) {
      if ((await client.query("SELECT 1 FROM control.import_files WHERE tenant_id=$1 AND app_id=$2 AND source_id=$3 AND file_digest=$4", keys)).rowCount) {
        throw new ManagedImportError("import_existing_file_unbound", 409);
      }
      await client.query(`INSERT INTO control.managed_import_receipts (tenant_id,app_id,source_id,source_digest,mapping_digest,received_at)
        VALUES ($1,$2,$3,$4,$5,$6)`, [...keys,row.mapping_digest,now.toISOString()]);
    }
    await client.query(`UPDATE ephemeral.managed_import_uploads SET state=$4,result=$5::jsonb
      WHERE tenant_id=$1 AND app_id=$2 AND upload_id=$3`, [scope.tenantId,scope.appId,id,prior?.result ? "completed" : "queued",prior?.result ?? null]);
    await onConfirmed?.(client, id);
  });
}
/** Called inside the importer's own terminal transaction, never an outer transaction. */
export async function completeManagedImport(client: PoolClient, scope: ImportScope, row: ManagedUpload, sourceId: string, result: ManagedImportResult) {
  const changed = await client.query(`UPDATE ephemeral.managed_import_uploads SET state='completed',result=$4::jsonb,safe_reason=NULL
    WHERE tenant_id=$1 AND app_id=$2 AND upload_id=$3 AND state='importing'`, [scope.tenantId,scope.appId,row.upload_id,result]);
  if (changed.rowCount !== 1) throw new ManagedImportError("import_upload_unavailable", 409);
  await client.query(`UPDATE control.managed_import_receipts SET result=$6::jsonb
    WHERE tenant_id=$1 AND app_id=$2 AND source_id=$3 AND source_digest=$4 AND mapping_digest=$5 AND result IS NULL`,
  [scope.tenantId,scope.appId,sourceId,row.source_digest,row.mapping_digest,result]);
}
/** The existing worker calls this under its tenant fence; GETs never delete or write. */
export async function sweepManagedUploads(pool: Pool, store: PayloadStore, tenantId: string, now = new Date()) {
  const candidates = await withTenant(pool, tenantId, async client => (await client.query<{ upload_id: string; protected_ref: string }>(
    `SELECT upload_id::text,protected_ref FROM ephemeral.managed_import_uploads WHERE tenant_id=$1 AND protected_ref IS NOT NULL
      AND (expires_at<=$2 OR state IN ('completed','blocked','failed','expired')) ORDER BY created_at LIMIT 100`, [tenantId,now.toISOString()])).rows);
  for (const row of candidates) {
    await store.purge(row.protected_ref);
    await withTenant(pool, tenantId, client => client.query(`UPDATE ephemeral.managed_import_uploads SET protected_ref=NULL,
      state=CASE WHEN state IN ('uploaded','previewed','queued','importing') THEN 'expired' ELSE state END
      WHERE tenant_id=$1 AND upload_id=$2 AND protected_ref=$3`, [tenantId,row.upload_id,row.protected_ref]));
  }
  await withTenant(pool, tenantId, client => client.query(`DELETE FROM ephemeral.managed_import_uploads WHERE upload_id IN (
    SELECT upload_id FROM ephemeral.managed_import_uploads WHERE tenant_id=$1 AND protected_ref IS NULL AND created_at<$2 ORDER BY created_at LIMIT 100)`,
  [tenantId,new Date(now.valueOf()-7*86_400_000).toISOString()]));
}
