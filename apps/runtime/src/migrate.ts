import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireEnvironment } from "./index.js";

const migrationDirectory = join(process.cwd(), "db", "migrations");
const migrationPattern = /^(\d{3,})_[a-z0-9_]+\.sql$/;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function checksum(source: string): string {
  return createHash("sha256").update(source.replaceAll("\r\n", "\n"), "utf8").digest("hex");
}

async function ensureRoles(client: Client): Promise<void> {
  const appPassword = requireEnvironment(
    "OPENMMP_APP_DATABASE_PASSWORD",
    process.env.OPENMMP_APP_DATABASE_PASSWORD,
  );
  const readerPassword = requireEnvironment(
    "OPENMMP_READER_DATABASE_PASSWORD",
    process.env.OPENMMP_READER_DATABASE_PASSWORD,
  );
  const seedPassword = requireEnvironment(
    "OPENMMP_SEED_DATABASE_PASSWORD",
    process.env.OPENMMP_SEED_DATABASE_PASSWORD,
  );
  const identity = await client.query<{ current_user: string; current_database: string }>(
    "SELECT current_user, current_database()",
  );
  const currentUser = identity.rows[0].current_user;
  const database = identity.rows[0].current_database;
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openmmp_owner') THEN
        CREATE ROLE openmmp_owner NOLOGIN NOINHERIT NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openmmp_app') THEN
        CREATE ROLE openmmp_app LOGIN NOINHERIT NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openmmp_reader') THEN
        CREATE ROLE openmmp_reader LOGIN NOINHERIT NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openmmp_seed') THEN
        CREATE ROLE openmmp_seed LOGIN NOINHERIT NOBYPASSRLS;
      END IF;
    END
    $$
  `);
  await client.query("ALTER ROLE openmmp_owner NOLOGIN NOINHERIT NOBYPASSRLS");
  await client.query(`ALTER ROLE openmmp_app LOGIN NOINHERIT NOBYPASSRLS PASSWORD ${quoteLiteral(appPassword)}`);
  await client.query(`ALTER ROLE openmmp_reader LOGIN NOINHERIT NOBYPASSRLS PASSWORD ${quoteLiteral(readerPassword)}`);
  await client.query(`ALTER ROLE openmmp_seed LOGIN NOINHERIT NOBYPASSRLS PASSWORD ${quoteLiteral(seedPassword)}`);
  await client.query("REVOKE openmmp_owner FROM openmmp_app, openmmp_reader, openmmp_seed");
  await client.query("REVOKE openmmp_app FROM openmmp_reader, openmmp_seed");
  await client.query("REVOKE openmmp_reader FROM openmmp_app, openmmp_seed");
  await client.query("REVOKE openmmp_seed FROM openmmp_app, openmmp_reader");
  await client.query(`GRANT openmmp_owner TO ${quoteIdentifier(currentUser)}`);
  await client.query(`GRANT CONNECT, CREATE ON DATABASE ${quoteIdentifier(database)} TO openmmp_owner`);
  await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO openmmp_app, openmmp_reader, openmmp_seed`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
  await client.query("ALTER TABLE public.schema_migrations OWNER TO openmmp_owner");
  await client.query("REVOKE ALL ON public.schema_migrations FROM PUBLIC, openmmp_app, openmmp_reader");
}

const connectionString = requireEnvironment(
  "OPENMMP_MIGRATION_DATABASE_URL",
  process.env.OPENMMP_MIGRATION_DATABASE_URL,
);
const client = new Client({ connectionString });
await client.connect();

try {
  await ensureRoles(client);
  await client.query("SELECT pg_advisory_lock(hashtext('open-mmp:migrations'))");
  const applied = await client.query<{ version: string; checksum: string }>(
    "SELECT version, checksum FROM public.schema_migrations ORDER BY version",
  );
  const appliedByVersion = new Map(applied.rows.map((row) => [row.version, row.checksum]));
  const files = readdirSync(migrationDirectory).filter((name) => migrationPattern.test(name)).sort();
  let count = 0;
  for (const name of files) {
    const match = migrationPattern.exec(name);
    if (!match) continue;
    const version = match[1];
    const source = readFileSync(join(migrationDirectory, name), "utf8").replaceAll("\r\n", "\n");
    const digest = checksum(source);
    const existing = appliedByVersion.get(version);
    if (existing) {
      if (existing !== digest) throw new Error(`applied migration checksum changed: ${name}`);
      continue;
    }
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE openmmp_owner");
      await client.query(source);
      await client.query(
        "INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
        [version, name, digest],
      );
      await client.query("COMMIT");
      count += 1;
      console.log(`Applied migration ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  console.log(count === 0 ? "Database migrations: no pending migrations." : `Database migrations applied: ${count}.`);
} finally {
  try {
    await client.query("SELECT pg_advisory_unlock(hashtext('open-mmp:migrations'))");
  } finally {
    await client.end();
  }
}
