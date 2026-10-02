import { lstat, opendir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PoolClient } from "pg";

export type CapacityValue = { state: "exact" | "estimate"; value: string } | { state: "unavailable"; reason: string };
export interface CapacityLayer { layer: string; scope: string; count: CapacityValue; bytes: CapacityValue; tables?: number }
export interface CapacityObservation { observed_at: string; scope: string; layers: CapacityLayer[] }
const databaseLayers = ["raw_evidence", "logical_facts", "derived_results", "privacy_state", "ledger_other", "control", "queues", "synthetic_testing", "migration_metadata"];
const unavailable = (reason: string): CapacityValue => ({ state: "unavailable", reason });
function unavailableDatabase(reason: string): CapacityLayer[] {
  return databaseLayers.map((layer) => ({ layer, scope: "operator_database_all_tenants", count: unavailable(reason), bytes: unavailable(reason) }));
}
export function capacityLayer(schema: string, table: string): string {
  if (/^privacy_/.test(table)) return "privacy_state";
  if (schema === "control") return "control";
  if (schema === "ephemeral") return "queues";
  if (schema === "testing") return "synthetic_testing";
  if (schema === "public") return "migration_metadata";
  if (["raw_records", "raw_payload_states", "event_deliveries", "rejections", "ingest_inbox", "ingest_inbox_states", "ingest_batches", "ingest_batch_states", "ingest_batch_records"].includes(table)) return "raw_evidence";
  if (table === "logical_events" || table.endsWith("_facts")) return "logical_facts";
  if (table.endsWith("_results") || ["metric_runs", "metric_calculation_evidence", "fraud_decisions", "cost_records", "aggregate_revenue_snapshots"].includes(table)) return "derived_results";
  return "ledger_other";
}
type Relation = { schema_name: string; table_name: string; bytes: string; estimated_rows: string | null };
export function aggregateCapacityRelations(rows: readonly Relation[]): CapacityLayer[] {
  return databaseLayers.map((layer) => {
    const selected = rows.filter((row) => capacityLayer(row.schema_name, row.table_name) === layer);
    return {
      layer, scope: "operator_database_all_tenants", tables: selected.length,
      bytes: { state: "exact", value: selected.reduce((sum, row) => sum + BigInt(row.bytes), 0n).toString() },
      count: selected.some((row) => row.estimated_rows === null) ? unavailable("statistics_unavailable")
        : { state: "estimate", value: selected.reduce((sum, row) => sum + BigInt(row.estimated_rows!), 0n).toString() },
    };
  });
}

/** No tenant data is read. This whole-database observation requires a privileged operator. */
export async function databaseCapacity(client: PoolClient): Promise<CapacityObservation> {
  const observed_at = new Date().toISOString();
  let started = false;
  try {
    await client.query("BEGIN READ ONLY"); started = true;
    await client.query("SET LOCAL statement_timeout='5s'");
    const role = (await client.query<{ privileged: boolean }>("SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname=current_user")).rows[0];
    if (!role?.privileged) return { observed_at, scope: "operator_database_all_tenants", layers: unavailableDatabase("privileged_operator_required") };
    const relations = await client.query<Relation>(`
      SELECT n.nspname AS schema_name, c.relname AS table_name,
             pg_total_relation_size(c.oid)::text AS bytes, s.n_live_tup::text AS estimated_rows
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_stat_all_tables s ON s.relid=c.oid
      WHERE c.relkind IN ('r','m') AND (
        n.nspname IN ('ledger','control','ephemeral','testing') OR
        (n.nspname='public' AND c.relname='schema_migrations'))
      ORDER BY n.nspname,c.relname LIMIT 1001
    `);
    return { observed_at, scope: "operator_database_all_tenants", layers: relations.rows.length > 1000 ? unavailableDatabase("relation_limit_exceeded") : aggregateCapacityRelations(relations.rows) };
  } catch (error) {
    const code = (error as { code?: string }).code;
    return { observed_at, scope: "operator_database_all_tenants", layers: unavailableDatabase(code === "42501" ? "permission_denied" : code === "57014" ? "query_timeout" : "database_observation_failed") };
  } finally { if (started) await client.query("ROLLBACK"); }
}

/** File metadata only: no decryption, names, paths, references or secret material in output. */
export async function payloadCapacity(root: string, limits = { maximumFiles: 50_000, maximumMilliseconds: 3_000 }): Promise<CapacityObservation> {
  const observed_at = new Date().toISOString();
  const scope = "configured_payload_root_all_tenants";
  const layers: CapacityLayer[] = [];
  const started = performance.now();
  let files = 0;
  const normalized = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  try {
    const absolute = resolve(root);
    if (!Number.isSafeInteger(limits.maximumFiles) || limits.maximumFiles < 1 || limits.maximumFiles > 1_000_000
      || !Number.isSafeInteger(limits.maximumMilliseconds) || limits.maximumMilliseconds < 1 || limits.maximumMilliseconds > 30_000) throw new Error("observation_limits_invalid");
    if (!(await lstat(absolute)).isDirectory() || normalized(await realpath(absolute)) !== normalized(absolute)) throw new Error("unsafe_store_layout");
    for (const name of ["objects", "keys"] as const) {
      const directory = join(absolute, name);
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe_store_layout");
      let count = 0n, bytes = 0n;
      for await (const entry of await opendir(directory)) {
        if (++files > limits.maximumFiles || performance.now() - started > limits.maximumMilliseconds) throw new Error("observation_limit_exceeded");
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("unsafe_store_layout");
        const entryStat = await lstat(join(directory, entry.name), { bigint: true });
        if (!entryStat.isFile() || entryStat.isSymbolicLink()) throw new Error("unsafe_store_layout");
        count++; bytes += entryStat.size;
      }
      layers.push({ layer: `payload_${name}`, scope, count: { state: "exact", value: count.toString() }, bytes: { state: "exact", value: bytes.toString() } });
    }
    return { observed_at, scope, layers };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "store_unavailable" : code === "EACCES" || code === "EPERM" ? "permission_denied"
      : error instanceof Error && /^(unsafe_store_layout|observation_limit_exceeded|observation_limits_invalid)$/.test(error.message) ? error.message : "payload_observation_failed";
    return { observed_at, scope, layers: ["payload_objects", "payload_keys"].map((layer) => ({ layer, scope, count: unavailable(reason), bytes: unavailable(reason) })) };
  }
}
