import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EncryptedFilePayloadStore, PAYLOAD_KEY_STATE_FILE, PayloadNotFoundError, readyPayloadKeyState, recoverOfflinePayloadLock } from "./payload-store.js";

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

  it("rewraps in bounded resumable pages, verifies before cutover and preserves ciphertext and old backup keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmasu-rewrap-")), oldBackup = join(root, "old-backup");
    const oldKey = "synthetic-old-wrapping-key-00000000000", newKey = "synthetic-next-wrapping-key-0000000000";
    const input = { fromKeyRef: "synthetic-v1", toKeyRef: "synthetic-v2", targetSecret: newKey, limit: 1, writersStopped: true };
    try {
      const store = new EncryptedFilePayloadStore(root, oldKey), refs: string[] = [];
      for (let i = 0; i < 3; i++) refs.push(await store.write({ tenantId: "synthetic", appId: "app", objectId: `object-${i}` }, Buffer.from(`synthetic evidence ${i}`)));
      for (const directory of ["objects", "keys"]) cpSync(join(root, directory), join(oldBackup, directory), { recursive: true });
      const objects = () => readdirSync(join(root, "objects")).sort().map(name => [name, readFileSync(join(root, "objects", name)).toString()]);
      const before = objects();
      await assert.rejects(store.rewrapBatch({ ...input, writersStopped: false }), /writers_stopped/);
      await assert.rejects(store.rewrapBatch({ ...input, targetSecret: oldKey }), /distinct_key/);
      assert.equal(existsSync(join(root, PAYLOAD_KEY_STATE_FILE)), false);
      const first = await store.rewrapBatch(input);
      assert.equal(first.phase, "rewrapping"); assert.equal(first.processed, 1); assert.equal(first.cutover_ready, false);
      assert.throws(() => readyPayloadKeyState(root), /in_progress/);
      await assert.rejects(store.read(refs[0]), /in_progress/);
      await assert.rejects(store.write({ tenantId: "synthetic", appId: "app", objectId: "forbidden" }, Buffer.from("not admitted")), /in_progress/);
      const next = new EncryptedFilePayloadStore(root, newKey);
      await assert.rejects(next.verifyWrappedKeys(), /in_progress/, "retiring the old key cannot bypass full verification");
      await assert.rejects(store.rewrapBatch({ ...input, targetSecret: "synthetic-wrong-target-key-0000000000" }), /identity_mismatch/);
      let result = first;
      while (result.phase === "rewrapping") result = await new EncryptedFilePayloadStore(root, oldKey).rewrapBatch(input);
      assert.equal(result.cutover_ready, false);
      const name = readdirSync(join(root, "keys")).sort()[0], path = join(root, "keys", name), valid = readFileSync(path);
      const tampered = JSON.parse(valid.toString()); tampered.wrapping_key_id = "synthetic-forged";
      writeFileSync(path, JSON.stringify(tampered));
      await assert.rejects(store.rewrapBatch(input), /verification_failed/);
      assert.throws(() => readyPayloadKeyState(root), /in_progress/);
      writeFileSync(path, valid);
      while (!result.cutover_ready) result = await new EncryptedFilePayloadStore(root, oldKey).rewrapBatch(input);
      assert.equal(result.verified_key_checks, 3); assert.equal(result.old_backup_key_custody_required, true);
      assert.deepEqual(objects(), before, "rewrap must not touch encrypted payload bytes");
      await assert.rejects(store.read(refs[0]), /wrapping_key_mismatch/);
      await assert.rejects(store.write({ tenantId: "synthetic", appId: "app", objectId: "stale-writer" }, Buffer.from("not admitted")), /wrapping_key_mismatch/);
      for (let i = 0; i < refs.length; i++) assert.equal((await next.read(refs[i])).toString(), `synthetic evidence ${i}`);
      await next.verifyWrappedKeys();
      const fresh = await next.write({ tenantId: "synthetic", appId: "app", objectId: "fresh" }, Buffer.from("synthetic fresh"));
      assert.equal(JSON.parse(readFileSync(join(root, "keys", `${fresh.slice(10)}.json`), "utf8")).wrapping_key_id, "synthetic-v2");
      assert.equal((await new EncryptedFilePayloadStore(oldBackup, oldKey).read(refs[0])).toString(), "synthetic evidence 0");
      await assert.rejects(new EncryptedFilePayloadStore(oldBackup, newKey).read(refs[0]));
      assert.equal(await next.scanFor(oldKey), false); assert.equal(await next.scanFor(newKey), false);
      // A second rotation consumes the recorded identity rather than guessing a legacy alias.
      await assert.rejects(next.rewrapBatch({ ...input, fromKeyRef: "wrong-alias", toKeyRef: "synthetic-v3", targetSecret: oldKey }), /wrapping_key_mismatch/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("resumes after process death between key replacement and checkpoint without reviving a concurrent privacy purge", { timeout: 15_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "openmasu-rewrap-crash-"));
    const oldKey = "synthetic-crash-old-key-00000000000000", newKey = "synthetic-crash-next-key-0000000000000";
    const input = { fromKeyRef: "synthetic-v1", toKeyRef: "synthetic-v2", targetSecret: newKey, limit: 1, writersStopped: true };
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const store = new EncryptedFilePayloadStore(root, oldKey);
      const deleted = await store.write({ tenantId: "synthetic", appId: "app", objectId: "a-delete" }, Buffer.from("synthetic erased"));
      const retained = await store.write({ tenantId: "synthetic", appId: "app", objectId: "b-retain" }, Buffer.from("synthetic retained"));
      const code = `
        import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
        const original = fs.renameSync;
        fs.renameSync = (from,to) => { original(from,to); if (String(from).endsWith('.payload-key-entry.tmp')) {
          process.send('replacement-written', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0));
          // Keep the checkpoint unwritten until the parent terminates this owned process.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }};
        syncBuiltinESMExports();
        const {EncryptedFilePayloadStore} = await import(${JSON.stringify(new URL("./payload-store.ts", import.meta.url).href)});
        await new EncryptedFilePayloadStore(${JSON.stringify(root)}, ${JSON.stringify(oldKey)}).rewrapBatch(${JSON.stringify(input)});
      `;
      child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
      const message = once(child, "message", { signal: AbortSignal.timeout(5_000) });
      await message;
      assert.equal(JSON.parse(readFileSync(join(root, PAYLOAD_KEY_STATE_FILE), "utf8")).after, null);
      const purging = store.purge(deleted); // Waits for the same root lease, never races rename.
      const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
      assert.throws(() => recoverOfflinePayloadLock(root, false), /writers_stopped/);
      await purging; // The proven-dead local owner is recovered without blocking normal worker restart.
      assert.equal(existsSync(join(root, "keys", `${deleted.slice(10)}.json`)), false);
      let result;
      do { result = await new EncryptedFilePayloadStore(root, oldKey).rewrapBatch(input); } while (!result.cutover_ready);
      const next = new EncryptedFilePayloadStore(root, newKey);
      await assert.rejects(next.read(deleted), PayloadNotFoundError);
      assert.equal((await next.read(retained)).toString(), "synthetic retained");
      await next.purge(retained);
      assert.equal((await store.rewrapBatch(input)).cutover_ready, true);
      assert.deepEqual(readdirSync(join(root, "keys")), [], "repeating a completed rotation cannot resurrect a deleted key");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
