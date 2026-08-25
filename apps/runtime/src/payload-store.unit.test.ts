import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EncryptedFilePayloadStore } from "./payload-store.js";

describe("encrypted payload store references", () => {
  it("rejects path traversal before reading or purging", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmmp-payload-"));
    try {
      const store = new EncryptedFilePayloadStore(root, "synthetic-master-key-that-is-long-enough");
      await assert.rejects(store.read("encrypted:../../outside"), /invalid payload reference/);
      await assert.rejects(store.purge("encrypted:..%2foutside"), /invalid payload reference/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
