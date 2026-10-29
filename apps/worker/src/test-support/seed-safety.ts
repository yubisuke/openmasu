import type { Pool, PoolClient } from "pg";

const seedLockName = "openmasu:synthetic-seed";
const deadlockCode = "40P01";

/** Trust the DB's one-time purpose, never a caller-supplied CLI/env flag. */
export async function assertSyntheticDeployment(client: PoolClient): Promise<void> {
  const result = await client.query<{ purpose: string }>(
    "SELECT purpose FROM control.deployment_purpose WHERE singleton",
  );
  if (result.rows.length !== 1 || result.rows[0].purpose !== "synthetic_disposable") {
    throw new Error("synthetic_seed_requires_disposable");
  }
}

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
    await assertSyntheticDeployment(client);
    return await operation();
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [seedLockName])
        .catch(() => { discardClient = true; });
    }
    client.release(discardClient);
  }
}
