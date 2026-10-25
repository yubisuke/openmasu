import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryConfig, QueryResult } from "pg";

export class TenantCycleLostError extends Error {
  constructor() { super("worker_tenant_cycle_lost"); }
}

type Query = (text: string | QueryConfig, values?: unknown[]) => Promise<QueryResult>;
type Borrowed = { close(error?: Error): void };

/** A per-cycle facade, not a general SQL proxy. Workers use promise query/connect only. */
class CycleFence {
  active = true;
  private readonly borrowed = new Set<Borrowed>();
  constructor(readonly tenantId: string, readonly generation: string, readonly ownerToken: string) {}
  assertActive(): void { if (!this.active) throw new TenantCycleLostError(); }
  close(): void {
    this.active = false;
    for (const client of [...this.borrowed]) client.close(new TenantCycleLostError());
  }
  private async check(client: PoolClient, readOnly: boolean): Promise<void> {
    this.assertActive();
    // A shared row lock survives through COMMIT. A replacement owner cannot
    // advance the epoch between this check and publication. RR conflicts abort.
    const row = await client.query(
      `SELECT generation FROM control.worker_tenant_cycles
       WHERE tenant_id=$1 AND generation=$2::bigint AND owner_token=$3::uuid
       ${readOnly ? "" : "FOR SHARE"}`,
      [this.tenantId, this.generation, this.ownerToken],
    );
    if (row.rowCount !== 1) { this.close(); throw new TenantCycleLostError(); }
    this.assertActive();
  }
  async connect(pool: Pool): Promise<PoolClient> {
    this.assertActive();
    const raw = await pool.connect();
    let released = false;
    let transaction = false;
    let readOnly = false;
    let queue: Promise<unknown> = Promise.resolve();
    const member: Borrowed = {
      close: (error) => {
        if (released) return;
        released = true;
        this.borrowed.delete(member);
        raw.release(error ?? (transaction ? new Error("unfinished_worker_transaction") : undefined));
      },
    };
    this.borrowed.add(member);
    if (!this.active) { member.close(new TenantCycleLostError()); throw new TenantCycleLostError(); }
    const execute: Query = async (query, values) => {
      if (released) throw new TenantCycleLostError();
      const text = typeof query === "string" ? query : query.text;
      const command = text.trim().replace(/;\s*$/, "").toUpperCase();
      if (command === "ROLLBACK") {
        const result = await raw.query(query as string, values);
        transaction = false;
        return result;
      }
      this.assertActive();
      if (/^(BEGIN|START TRANSACTION)\b/.test(command)) {
        if (transaction) throw new Error("nested_worker_transaction");
        const result = await raw.query(query as string, values);
        transaction = true;
        readOnly = /\bREAD ONLY\b/.test(command);
        await raw.query("SELECT set_config('openmasu.tenant_id',$1,true)", [this.tenantId]);
        return result;
      }
      if (command === "COMMIT") {
        if (!transaction) throw new Error("missing_worker_transaction");
        await this.check(raw, readOnly);
        const result = await raw.query("COMMIT");
        transaction = false;
        return result;
      }
      if (transaction) return raw.query(query as string, values);
      // Standalone statements also get an atomic fence. Session advisory locks
      // retain their original lifetime, including the privacy projection fence.
      await raw.query("BEGIN");
      transaction = true;
      try {
        await raw.query("SELECT set_config('openmasu.tenant_id',$1,true)", [this.tenantId]);
        const result = await raw.query(query as string, values);
        await this.check(raw, false);
        await raw.query("COMMIT");
        transaction = false;
        return result;
      } catch (error) {
        if (!released) await raw.query("ROLLBACK").catch(() => undefined);
        transaction = false;
        throw error;
      }
    };
    const query: Query = (text, values) => {
      const result = queue.then(() => execute(text, values));
      queue = result.catch(() => undefined);
      return result;
    };
    return { query, release: (error?: Error | boolean) => member.close(error ? new TenantCycleLostError() : undefined) } as unknown as PoolClient;
  }
  pool(pool: Pool): Pool {
    return {
      connect: () => this.connect(pool),
      query: async (text: string | QueryConfig, values?: unknown[]) => {
        const client = await this.connect(pool);
        try { return await client.query(text as string, values); }
        finally { client.release(); }
      },
    } as unknown as Pool;
  }
}

export type TenantCycleContext = {
  readonly generation: string;
  /** Jobs and scheduler retain separate physical pools and connection budgets. */
  readonly pools: readonly Pool[];
};

/** Never waits for an occupied tenant. Connection loss fences every later commit. */
export async function runTenantCycle<T>(options: {
  coordinationPool: Pool;
  pools: readonly Pool[];
  tenantId: string;
  task: (context: TenantCycleContext) => Promise<T>;
}): Promise<{ status: "busy" } | { status: "completed"; value: T }> {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(options.tenantId)) throw new Error("invalid_worker_tenant");
  const owner = await options.coordinationPool.connect();
  const lockKey = `openmasu:worker-tenant-cycle:${options.tenantId}`;
  let fence: CycleFence | undefined;
  let lost = false;
  let locked = false;
  let completed = false;
  const onLoss = (): void => { lost = true; fence?.close(); };
  owner.on("error", onLoss);
  owner.on("end", onLoss);
  try {
    const lock = await owner.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired", [lockKey],
    );
    if (!lock.rows[0]?.acquired) return { status: "busy" };
    locked = true;
    const token = randomUUID();
    await owner.query("BEGIN");
    await owner.query("SELECT set_config('openmasu.tenant_id',$1,true)", [options.tenantId]);
    const row = await owner.query<{ generation: string }>(
      `INSERT INTO control.worker_tenant_cycles
       (tenant_id,generation,owner_token,owner_pid,started_at,status)
       VALUES ($1,1,$2::uuid,pg_backend_pid(),clock_timestamp(),'running')
       ON CONFLICT (tenant_id) DO UPDATE SET
         generation=worker_tenant_cycles.generation+1,owner_token=EXCLUDED.owner_token,
         owner_pid=EXCLUDED.owner_pid,started_at=EXCLUDED.started_at,finished_at=NULL,status='running',
         interrupted_cycles=worker_tenant_cycles.interrupted_cycles
           + CASE WHEN worker_tenant_cycles.status='running' THEN 1 ELSE 0 END
       RETURNING generation::text`, [options.tenantId, token],
    );
    await owner.query("COMMIT");
    fence = new CycleFence(options.tenantId, row.rows[0].generation, token);
    if (lost) { fence.close(); throw new TenantCycleLostError(); }
    const value = await options.task({ generation: fence.generation, pools: options.pools.map(pool => fence!.pool(pool)) });
    fence.assertActive();
    completed = true;
    return { status: "completed", value };
  } finally {
    fence?.close();
    if (!lost) {
      try {
        await owner.query("ROLLBACK");
        if (fence) {
          await owner.query("BEGIN");
          await owner.query("SELECT set_config('openmasu.tenant_id',$1,true)", [options.tenantId]);
          await owner.query(`UPDATE control.worker_tenant_cycles SET status=$4,finished_at=clock_timestamp()
            WHERE tenant_id=$1 AND generation=$2::bigint AND owner_token=$3::uuid`,
          [options.tenantId,fence.generation,fence.ownerToken,completed ? "completed" : "failed"]);
          await owner.query("COMMIT");
        }
        if (locked) await owner.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]);
      } catch { lost = true; }
    }
    owner.removeListener("error", onLoss);
    owner.removeListener("end", onLoss);
    owner.release(lost ? new TenantCycleLostError() : undefined);
  }
}
