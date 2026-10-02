import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { aggregateCapacityRelations, payloadCapacity } from "./capacity.js";
import { EncryptedFilePayloadStore } from "./payload-store.js";

it("capacity distinguishes allocated bytes from estimated rows without exposing relation names", () => {
  const observation = aggregateCapacityRelations([
    { schema_name: "ledger", table_name: "raw_records", bytes: "9007199254740993", estimated_rows: "42" },
    { schema_name: "ledger", table_name: "privacy_tombstones", bytes: "8192", estimated_rows: null },
  ]);
  assert.deepEqual(observation[0].bytes, { state: "exact", value: "9007199254740993" });
  assert.deepEqual(observation[0].count, { state: "estimate", value: "42" });
  assert.equal(observation.find((row) => row.layer === "privacy_state")!.count.state, "unavailable");
  assert.ok(!JSON.stringify(observation).includes("raw_records"));
});
it("metadata-only payload capacity follows protected writes and purge, remains read-only and bounds observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "openmasu-capacity-"));
  try {
    const store = new EncryptedFilePayloadStore(root, "synthetic-capacity-master-key-32-characters");
    const before = await payloadCapacity(root);
    assert.equal(before.layers[0].count.state, "exact");
    const reference = await store.write({ tenantId: "tenant-synthetic", appId: "app-synthetic", objectId: "object-synthetic" }, Buffer.from("synthetic secret payload"));
    const after = await payloadCapacity(root);
    assert.deepEqual(after.layers.map((row) => row.count), [{ state: "exact", value: "1" }, { state: "exact", value: "1" }]);
    assert.ok(!JSON.stringify(after).includes(reference) && !JSON.stringify(after).includes(root));
    assert.equal((await store.read(reference)).toString(), "synthetic secret payload");
    const bounded = await payloadCapacity(root, { maximumFiles: 1, maximumMilliseconds: 3_000 });
    assert.deepEqual(bounded.layers[0].count, { state: "unavailable", reason: "observation_limit_exceeded" });
    await store.purge(reference);
    assert.deepEqual((await payloadCapacity(root)).layers.map((row) => row.count), before.layers.map((row) => row.count));
    assert.deepEqual((await payloadCapacity(join(root, "missing"))).layers[0].bytes, { state: "unavailable", reason: "store_unavailable" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
