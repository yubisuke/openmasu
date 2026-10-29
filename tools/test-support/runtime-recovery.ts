// Runs only inside the isolated synthetic pilot's API container.
import assert from "node:assert/strict";
import { createAppPool, withTenant } from "@openmasu/runtime";
import { expectedMaxTokenAll } from "../../apps/api/src/max-receiver.js";

const pool = createAppPool();
const tenant = process.env.OPENMASU_MAX_TENANT_ID!;
const eventId = "abcdef0123456789abcdef0123456789abcdef03";
const state = async () => withTenant(pool, tenant, client => client.query(
  "SELECT status FROM ledger.ingest_inbox_current WHERE tenant_id=$1 AND event_id=$2", [tenant, eventId]));
try {
  assert.equal((await pool.query("SELECT purpose FROM control.deployment_purpose WHERE singleton")).rows[0]?.purpose, "synthetic_disposable");
  if (process.argv[2] === "enqueue") {
    const params = new URLSearchParams({ event_id: eventId, revenue: "0.000001", ts: String(Math.floor(Date.now() / 1000)),
      ad_unit_id: "synthetic-recovery", network: "synthetic-network", cc: "US" });
    params.set("event_token_all", expectedMaxTokenAll(params, process.env.OPENMASU_MAX_EVENT_KEY!));
    const response = await fetch(`http://127.0.0.1:8080/v1/ingest/max/${process.env.OPENMASU_MAX_PATH_SECRET}?${params}`);
    assert.equal(response.status, 204);
    assert.deepEqual((await state()).rows, [{ status: "pending" }]);
  } else {
    assert.equal(process.argv[2], "verify");
    const deadline = Date.now() + 45_000;
    while ((await state()).rows[0]?.status === "pending" && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.deepEqual((await state()).rows, [{ status: "processed" }]);
    const logical = await withTenant(pool, tenant, client => client.query(
      "SELECT count(*)::int AS count FROM ledger.logical_events WHERE tenant_id=$1 AND producer='import:applovin-max' AND event_id=$2", [tenant, eventId]));
    assert.equal(logical.rows[0].count, 1);
  }
  console.log("Synthetic durable inbox recovery passed.");
} finally { await pool.end(); }
