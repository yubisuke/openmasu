import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { EncryptedFilePayloadStore } from "./payload-store.js";
import { checkBackup, createPrivateDirectory, payloadInventory, validatePrivacyBoundary, type BackupManifest } from "./backup.js";
import { fileDigest, migrationDigest } from "./upgrade.js";
import { readMigrations } from "./migration-engine.js";

it("backup preflight rejects stale backups and untrusted or stale privacy checkpoints without writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openmasu-backup-unit-"));
  try {
    const now = new Date("2026-10-11T12:00:00.000Z");
    const boundary = { format: "openmasu-privacy-boundary-v1" as const, captured_at: now.toISOString(), request_count: 0,
      request_digest: "a".repeat(64), tenant_digest: "b".repeat(64) };
    assert.throws(() => validatePrivacyBoundary({ ...boundary, raw_subject: "synthetic" }), /boundary_invalid/);
    assert.throws(() => validatePrivacyBoundary({ ...boundary, request_count: -1 }), /boundary_invalid/);
    await mkdir(join(directory, "payloads"));
    for (const name of ["objects", "keys"]) await mkdir(join(directory, "payloads", name));
    await writeFile(join(directory, "database.dump"), "synthetic archive bytes");
    const manifest: BackupManifest = { format: "openmasu-backup-v1", bundle_id: "11111111-1111-4111-8111-111111111111",
      captured_at: "2026-10-11T11:00:00.000Z", completed_at: "2026-10-11T11:01:00.000Z", source_revision: "c".repeat(40),
      postgres_major: 17, migration_digest: migrationDigest(readMigrations()), master_key_ref: "synthetic-key",
      master_key_check: "d".repeat(64), database_sha256: await fileDigest(join(directory, "database.dump")),
      objects: await payloadInventory(join(directory, "payloads", "objects")), keys: await payloadInventory(join(directory, "payloads", "keys")),
      privacy: { ...boundary, captured_at: "2026-10-11T11:00:00.000Z" } };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    const input = { directory, boundary, now, revision: manifest.source_revision, maximumAgeHours: 24 };
    assert.deepEqual(await checkBackup(input), manifest);
    const before = await fileDigest(join(directory, "manifest.json"));
    await assert.rejects(checkBackup({ ...input, maximumAgeHours: 0.5 }), /freshness_failed/);
    await assert.rejects(checkBackup({ ...input, boundary: { ...boundary, captured_at: "2026-10-11T11:44:00.000Z" } }), /freshness_failed/);
    await assert.rejects(checkBackup({ ...input, boundary: { ...boundary, request_digest: "e".repeat(64) } }), /privacy_boundary_mismatch/);
    assert.equal(await fileDigest(join(directory, "manifest.json")), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("backup rejects repository and reused destinations, and verifies the actual wrapping key", async () => {
  await assert.rejects(createPrivateDirectory(join(process.cwd(), "backup-forbidden")), /outside_repository/);
  const root = await mkdtemp(join(tmpdir(), "openmasu-backup-key-"));
  try {
    await assert.rejects(createPrivateDirectory(root), /EEXIST/);
    const store = new EncryptedFilePayloadStore(root, "synthetic-backup-master-key-0000000000");
    await store.write({ tenantId: "tenant-synthetic", appId: "app-synthetic", objectId: "object-synthetic" }, Buffer.from("synthetic only"));
    await store.verifyWrappedKeys();
    await assert.rejects(new EncryptedFilePayloadStore(root, "wrong-synthetic-backup-master-00000000").verifyWrappedKeys());
    await mkdir(join(root, "keys", "not-a-file"));
    await assert.rejects(payloadInventory(join(root, "keys")), /regular_file_required/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
