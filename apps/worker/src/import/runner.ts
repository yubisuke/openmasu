import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Pool } from "pg";
import { sha256, type CandidateAttempt } from "@open-mmp/attribution-core";
import { createAppPool, uuidV7, withTenant } from "@open-mmp/runtime";
import { ingestRuntimeBatch } from "../ingestion.js";
import { loadMapping, mapRow, MappingError, rowMatches, type ImportMapping } from "./mapping.js";
import { ImportLimitError, readRows, type ImportLimits } from "./source.js";

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
    maxBytes: integer("OPENMMP_IMPORT_MAX_BYTES", process.env.OPENMMP_IMPORT_MAX_BYTES, defaultImportLimits.maxBytes),
    maxRows: integer("OPENMMP_IMPORT_MAX_ROWS", process.env.OPENMMP_IMPORT_MAX_ROWS, defaultImportLimits.maxRows),
    maxRowBytes: integer("OPENMMP_IMPORT_MAX_ROW_BYTES", process.env.OPENMMP_IMPORT_MAX_ROW_BYTES, defaultImportLimits.maxRowBytes),
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
    contract_version: "0.2.0",
    record_id: identifier("record", [mapping.source_id, fileDigest, rowOrdinal]),
    delivery_id: identifier("delivery", [fileDigest, rowOrdinal]),
    tenant_id: mapping.tenant_id,
    app_id: mapping.app_id,
    producer: `import:${mapping.provider}`,
    producer_version: `mapping:${mapping.version}`,
    event_id: eventId,
    event_name: eventName,
    schema_version: "0.2.0",
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

async function ensureApp(pool: Pool, mapping: ImportMapping, now: string): Promise<void> {
  await withTenant(pool, mapping.tenant_id, (client) => client.query(
    `INSERT INTO control.apps (tenant_id, app_id, created_at)
     VALUES ($1,$2,$3) ON CONFLICT (tenant_id, app_id) DO NOTHING`,
    [mapping.tenant_id, mapping.app_id, now],
  ).then(() => undefined));
}

async function historicalAttempts(pool: Pool, mapping: ImportMapping): Promise<CandidateAttempt[]> {
  return withTenant(pool, mapping.tenant_id, async (client) => {
    const result = await client.query<{ server_context: Any; record: Any; import_run_id: string }>(
      `SELECT server_context, record, import_run_id::text
       FROM control.import_attempts
       WHERE tenant_id=$1 AND app_id=$2 AND source_id=$3
       ORDER BY created_at, row_ordinal, import_attempt_id`,
      [mapping.tenant_id, mapping.app_id, mapping.source_id],
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

  const attempts: CandidateAttempt[] = [];
  const failures: Array<{ ordinal: number; reason: string; fields: string[] }> = [];
  for (const [ordinal, row] of loaded.rows.entries()) {
    if (!rowMatches(mapping, row)) continue;
    try {
      attempts.push(toAttempt(mapping, mapRow(mapping, row), fileDigest, ordinal, now));
    } catch (error) {
      const mappingError = error instanceof MappingError ? error : new MappingError("row mapping failed");
      failures.push({ ordinal, reason: mappingError.message.includes("timestamp") ? "timestamp_invalid" : "mapping_validation_failed", fields: mappingError.fields });
    }
  }
  const history = await historicalAttempts(options.pool, mapping);
  const output = await ingestRuntimeBatch(attempts, options.pool, history);
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
    for (const [ordinal, attempt] of attempts.entries()) {
      await client.query(
        `INSERT INTO control.import_attempts (
          import_attempt_id, import_run_id, tenant_id, app_id, source_id,
          row_ordinal, server_context, record, created_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
        [uuidV7(), runId, mapping.tenant_id, mapping.app_id, mapping.source_id, ordinal, JSON.stringify(attempt.server), JSON.stringify(attempt.record), now],
      );
    }
    for (const failure of failures) {
      await client.query(
        `INSERT INTO control.import_row_rejections (
          import_rejection_id, import_run_id, tenant_id, app_id, source_id,
          row_ordinal, reason_code, field_names, occurred_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        [uuidV7(), runId, mapping.tenant_id, mapping.app_id, mapping.source_id, failure.ordinal, failure.reason, JSON.stringify(failure.fields), now],
      );
    }
  });
  console.log(`Import ${basename(options.filePath)}: rows=${loaded.rows.length} accepted=${attempts.length} rejected=${failures.length}`);
  return {
    status: "completed", import_run_id: runId, rows: loaded.rows.length,
    accepted: attempts.length, rejected: failures.length,
    deliveries: output.deliveries.length, logical_events: output.logical_events.length,
  };
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const source = argument("source");
  const file = argument("file");
  if (!source || !file) throw new Error("usage: npm run import -- --source=<mapping-name-or-path> --file=<path>");
  const mappingPath = source.endsWith(".json") && (source.includes("/") || source.includes("\\"))
    ? resolve(source)
    : join(resolve(process.env.OPENMMP_MAPPINGS_DIR ?? "examples/mappings"), source.endsWith(".json") ? source : `${source}.json`);
  const pool = createAppPool();
  try {
    const summary = await runMmpImport({ pool, mappingPath, filePath: resolve(file) });
    console.log(JSON.stringify(summary));
  } catch (error) {
    if (error instanceof ImportLimitError) console.error(`Import refused before persistence: ${error.message}`);
    throw error;
  } finally {
    await pool.end();
  }
}
