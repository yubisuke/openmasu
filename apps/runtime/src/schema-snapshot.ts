import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";

const root = process.cwd();
const migrationDirectory = join(root, "db", "migrations");
const snapshotPath = join(root, "db", "schema.sql");
const migrationPattern = /^\d{3,}_[a-z0-9_]+\.sql$/;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeNewlines(value: string): string {
  return value.replaceAll("\r\n", "\n");
}

function render(): string {
  const files = readdirSync(migrationDirectory).filter((name) => migrationPattern.test(name)).sort();
  const header = [
    "-- OpenMasu schema snapshot.",
    "-- Generated deterministically from db/migrations; do not edit by hand.",
    "",
  ].join("\n");
  return `${header}${files.map((name) => `-- ${name}\n${normalizeNewlines(readFileSync(join(migrationDirectory, name), "utf8")).trimEnd()}\n`).join("\n")}`;
}

const expected = render();
if (process.argv.includes("--write")) {
  writeFileSync(snapshotPath, expected, "utf8");
  console.log(`Wrote db/schema.sql (${sha256(expected)}).`);
  process.exit(0);
}

if (!process.argv.includes("--check")) throw new Error("use --write or --check");
if (!existsSync(snapshotPath) || normalizeNewlines(readFileSync(snapshotPath, "utf8")) !== expected) {
  throw new Error("db/schema.sql differs from the forward-only migration snapshot");
}

const connectionString = process.env.OPENMASU_MIGRATION_DATABASE_URL;
if (connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const rows = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM public.schema_migrations ORDER BY version",
    );
    const files = readdirSync(migrationDirectory).filter((name) => migrationPattern.test(name)).sort();
    if (rows.rows.length !== files.length) throw new Error("database migration inventory differs from db/migrations");
    for (const [index, name] of files.entries()) {
      const digest = sha256(normalizeNewlines(readFileSync(join(migrationDirectory, name), "utf8")));
      if (rows.rows[index]?.name !== name || rows.rows[index]?.checksum !== digest) {
        throw new Error(`database migration drift: ${name}`);
      }
    }
  } finally {
    await client.end();
  }
}

console.log(`Database schema snapshot matches ${readdirSync(migrationDirectory).filter((name) => migrationPattern.test(name)).length} migration(s).`);
