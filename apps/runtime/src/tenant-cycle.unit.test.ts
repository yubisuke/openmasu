import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { it } from "node:test";
import type { Pool } from "pg";
import { runTenantCycle } from "./tenant-cycle.js";

function harness() {
  let current = true;
  const history: string[][] = [];
  class Client extends EventEmitter {
    released = false;
    readonly sql: string[] = [];
    constructor(readonly owner = false) { super(); history.push(this.sql); }
    async query(value: string | { text: string }) {
      assert.equal(this.released, false);
      const text = typeof value === "string" ? value : value.text;
      this.sql.push(text);
      if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }], rowCount: 1 };
      if (text.includes("RETURNING generation")) return { rows: [{ generation: "1" }], rowCount: 1 };
      if (text.startsWith("SELECT generation")) return { rows: current ? [{ generation: "1" }] : [], rowCount: current ? 1 : 0 };
      return { rows: [], rowCount: 0 };
    }
    release() { assert.equal(this.released, false); this.released = true; }
  }
  const owner = new Client(true), clients: Client[] = [];
  return { owner, history, clients, invalidate: () => { current = false; },
    coordinationPool: { connect: async () => owner } as unknown as Pool,
    pool: { connect: async () => { const client = new Client(); clients.push(client); return client; } } as unknown as Pool };
}

it("tenant_cycle_fences_explicit_and_standalone_transactions_and_invalidates_borrowed_clients_on_owner_loss", async () => {
  const good = harness();
  let escaped!: Pool;
  assert.equal((await runTenantCycle({ ...good, pools: [good.pool], tenantId: "tenant-synthetic", task: async ({ pools }) => {
    escaped = pools[0];
    await escaped.query({ text: "SELECT 1", values: [] });
    const client = await escaped.connect();
    try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ"); await client.query("INSERT INTO synthetic VALUES (1)"); await client.query("COMMIT"); }
    finally { client.release(); }
  } })).status, "completed");
  for (const client of good.clients) {
    assert.equal(client.released, true);
    assert.match(client.sql[client.sql.indexOf("COMMIT") - 1], /FOR SHARE/);
  }
  await assert.rejects(escaped.query("SELECT 1"), /worker_tenant_cycle_lost/);
  for (const loss of ["epoch", "connection"] as const) {
    const bad = harness();
    await assert.rejects(runTenantCycle({ ...bad, pools: [bad.pool], tenantId: "tenant-synthetic", task: async ({ pools }) => {
      const client = await pools[0].connect();
      try {
        await client.query("BEGIN"); await client.query("INSERT INTO synthetic VALUES (1)");
        if (loss === "epoch") bad.invalidate(); else bad.owner.emit("error", new Error("synthetic_disconnect"));
        await client.query("COMMIT");
      } finally { client.release(); }
    } }), /worker_tenant_cycle_lost/);
    assert.equal(bad.clients[0].sql.includes("COMMIT"), false);
    assert.equal(bad.clients[0].released, true);
  }
});
