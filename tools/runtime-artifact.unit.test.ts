import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { artifactVersion, identityFiles, imageOverride } from "./runtime-artifact.js";
import { assertUpgradeTarget, readRuntimeIdentity, sourceIdentity } from "../apps/runtime/src/source-identity.js";

it("runtime_archive_uses_only_pinned_image_ids_and_distinct_source_tag_identity", () => {
  const sha = "a".repeat(40), id = `sha256:${"b".repeat(64)}`;
  assert.equal(artifactVersion(sha), `0.1.0-dev.${sha.slice(0, 12)}`);
  assert.equal(artifactVersion(sha, "runtime-v0.1.0-rc.1"), "0.1.0-rc.1");
  assert.throws(() => artifactVersion(sha, "v0.3.0-rc.3"));
  assert.throws(() => imageOverride("openmasu:latest"));
  const override = imageOverride(id);
  assert.equal(override.match(/build: !reset null/g)?.length, 7);
  assert.equal(override.match(/pull_policy: never/g)?.length, 7);
  assert.deepEqual(identityFiles([".env", "docs/review/private.md", "apps/api/a.ts", "examples/input/export.csv", "db/schema.sql", "package-lock.json"]),
    ["apps/api/a.ts", "db/schema.sql", "package-lock.json"]);
});
it("runtime_source_identity_rejects_modified_files_and_candidate_upgrade_without_host_Git", () => {
  const root = mkdtempSync(join(tmpdir(), "openmasu-artifact-unit-"));
  try {
    const files: Record<string, string> = {};
    for (const path of ["package-lock.json", "db/schema.sql", "apps/runtime/src/source-identity.ts"]) {
      mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), "synthetic\n");
      files[path] = createHash("sha256").update("synthetic\n").digest("hex");
    }
    const identity = { format: "openmasu-runtime-identity-v1", source_revision: "a".repeat(40), source_tag: null as string | null,
      runtime_version: "0.1.0-rc.1", sdk_version: "0.3.0-rc.3", contract_version: "0.4.0", contract_patch: "0.4.33", files };
    const save = () => writeFileSync(join(root, ".runtime-identity.json"), JSON.stringify(identity));
    save(); assert.equal(sourceIdentity(root).revision, identity.source_revision);
    assert.throws(() => assertUpgradeTarget("runtime-v0.1.0-rc.1", root), /upgrade_target_identity_mismatch/);
    identity.source_tag = "runtime-v0.1.0-rc.1"; save();
    assert.doesNotThrow(() => assertUpgradeTarget(identity.source_tag!, root));
    assert.throws(() => assertUpgradeTarget("runtime-v0.1.0-rc.2", root), /upgrade_target_identity_mismatch/);
    writeFileSync(join(root, "db/schema.sql"), "changed");
    assert.throws(() => readRuntimeIdentity(root), /runtime_identity_file_mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
