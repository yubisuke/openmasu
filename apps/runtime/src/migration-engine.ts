import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { requireEnvironment } from "./index.js";

const migrationPattern = /^(\d{3,})_[a-z0-9_]+\.sql$/;
export interface Migration { readonly version: string; readonly name: string; readonly checksum: string; readonly source: string }
export function readMigrations(directory = join(process.cwd(), "db", "migrations")): Migration[] {
  return readdirSync(directory).filter((name) => migrationPattern.test(name)).sort().map((name) => {
    const source = readFileSync(join(directory, name), "utf8").replaceAll("\r\n", "\n");
    return { version: migrationPattern.exec(name)![1], name, checksum: checksum(source), source };
  });
}
export function checkAppliedMigrations(applied: readonly Omit<Migration, "source">[], migrations: readonly Migration[]): void {
  for (let index = 0; index < applied.length; index++) {
    const row = applied[index];
    const expected = migrations[index];
    if (!expected || row.version !== expected.version || row.name !== expected.name || row.checksum !== expected.checksum) throw new Error("migration_inventory_mismatch");
  }
}

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
    "OPENMASU_APP_DATABASE_PASSWORD",
    process.env.OPENMASU_APP_DATABASE_PASSWORD,
  );
  const readerPassword = requireEnvironment(
    "OPENMASU_READER_DATABASE_PASSWORD",
    process.env.OPENMASU_READER_DATABASE_PASSWORD,
  );
  const seedPassword = requireEnvironment(
    "OPENMASU_SEED_DATABASE_PASSWORD",
    process.env.OPENMASU_SEED_DATABASE_PASSWORD,
  );
  const identity = await client.query<{ current_user: string; current_database: string }>(
    "SELECT current_user, current_database()",
  );
  const currentUser = identity.rows[0].current_user;
  const database = identity.rows[0].current_database;
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openmasu_owner') THEN
        CREATE ROLE openmasu_owner NOLOGIN NOINHERIT NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openmasu_app') THEN
        CREATE ROLE openmasu_app LOGIN NOINHERIT NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openmasu_reader') THEN
        CREATE ROLE openmasu_reader LOGIN NOINHERIT NOBYPASSRLS;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'openmasu_seed') THEN
        CREATE ROLE openmasu_seed LOGIN NOINHERIT NOBYPASSRLS;
      END IF;
    END
    $$
  `);
  await client.query("ALTER ROLE openmasu_owner NOLOGIN NOINHERIT NOBYPASSRLS");
  await client.query(`ALTER ROLE openmasu_app LOGIN NOINHERIT NOBYPASSRLS PASSWORD ${quoteLiteral(appPassword)}`);
  await client.query(`ALTER ROLE openmasu_reader LOGIN NOINHERIT NOBYPASSRLS PASSWORD ${quoteLiteral(readerPassword)}`);
  await client.query(`ALTER ROLE openmasu_seed LOGIN NOINHERIT NOBYPASSRLS PASSWORD ${quoteLiteral(seedPassword)}`);
  await client.query("REVOKE openmasu_owner FROM openmasu_app, openmasu_reader, openmasu_seed");
  await client.query("REVOKE openmasu_app FROM openmasu_reader, openmasu_seed");
  await client.query("REVOKE openmasu_reader FROM openmasu_app, openmasu_seed");
  await client.query("REVOKE openmasu_seed FROM openmasu_app, openmasu_reader");
  await client.query(`GRANT openmasu_owner TO ${quoteIdentifier(currentUser)}`);
  await client.query(`GRANT CONNECT, CREATE ON DATABASE ${quoteIdentifier(database)} TO openmasu_owner`);
  await client.query(`GRANT CONNECT ON DATABASE ${quoteIdentifier(database)} TO openmasu_app, openmasu_reader, openmasu_seed`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version text PRIMARY KEY,
      name text NOT NULL,
      checksum text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
  await client.query("ALTER TABLE public.schema_migrations OWNER TO openmasu_owner");
  await client.query("REVOKE ALL ON public.schema_migrations FROM PUBLIC, openmasu_app, openmasu_reader");
}

export async function migrateDatabase(client: Client, migrations = readMigrations(), beforeRecord?: (migration: Migration) => void): Promise<number> {
  await client.query("SELECT pg_advisory_lock(hashtext('openmasu:migrations'))");
  try {
    const exists = (await client.query("SELECT to_regclass('public.schema_migrations') AS name")).rows[0].name;
    const applied = exists ? (await client.query<Omit<Migration, "source">>(
      "SELECT version, name, checksum FROM public.schema_migrations ORDER BY version",
    )).rows : [];
    // Reject unknown, reordered or modified applied files before changing roles or DDL.
    checkAppliedMigrations(applied, migrations);
    await ensureRoles(client);
    let count = 0;
    for (const migration of migrations.slice(applied.length)) {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE openmasu_owner");
        await client.query(migration.source);
        beforeRecord?.(migration);
        await client.query(
          "INSERT INTO public.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)",
          [migration.version, migration.name, migration.checksum],
        );
        await client.query("COMMIT");
        count += 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return count;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('openmasu:migrations'))");
  }
}
