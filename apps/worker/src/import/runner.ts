import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Pool } from "pg";
import { sha256, type CandidateAttempt } from "@openmasu/attribution-core";
import { validateEventPayload } from "@openmasu/contracts";
import {
  createAppPool,
  recordJobOutcome,
  runWithTerminalJobOutcome,
  uuidV7,
  withTenant,
} from "@openmasu/runtime";
import { ingestRuntimeBatch, type RuntimeIngestionResult } from "../ingestion.js";
import {
  lintMappings,
  loadMapping,
  loadMappingScope,
  mapRow,
  MappingError,
  rowMatches,
  type ImportMapping,
} from "./mapping.js";
import { ImportLimitError, readRows, type ImportLimits } from "./source.js";
import { declaredMappingTargetFields } from "./compatibility.js";

type Any = Record<string, any>;

export type ImportSummary = {
  status: "completed" | "skipped";
  import_run_id: string;
  rows: number;
  accepted: number;
  rejected: number;
  deliveries: number;
  logical_events: number;
};

export type ImportPreviewSummary = {
  mode: "preview";
  persistence: "none";
  mapping_version: string;
  format: ImportMapping["format"];
  rows: {
    read: number;
    selected: number;
    filtered: number;
    accepted: number;
    rejected: number;
  };
  warnings: Array<{ code: string }>;
  rejections: Array<{
    reason_code: "mapping_validation_failed" | "timestamp_invalid" | "row_schema_invalid";
    count: number;
    fields: string[];
  }>;
  limitations: [
    "database_identity_conflicts_not_checked",
    "provider_connectivity_not_checked",
  ];
};

export type ImportPreviewAnalysis = {
  preview: ImportPreviewSummary;
  mapping: ImportMapping;
  observedFieldCounts: ReadonlyMap<string, number>;
};

const importMetadataChunkSize = 1_000;
const importEvaluationChunkSize = 5_000;

async function insertMetadataRows(client: import("pg").PoolClient, rows: readonly Any[], statement: string): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += importMetadataChunkSize) {
    await client.query(statement, [JSON.stringify(rows.slice(offset, offset + importMetadataChunkSize))]);
  }
}

export const defaultImportLimits: ImportLimits = {
  maxBytes: 4 * 1024 * 1024 * 1024,
  maxRows: 20_000_000,
  maxRowBytes: 64 * 1024,
};

function canonicalNow(value = new Date()): string { return value.toISOString(); }

function identifier(prefix: string, value: unknown): string {
  return `${prefix}:${sha256(value).slice(0, 48)}`;
}

function limitsFromEnvironment(): ImportLimits {
  const integer = (name: string, configured: string | undefined, fallback: number): number => {
    const value = Number(configured ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
    return value;
  };
  return {
    maxBytes: integer("OPENMASU_IMPORT_MAX_BYTES", process.env.OPENMASU_IMPORT_MAX_BYTES, defaultImportLimits.maxBytes),
    maxRows: integer("OPENMASU_IMPORT_MAX_ROWS", process.env.OPENMASU_IMPORT_MAX_ROWS, defaultImportLimits.maxRows),
    maxRowBytes: integer("OPENMASU_IMPORT_MAX_ROW_BYTES", process.env.OPENMASU_IMPORT_MAX_ROW_BYTES, defaultImportLimits.maxRowBytes),
  };
}

function toAttempt(mapping: ImportMapping, mapped: Any, fileDigest: string, rowOrdinal: number, receivedAt: string): CandidateAttempt {
  const eventName = mapped.event_name;
  if (typeof eventName !== "string") throw new MappingError("mapped event_name is missing", ["event_name"]);
  if (!mapped.payload || typeof mapped.payload !== "object" || Array.isArray(mapped.payload)) {
    throw new MappingError("mapped payload is missing", ["payload"]);
  }
  const eventId = String(mapped.event_id ?? "");
  if (!eventId) throw new MappingError("mapped event_id is missing", ["event_id"]);
  const occurredAt = String(mapped.occurred_at ?? "");
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) {
    throw new MappingError("mapped occurred_at is invalid", ["occurred_at"]);
  }
  const record = {
    contract_version: "0.4.0",
    record_id: identifier("record", [mapping.source_id, fileDigest, rowOrdinal]),
    delivery_id: identifier("delivery", [fileDigest, rowOrdinal]),
    tenant_id: mapping.tenant_id,
    app_id: mapping.app_id,
    producer: `import:${mapping.provider}`,
    producer_version: `mapping:${mapping.version}`,
    event_id: eventId,
    event_name: eventName,
    schema_version: "0.4.0",
    occurred_at: new Date(occurredAt).toISOString(),
    occurred_at_source: "import",
    received_at: receivedAt,
    processing_purpose_id: String(mapped.processing_purpose_id ?? "analytics"),
    processing_sequence: rowOrdinal + 1,
    payload: mapped.payload,
  };
  return {
    server: {
      tenant_id: mapping.tenant_id,
      app_id: mapping.app_id,
      received_at: receivedAt,
      policy_digest: "runtime-import-policy-v0.2",
      processing_purposes: [{
        processing_purpose_id: record.processing_purpose_id,
        consent_required: false,
        policy_version: "runtime-consent-v0.2",
      }],
      withdrawals: [],
      alternative_legal_bases: [],
    },
    record,
    batch_id: identifier("batch", [mapping.source_id, fileDigest]),
  };
}

export function analyzeMmpImport(options: {
  mappingPath: string;
  filePath: string;
  limits?: ImportLimits;
  lintDirectory?: string;
}): ImportPreviewAnalysis {
  const mapping = loadMapping(options.mappingPath);
  if (mapping.kind !== "mmp_raw") throw new Error("previewMmpImport requires an mmp_raw mapping");
  const loaded = readRows(options.filePath, mapping, options.limits ?? limitsFromEnvironment());
  const fileDigest = createHash("sha256").update(readFileSync(options.filePath)).digest("hex");
  const rejectionGroups = new Map<string, {
    reason_code: "mapping_validation_failed" | "timestamp_invalid" | "row_schema_invalid";
    count: number;
    fields: Set<string>;
  }>();
  let selected = 0;
  let accepted = 0;
  const observedFieldCounts = new Map<string, number>();
  const targetFields = declaredMappingTargetFields(mapping);
  const targetValue = (attempt: CandidateAttempt, target: string): unknown => {
    const parts = target.split(".");
    let value: unknown = parts[0] === "payload" ? attempt.record.payload : attempt.record[parts[0]!];
    for (const part of parts.slice(1)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      value = (value as Any)[part];
    }
    return value;
  };
  const reject = (
    reasonCode: "mapping_validation_failed" | "timestamp_invalid" | "row_schema_invalid",
    fields: readonly string[],
  ): void => {
    const group = rejectionGroups.get(reasonCode) ?? {
      reason_code: reasonCode,
      count: 0,
      fields: new Set<string>(),
    };
    group.count += 1;
    for (const field of fields) group.fields.add(field);
    rejectionGroups.set(reasonCode, group);
  };

  for (const [ordinal, row] of loaded.rows.entries()) {
    if (!rowMatches(mapping, row)) continue;
    selected += 1;
    try {
      const attempt = toAttempt(
        mapping,
        mapRow(mapping, row),
        fileDigest,
        ordinal,
        "2000-01-01T00:00:00.000Z",
      );
      const validation = validateEventPayload(String(attempt.record.event_name), attempt.record.payload);
      if (validation.valid) {
        accepted += 1;
        for (const field of targetFields) {
          const value = targetValue(attempt, field);
          if (value !== undefined && value !== null && value !== "") {
            observedFieldCounts.set(field, (observedFieldCounts.get(field) ?? 0) + 1);
          }
        }
      } else reject("row_schema_invalid", validation.fields);
    } catch (error) {
      const mappingError = error instanceof MappingError ? error : new MappingError("row mapping failed");
      reject(
        mappingError.message.includes("timestamp") ? "timestamp_invalid" : "mapping_validation_failed",
        mappingError.fields,
      );
    }
  }

  const warnings = lintMappings(mappingsForLint(options.mappingPath, options.lintDirectory))
    .map(({ code }) => ({ code }))
    .sort((left, right) => left.code.localeCompare(right.code));
  const rejections = [...rejectionGroups.values()]
    .map(({ reason_code, count, fields }) => ({ reason_code, count, fields: [...fields].sort() }))
    .sort((left, right) => left.reason_code.localeCompare(right.reason_code));
  const rows = {
    read: loaded.rows.length,
    selected,
    filtered: loaded.rows.length - selected,
    accepted,
    rejected: selected - accepted,
  };
  return {
    mapping,
    observedFieldCounts,
    preview: {
      mode: "preview",
      persistence: "none",
      mapping_version: mapping.version,
      format: mapping.format,
      rows,
      warnings,
      rejections,
      limitations: [
        "database_identity_conflicts_not_checked",
        "provider_connectivity_not_checked",
      ],
    },
  };
}

export function previewMmpImport(options: Parameters<typeof analyzeMmpImport>[0]): ImportPreviewSummary {
  return analyzeMmpImport(options).preview;
}

async function ensureApp(pool: Pool, mapping: ImportMapping, now: string): Promise<void> {
  await withTenant(pool, mapping.tenant_id, (client) => client.query(
    `INSERT INTO control.apps (tenant_id, app_id, created_at)
     VALUES ($1,$2,$3) ON CONFLICT (tenant_id, app_id) DO NOTHING`,
    [mapping.tenant_id, mapping.app_id, now],
  ).then(() => undefined));
}

async function historicalAttempts(
  pool: Pool,
  mapping: ImportMapping,
  eventIds: readonly string[],
): Promise<CandidateAttempt[]> {
  if (eventIds.length === 0) return [];
  return withTenant(pool, mapping.tenant_id, async (client) => {
    const result = await client.query<{ server_context: Any; record: Any; import_run_id: string }>(
      `SELECT server_context, record, import_run_id::text
       FROM control.import_attempts
       WHERE tenant_id=$1 AND app_id=$2 AND record->>'producer'=$3
         AND record->>'event_id'=ANY($4::text[])
       ORDER BY created_at, row_ordinal, import_attempt_id`,
      [mapping.tenant_id, mapping.app_id, `import:${mapping.provider}`, eventIds],
    );
    return result.rows.map((row) => ({ server: row.server_context, record: row.record, batch_id: row.import_run_id }));
  });
}

export async function runMmpImport(options: {
  pool: Pool;
  mappingPath: string;
  filePath: string;
  limits?: ImportLimits;
  now?: Date;
}): Promise<ImportSummary> {
  const mapping = loadMapping(options.mappingPath);
  if (mapping.kind !== "mmp_raw") throw new Error("runMmpImport requires an mmp_raw mapping");
  const limits = options.limits ?? limitsFromEnvironment();
  const loaded = readRows(options.filePath, mapping, limits);
  const fileDigest = createHash("sha256").update(readFileSync(options.filePath)).digest("hex");
  const now = canonicalNow(options.now);
  await ensureApp(options.pool, mapping, now);
  const prior = await withTenant(options.pool, mapping.tenant_id, (client) => client.query(
    `SELECT import_file_id FROM control.import_files
     WHERE tenant_id=$1 AND app_id=$2 AND source_id=$3 AND file_digest=$4`,
    [mapping.tenant_id, mapping.app_id, mapping.source_id, fileDigest],
  ));
  const runId = uuidV7(options.now?.valueOf());
  if (prior.rowCount) {
    await withTenant(options.pool, mapping.tenant_id, (client) => client.query(
      `INSERT INTO control.import_runs (
        import_run_id, tenant_id, app_id, source_id, source_snapshot_digest,
        status, started_at, completed_at
      ) VALUES ($1,$2,$3,$4,$5,'skipped',$6,$6)`,
      [runId, mapping.tenant_id, mapping.app_id, mapping.source_id, fileDigest, now],
    ).then(() => undefined));
    return { status: "skipped", import_run_id: runId, rows: loaded.rows.length, accepted: 0, rejected: 0, deliveries: 0, logical_events: 0 };
  }

  const attemptRows: Array<{ ordinal: number; attempt: CandidateAttempt }> = [];
  const failures: Array<{ ordinal: number; reason: string; fields: string[] }> = [];
  for (const [ordinal, row] of loaded.rows.entries()) {
    if (!rowMatches(mapping, row)) continue;
    try {
      attemptRows.push({ ordinal, attempt: toAttempt(mapping, mapRow(mapping, row), fileDigest, ordinal, now) });
    } catch (error) {
      const mappingError = error instanceof MappingError ? error : new MappingError("row mapping failed");
      failures.push({ ordinal, reason: mappingError.message.includes("timestamp") ? "timestamp_invalid" : "mapping_validation_failed", fields: mappingError.fields });
    }
  }
  try {
    const eventIds = [...new Set(attemptRows.map(({ attempt }) => String(attempt.record.event_id)))];
    const history = await historicalAttempts(options.pool, mapping, eventIds);
    const historyByEventId = new Map<string, CandidateAttempt[]>();
    const appendHistory = (attempt: CandidateAttempt): void => {
      const key = String(attempt.record.event_id);
      const values = historyByEventId.get(key) ?? [];
      values.push(attempt);
      historyByEventId.set(key, values);
    };
    for (const attempt of history) appendHistory(attempt);
    const validationFailures: RuntimeIngestionResult["validation_failures"] = [];
    let deliveries = 0;
    let logicalEvents = 0;
    for (let offset = 0; offset < attemptRows.length; offset += importEvaluationChunkSize) {
      const chunkRows = attemptRows.slice(offset, offset + importEvaluationChunkSize);
      const chunkAttempts = chunkRows.map(({ attempt }) => attempt);
      const chunkEventIds = new Set(chunkAttempts.map((attempt) => String(attempt.record.event_id)));
      const chunkHistory = [...chunkEventIds].flatMap((eventId) => historyByEventId.get(eventId) ?? []);
      const output = await ingestRuntimeBatch(chunkAttempts, options.pool, chunkHistory, { bulkPersistence: true });
      validationFailures.push(...output.validation_failures);
      deliveries += output.deliveries.length;
      logicalEvents += output.logical_events.length;
      const invalidChunkKeys = new Set(output.validation_failures.map((failure) =>
        `${failure.record_id}\u0000${failure.delivery_id}`));
      for (const attempt of chunkAttempts) {
        if (!invalidChunkKeys.has(`${attempt.record.record_id}\u0000${attempt.record.delivery_id}`)) appendHistory(attempt);
      }
    }
    const invalidKeys = new Set(validationFailures.map((failure) => `${failure.record_id}\u0000${failure.delivery_id}`));
    const acceptedRows = attemptRows.filter(({ attempt }) => !invalidKeys.has(`${attempt.record.record_id}\u0000${attempt.record.delivery_id}`));
    const rowByAttempt = new Map(attemptRows.map(({ ordinal, attempt }) => [
      `${attempt.record.record_id}\u0000${attempt.record.delivery_id}`,
      ordinal,
    ]));
    const allFailures = [
      ...failures,
      ...validationFailures.map((failure) => ({
        ordinal: rowByAttempt.get(`${failure.record_id}\u0000${failure.delivery_id}`)!,
        reason: "row_schema_invalid",
        fields: [...failure.fields],
      })),
    ];
    // import_runs is append-only: publish the terminal state in the same transaction as
    // the file, attempt, and row-rejection artifacts instead of mutating a running row.
    await withTenant(options.pool, mapping.tenant_id, async (client) => {
      await client.query(
        `INSERT INTO control.import_runs (
          import_run_id, tenant_id, app_id, source_id, source_snapshot_digest,
          status, started_at, completed_at
        ) VALUES ($1,$2,$3,$4,$5,'completed',$6,$6)`,
        [runId, mapping.tenant_id, mapping.app_id, mapping.source_id, fileDigest, now],
      );
      await client.query(
        `INSERT INTO control.import_files (
          import_file_id, tenant_id, app_id, source_id, file_digest, file_bytes,
          row_count, first_seen_at, import_run_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uuidV7(options.now?.valueOf()), mapping.tenant_id, mapping.app_id, mapping.source_id, fileDigest, loaded.bytes, loaded.rows.length, now, runId],
      );
      await insertMetadataRows(client, acceptedRows.map(({ ordinal, attempt }) => ({
        import_attempt_id: uuidV7(), import_run_id: runId, tenant_id: mapping.tenant_id,
        app_id: mapping.app_id, source_id: mapping.source_id, row_ordinal: ordinal,
        server_context: attempt.server, record: attempt.record, created_at: now,
      })), `INSERT INTO control.import_attempts (
        import_attempt_id,import_run_id,tenant_id,app_id,source_id,row_ordinal,server_context,record,created_at)
        SELECT import_attempt_id,import_run_id,tenant_id,app_id,source_id,row_ordinal,server_context,record,created_at
        FROM jsonb_populate_recordset(NULL::control.import_attempts,$1::jsonb)`);
      await insertMetadataRows(client, allFailures.map((failure) => ({
        import_rejection_id: uuidV7(), import_run_id: runId, tenant_id: mapping.tenant_id,
        app_id: mapping.app_id, source_id: mapping.source_id, row_ordinal: failure.ordinal,
        reason_code: failure.reason, field_names: failure.fields, occurred_at: now,
      })), `INSERT INTO control.import_row_rejections (
        import_rejection_id,import_run_id,tenant_id,app_id,source_id,row_ordinal,reason_code,field_names,occurred_at)
        SELECT import_rejection_id,import_run_id,tenant_id,app_id,source_id,row_ordinal,reason_code,field_names,occurred_at
        FROM jsonb_populate_recordset(NULL::control.import_row_rejections,$1::jsonb)`);
    });
    console.log(`Import ${basename(options.filePath)}: rows=${loaded.rows.length} accepted=${acceptedRows.length} rejected=${allFailures.length}`);
    return {
      status: "completed", import_run_id: runId, rows: loaded.rows.length,
      accepted: acceptedRows.length, rejected: allFailures.length,
      deliveries, logical_events: logicalEvents,
    };
  } catch (error) {
    // Projection writes are transaction-scoped per logical record. A terminal failed run
    // still records the source snapshot without requiring UPDATE permission.
    await withTenant(options.pool, mapping.tenant_id, (client) => client.query(
      `INSERT INTO control.import_runs (
        import_run_id, tenant_id, app_id, source_id, source_snapshot_digest,
        status, started_at, completed_at
      ) VALUES ($1,$2,$3,$4,$5,'failed',$6,$6)`,
      [runId, mapping.tenant_id, mapping.app_id, mapping.source_id, fileDigest, now],
    ).then(() => undefined));
    throw error;
  }
}

export async function runMmpImportCommand(
  options: Parameters<typeof runMmpImport>[0] & { lintDirectory?: string },
): Promise<ImportSummary> {
  const scope = loadMappingScope(options.mappingPath);
  return runWithTerminalJobOutcome(
    async () => {
      const mappings = mappingsForLint(options.mappingPath, options.lintDirectory);
      for (const warning of lintMappings(mappings)) console.warn(JSON.stringify({ level: "warning", ...warning }));
      return runMmpImport(options);
    },
    (outcome) => recordJobOutcome({
      pool: options.pool,
      tenantId: scope.tenantId,
      appId: scope.appId,
      job: "mmp_import",
      outcome,
    }),
  );
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

export function mappingsForLint(mappingPath: string, explicitDirectory?: string): ImportMapping[] {
  if (!explicitDirectory) return [loadMapping(mappingPath)];
  const directory = resolve(explicitDirectory);
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => loadMapping(join(directory, entry.name)));
}

export function resolveMappingPath(source: string): string {
  return source.endsWith(".json") && (source.includes("/") || source.includes("\\"))
    ? resolve(source)
    : join(
      resolve(process.env.OPENMASU_MAPPINGS_DIR ?? "examples/mappings"),
      source.endsWith(".json") ? source : `${source}.json`,
    );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const source = argument("source");
  const file = argument("file");
  const lintDirectory = argument("lint-directory");
  const preview = process.argv.slice(2).includes("--preview");
  if (!source || !file) {
    throw new Error(`usage: npm run ${preview ? "import:preview" : "import"} -- --source=<mapping-name-or-path> --file=<path>`);
  }
  const mappingPath = resolveMappingPath(source);
  if (preview) {
    try {
      console.log(JSON.stringify(previewMmpImport({
        mappingPath,
        filePath: resolve(file),
        lintDirectory,
      })));
    } catch (error) {
      if (error instanceof ImportLimitError) console.error(`Import preview refused: ${error.message}`);
      throw error;
    }
  } else {
    const pool = createAppPool();
    try {
      const summary = await runMmpImportCommand({
        pool,
        mappingPath,
        filePath: resolve(file),
        lintDirectory,
      });
      console.log(JSON.stringify(summary));
    } catch (error) {
      if (error instanceof ImportLimitError) console.error(`Import refused before persistence: ${error.message}`);
      throw error;
    } finally {
      await pool.end();
    }
  }
}
