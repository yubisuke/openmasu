import { randomBytes } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

export * from "./secrets.js";
export * from "./payload-store.js";

const identifierPattern = /^[A-Za-z0-9._:-]{1,128}$/;

export function requireEnvironment(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createAppPool(): Pool {
  return new Pool({
    connectionString: requireEnvironment("OPENMMP_APP_DATABASE_URL", process.env.OPENMMP_APP_DATABASE_URL),
    max: 10,
  });
}

export function createMigrationPool(): Pool {
  return new Pool({
    connectionString: requireEnvironment(
      "OPENMMP_MIGRATION_DATABASE_URL",
      process.env.OPENMMP_MIGRATION_DATABASE_URL,
    ),
    max: 2,
  });
}

export function createSeedPool(): Pool {
  return new Pool({
    connectionString: requireEnvironment(
      "OPENMMP_SEED_DATABASE_URL",
      process.env.OPENMMP_SEED_DATABASE_URL,
    ),
    max: 2,
  });
}

export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!identifierPattern.test(tenantId)) throw new Error(`invalid tenant identifier: ${tenantId}`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('open_mmp.tenant_id', $1, true)", [tenantId]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function queryOne<T extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: unknown[],
): Promise<T> {
  const result = await client.query<T>(text, values);
  if (result.rows.length !== 1) throw new Error(`expected one row, received ${result.rows.length}`);
  return result.rows[0];
}

export function uuidV7(now = Date.now()): string {
  const bytes = randomBytes(16);
  let value = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
