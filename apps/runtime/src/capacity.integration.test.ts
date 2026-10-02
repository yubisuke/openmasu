import assert from "node:assert/strict";
import { it } from "node:test";
import { createMigrationPool, createReaderPool } from "./index.js";
import { databaseCapacity } from "./capacity.js";

it("operator capacity observes catalog allocation read-only while the ordinary reader receives no database-wide totals", { skip: !process.env.OPENMASU_MIGRATION_DATABASE_URL }, async () => {
  const pool = createMigrationPool();
  const reader = createReaderPool();
  const client = await pool.connect();
  const readerClient = await reader.connect();
  let created = false;
  try {
    await client.query("CREATE TABLE testing.capacity_probe (value text)");
    created = true;
    const baseline = await databaseCapacity(client);
    await client.query("INSERT INTO testing.capacity_probe SELECT repeat('synthetic capacity ',100) FROM generate_series(1,200)");
    const populated = await databaseCapacity(client);
    const layer = (observation: typeof baseline) => observation.layers.find((row) => row.layer === "synthetic_testing")!;
    const beforeBytes = layer(baseline).bytes, afterBytes = layer(populated).bytes;
    if (beforeBytes.state !== "exact" || afterBytes.state !== "exact") assert.fail("catalog allocation must be available for the synthetic operator");
    assert.ok(BigInt(afterBytes.value) > BigInt(beforeBytes.value));
    assert.equal(layer(populated).count.state, "estimate");
    assert.equal((await client.query("SELECT count(*)::integer AS count FROM testing.capacity_probe")).rows[0].count, 200);
    const denied = await databaseCapacity(readerClient);
    assert.ok(denied.layers.every((row) => row.bytes.state === "unavailable" && row.bytes.reason === "privileged_operator_required"));
    assert.ok(!JSON.stringify(populated).includes("capacity_probe") && !JSON.stringify(populated).includes("tenant" + "-a"));
  } finally {
    if (created) await client.query("DROP TABLE testing.capacity_probe");
    readerClient.release(); client.release(); await Promise.all([pool.end(), reader.end()]);
  }
});
