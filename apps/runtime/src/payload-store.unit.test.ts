import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EncryptedFilePayloadStore, PayloadNotFoundError } from "./payload-store.js";

describe("encrypted payload store references", () => {
  it("rejects path traversal before reading or purging", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmasu-payload-"));
    try {
      const store = new EncryptedFilePayloadStore(root, "synthetic-master-key-that-is-long-enough");
      await assert.rejects(store.read("encrypted:../../outside"), /invalid payload reference/);
      await assert.rejects(store.purge("encrypted:..%2foutside"), /invalid payload reference/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("distinguishes an absent payload from a corrupt payload", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmasu-payload-"));
    try {
      const store = new EncryptedFilePayloadStore(root, "synthetic-master-key-that-is-long-enough");
      const reference = await store.write(
        { tenantId: "tenant-a", appId: "app-a", objectId: "synthetic" },
        Buffer.from("synthetic payload", "utf8"),
      );
      const keyId = reference.slice("encrypted:".length);
      writeFileSync(join(root, "objects", `${keyId}.json`), "not-json", "utf8");
      await assert.rejects(store.read(reference), SyntaxError);

      await store.purge(reference);
      await assert.rejects(store.read(reference), PayloadNotFoundError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
