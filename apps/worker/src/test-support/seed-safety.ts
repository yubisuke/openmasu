import type { Pool } from "pg";

const seedLockName = "openmasu:synthetic-seed";
const deadlockCode = "40P01";

function postgresCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : undefined;
}

export async function retryDeadlockOnce<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (postgresCode(error) !== deadlockCode) throw error;
    console.warn("PostgreSQL deadlock 40P01 during synthetic ledger reset; retrying once.");
    return operation();
  }
}

export async function withSyntheticSeedLock<T>(pool: Pool, operation: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let locked = false;
  let discardClient = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [seedLockName]);
    locked = true;
    return await operation();
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [seedLockName])
        .catch(() => { discardClient = true; });
    }
    client.release(discardClient);
  }
}
