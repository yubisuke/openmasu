import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { jcs as canonicalize } from "@openmasu/attribution-core/canonical";
import { parseMapping, type ImportMapping } from "@openmasu/contracts/import-mapping";
import { compareImportHeaders, createImportHeaderManifest, ImportHeaderError, type ImportHeaderManifest } from "@openmasu/contracts/import-mapping-headers";
import { uuidV7, withTenant, type PayloadStore } from "./index.js";

type Scope = Readonly<{ tenantId: string; appId: string }>;
export type ImportMappingMetadata = {
  mapping_id: string; revision: number; kind: ImportMapping["kind"]; mapping_digest: string;
  definition_digest: string; header_count: number; created_at: string;
};
type Definition = { mapping: ImportMapping; approved_manifest: ImportHeaderManifest };
export class ImportMappingRegistryError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
const invalid = (): never => { throw new ImportMappingRegistryError("import_mapping_invalid"); };
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const columns = "mapping_id,revision,kind,mapping_digest,definition_digest,header_count,created_at";
export const importMappingMaximumBytes = 32 * 1024;

/** Managed HTTP admission is narrower than the existing local-file DSL. */
function boundedObject(value: unknown): Record<string, unknown> {
  let count = 0;
  const visit = (item: unknown, depth: number): void => {
    if (++count > 4096 || depth > 16) invalid();
    if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) invalid();
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > importMappingMaximumBytes) {
    throw new ImportMappingRegistryError("import_mapping_too_large", 413);
  }
  return value as Record<string, unknown>;
}

export function importMappingSelection(value: unknown): { mapping_id: string; revision: number } {
  const body = boundedObject(value);
  if (typeof body.mapping_id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.mapping_id)
      || /[\r\n]/.test(body.mapping_id) || !Number.isInteger(body.revision)
      || Number(body.revision) < 1 || Number(body.revision) > 2147483647) invalid();
  return { mapping_id: body.mapping_id as string, revision: Number(body.revision) };
}

function managedMapping(value: unknown, scope: Scope): ImportMapping {
  const body = boundedObject(value);
  // The legacy file parser reads the selected event schema. Never allow HTTP input
  // to turn that filename into a path before the existing schema validation runs.
  if (Array.isArray(body.rules)) for (const rule of body.rules) {
    const name = rule?.target === "event_name" ? rule.expression?.const : undefined;
    if (name !== undefined && (typeof name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(name) || /[\r\n]/.test(name))) invalid();
    if (typeof rule?.target === "string" && rule.target.split(".").some((part: string) => ["constructor", "prototype"].includes(part))) invalid();
  }
  try {
    const mapping = parseMapping(body);
    if (mapping.format !== "csv" || mapping.tenant_id !== scope.tenantId || mapping.app_id !== scope.appId) invalid();
    return mapping;
  } catch { return invalid(); }
}

function headerFailure(error: unknown): never {
  if (error instanceof ImportHeaderError) throw new ImportMappingRegistryError(`import_${error.code}`, error.code === "header_limits_exceeded" ? 413 : 400);
  throw error;
}

export function prepareImportMappingRevision(scope: Scope, value: unknown) {
  const body = boundedObject(value);
  if (Object.keys(body).some(key => !["mapping_id", "revision", "mapping", "approved_headers"].includes(key))) invalid();
  const selection = importMappingSelection(body);
  const mapping = managedMapping(body.mapping, scope);
  let manifest: ImportHeaderManifest;
  try { manifest = createImportHeaderManifest(mapping, body.approved_headers as string[]); } catch (error) { return headerFailure(error); }
  if (compareImportHeaders(mapping, manifest, manifest.columns).required_sources_missing > 0) {
    throw new ImportMappingRegistryError("import_mapping_required_sources_missing");
  }
  const definition: Definition = { mapping, approved_manifest: manifest };
  const bytes = Buffer.from(canonicalize(definition));
  if (bytes.length > importMappingMaximumBytes) throw new ImportMappingRegistryError("import_mapping_too_large", 413);
  return { ...selection, definition, bytes, mapping_digest: digest(canonicalize(mapping)), definition_digest: digest(bytes) };
}

/** Explicit revisions are immutable, sequential, app-scoped, and never automatically activated. */
export async function registerImportMappingRevision(options: {
  pool: Pool; payloadStore: PayloadStore; scope: Scope; body: unknown; now?: Date;
  onRegistered?: (client: PoolClient, metadata: ImportMappingMetadata) => Promise<void>;
}): Promise<ImportMappingMetadata> {
  const prepared = prepareImportMappingRevision(options.scope, options.body);
  const { tenantId, appId } = options.scope;
  let protectedRef: string | undefined;
  try {
    return await withTenant(options.pool, tenantId, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([tenantId, appId, "import-mapping-registry"])]);
      const existing = (await client.query<ImportMappingMetadata>(`SELECT ${columns} FROM control.import_mapping_revisions
        WHERE tenant_id=$1 AND app_id=$2 AND mapping_id=$3 AND revision=$4`, [tenantId, appId, prepared.mapping_id, prepared.revision])).rows[0];
      if (existing) {
        if (existing.definition_digest !== prepared.definition_digest) throw new ImportMappingRegistryError("import_mapping_revision_conflict", 409);
        return existing;
      }
      const state = (await client.query<{ total: number; latest: number }>(`SELECT count(*)::int AS total,
        COALESCE(max(revision) FILTER (WHERE mapping_id=$3),0)::int AS latest
        FROM control.import_mapping_revisions WHERE tenant_id=$1 AND app_id=$2`, [tenantId, appId, prepared.mapping_id])).rows[0];
      if (prepared.revision !== state.latest + 1) throw new ImportMappingRegistryError("import_mapping_revision_conflict", 409);
      if (state.total >= 1000) throw new ImportMappingRegistryError("import_mapping_capacity_reached", 409);
      protectedRef = await options.payloadStore.write({ tenantId, appId, objectId: `mapping-${uuidV7()}` }, prepared.bytes);
      const row = (await client.query<ImportMappingMetadata>(`INSERT INTO control.import_mapping_revisions
        (tenant_id,app_id,mapping_id,revision,kind,mapping_digest,definition_digest,protected_ref,header_count,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${columns}`,
      [tenantId, appId, prepared.mapping_id, prepared.revision, prepared.definition.mapping.kind, prepared.mapping_digest,
        prepared.definition_digest, protectedRef, prepared.definition.approved_manifest.columns.length, (options.now ?? new Date()).toISOString()])).rows[0];
      await options.onRegistered?.(client, row);
      return row;
    });
  } catch (error) {
    if (protectedRef) {
      // A lost COMMIT response must not erase a definition that actually committed.
      const stored = await withTenant(options.pool, tenantId, client => client.query(
        "SELECT 1 FROM control.import_mapping_revisions WHERE tenant_id=$1 AND app_id=$2 AND protected_ref=$3",
        [tenantId, appId, protectedRef])).catch(() => undefined);
      if (stored?.rowCount === 0) await options.payloadStore.purge(protectedRef).catch(() => undefined);
    }
    throw error;
  }
}

export async function listImportMappingRevisions(pool: Pool, scope: Scope, params: URLSearchParams) {
  if ([...params.keys()].some(key => !["mapping_id", "after_revision"].includes(key) || params.getAll(key).length !== 1)) invalid();
  const id = params.get("mapping_id"), after = params.get("after_revision") ?? "0";
  if (id !== null && (!/^[A-Za-z0-9._:-]{1,128}$/.test(id) || /[\r\n]/.test(id))
      || !/^(0|[1-9][0-9]{0,9})$/.test(after) || Number(after) > 2147483647 || id === null && after !== "0") invalid();
  return withTenant(pool, scope.tenantId, async client => {
    const data = (await client.query<ImportMappingMetadata>(id === null
      ? `SELECT DISTINCT ON (mapping_id COLLATE "C") ${columns} FROM control.import_mapping_revisions
          WHERE tenant_id=$1 AND app_id=$2 ORDER BY mapping_id COLLATE "C",revision DESC LIMIT 1001`
      : `SELECT ${columns} FROM control.import_mapping_revisions WHERE tenant_id=$1 AND app_id=$2 AND mapping_id=$3 AND revision>$4
          ORDER BY revision LIMIT 101`, id === null ? [scope.tenantId, scope.appId] : [scope.tenantId, scope.appId, id, Number(after)])).rows;
    const limit = id === null ? 1000 : 100;
    return { data: data.slice(0, limit), next_revision: id !== null && data.length > limit ? data[limit - 1].revision : null };
  });
}

/** Writer-only lookup; the caller still authorizes its app before this function. */
export async function loadImportMappingRevision(pool: Pool, payloadStore: PayloadStore, scope: Scope, selection: { mapping_id: string; revision: number }) {
  importMappingSelection(selection);
  const row = await withTenant(pool, scope.tenantId, async client => (await client.query<ImportMappingMetadata & { protected_ref: string }>(
    `SELECT ${columns},protected_ref FROM control.import_mapping_revisions WHERE tenant_id=$1 AND app_id=$2 AND mapping_id=$3 AND revision=$4`,
    [scope.tenantId, scope.appId, selection.mapping_id, selection.revision])).rows[0]);
  if (!row) throw new ImportMappingRegistryError("import_mapping_not_found", 404);
  try {
    const bytes = await payloadStore.read(row.protected_ref);
    if (bytes.length > importMappingMaximumBytes || digest(bytes) !== row.definition_digest) throw Error("integrity");
    const definition = JSON.parse(bytes.toString("utf8")) as Definition;
    const mapping = managedMapping(definition.mapping, scope);
    const manifest = createImportHeaderManifest(mapping, definition.approved_manifest.columns);
    if (canonicalize(manifest) !== canonicalize(definition.approved_manifest) || digest(canonicalize(mapping)) !== row.mapping_digest) throw Error("integrity");
    const { protected_ref: _private, ...metadata } = row;
    return { metadata, mapping, approved_manifest: manifest, mappingBytes: Buffer.from(canonicalize(mapping)) };
  } catch { throw new ImportMappingRegistryError("import_mapping_unavailable", 503); }
}

export async function previewImportMappingHeaders(pool: Pool, payloadStore: PayloadStore, scope: Scope, value: unknown) {
  const body = boundedObject(value);
  if (Object.keys(body).some(key => !["mapping_id", "revision", "headers", "candidate_mapping"].includes(key))) invalid();
  const selected = await loadImportMappingRevision(pool, payloadStore, scope, importMappingSelection(body));
  const mapping = body.candidate_mapping === undefined ? selected.mapping : managedMapping(body.candidate_mapping, scope);
  try {
    return { ...selected.metadata, persistence: "none" as const,
      comparison: compareImportHeaders(mapping, selected.approved_manifest, body.headers as string[]) };
  } catch (error) { return headerFailure(error); }
}
