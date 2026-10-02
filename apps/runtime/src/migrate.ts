import { Client } from "pg";
import { requireEnvironment } from "./index.js";
import { migrateDatabase } from "./migration-engine.js";

const client = new Client({ connectionString: requireEnvironment(
  "OPENMASU_MIGRATION_DATABASE_URL", process.env.OPENMASU_MIGRATION_DATABASE_URL,
) });
await client.connect();
try {
  const count = await migrateDatabase(client);
  console.log(count === 0 ? "Database migrations: no pending migrations." : `Database migrations applied: ${count}.`);
} finally { await client.end(); }
