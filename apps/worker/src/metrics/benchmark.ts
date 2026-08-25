import { performance } from "node:perf_hooks";
import { cpus, totalmem } from "node:os";
import { Client } from "pg";
import { requireEnvironment } from "@openmasu/runtime";

const requestedRows = Number(process.env.OPENMASU_BENCHMARK_ROWS ?? "100000");
if (!Number.isSafeInteger(requestedRows) || requestedRows < 1 || requestedRows > 10_000_000) {
  throw new Error("OPENMASU_BENCHMARK_ROWS must be an integer between 1 and 10000000");
}

const client = new Client({
  connectionString: requireEnvironment(
    "OPENMASU_MIGRATION_DATABASE_URL",
    process.env.OPENMASU_MIGRATION_DATABASE_URL,
  ),
});
await client.connect();

async function cgroup(path: string): Promise<string> {
  try {
    return (await client.query<{ value: string }>("SELECT pg_read_file($1) AS value", [path])).rows[0].value.trim();
  } catch {
    return "unavailable";
  }
}

const table = "testing.m1b_metric_performance_floor";
const environmentBase = {
  node_version: process.version,
  host_logical_cpus: cpus().length,
  host_memory_bytes: totalmem(),
  postgres_version: (await client.query<{ value: string }>("SHOW server_version")).rows[0].value,
  postgres_cpu_max: await cgroup("/sys/fs/cgroup/cpu.max"),
  postgres_cpuset: await cgroup("/sys/fs/cgroup/cpuset.cpus.effective"),
  postgres_memory_max: await cgroup("/sys/fs/cgroup/memory.max"),
};
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL ROLE openmasu_owner");
  await client.query(`DROP TABLE IF EXISTS ${table}`);
  await client.query(`
    CREATE UNLOGGED TABLE ${table} (
      cohort_date date NOT NULL,
      installation_bucket integer NOT NULL,
      amount_unscaled numeric NOT NULL,
      amount_scale integer NOT NULL
    )
  `);
  const seedStarted = performance.now();
  await client.query(
    `INSERT INTO ${table} (cohort_date, installation_bucket, amount_unscaled, amount_scale)
     SELECT DATE '2026-08-01', ((series - 1) % 100000)::integer, 1000001::numeric, 6
     FROM generate_series(1, $1::integer) AS series`,
    [requestedRows],
  );
  const seedMs = performance.now() - seedStarted;
  await client.query(`ANALYZE ${table}`);
  await client.query("SET LOCAL max_parallel_workers_per_gather=3");
  await client.query("SET LOCAL work_mem='64MB'");
  const aggregateStarted = performance.now();
  const aggregation = await client.query<{ value_unscaled: string; rows: string }>(`
    SELECT sum(ledger.half_even_div(
             amount_unscaled * 100000000::numeric * 1000000::numeric,
             power(10::numeric, amount_scale + 8)
           ))::text AS value_unscaled,
           count(*)::text AS rows
    FROM ${table}
    WHERE cohort_date=DATE '2026-08-01'
  `);
  const aggregateMs = performance.now() - aggregateStarted;
  const size = await client.query<{ bytes: string }>(
    "SELECT pg_total_relation_size($1::regclass)::text AS bytes",
    [table],
  );
  const expected = (BigInt(requestedRows) * 1_000_001n).toString();
  if (aggregation.rows[0].rows !== String(requestedRows)) throw new Error("benchmark row count changed");
  if (aggregation.rows[0].value_unscaled !== expected) throw new Error("benchmark aggregate changed");
  await client.query("RESET ROLE");
  const environment = {
    ...environmentBase,
    postgres_memory_current_bytes: await cgroup("/sys/fs/cgroup/memory.current"),
    query_parallel_worker_limit: 3,
    query_work_mem: "64MB",
  };
  console.log(JSON.stringify({
    synthetic_only: true,
    rows: requestedRows,
    cohort_date: "2026-08-01",
    seed_ms: Number(seedMs.toFixed(3)),
    aggregate_ms: Number(aggregateMs.toFixed(3)),
    table_bytes: Number(size.rows[0].bytes),
    value_unscaled: aggregation.rows[0].value_unscaled,
    environment,
  }));
  await client.query("ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
