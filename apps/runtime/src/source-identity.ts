import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface RuntimeIdentity {
  format: "openmasu-runtime-identity-v1";
  source_revision: string;
  source_tag: string | null;
  runtime_version: string;
  sdk_version: string;
  contract_version: string;
  contract_patch: string;
  files: Record<string, string>;
}
export function readRuntimeIdentity(root = process.cwd()): RuntimeIdentity | undefined {
  const path = join(root, ".runtime-identity.json");
  if (!existsSync(path)) return undefined;
  const identity = JSON.parse(readFileSync(path, "utf8")) as RuntimeIdentity;
  if (identity.format !== "openmasu-runtime-identity-v1" || !/^[a-f0-9]{40}$/.test(identity.source_revision)
    || typeof identity.runtime_version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.]+)?$/.test(identity.runtime_version)
    || (identity.source_tag !== null && identity.source_tag !== `runtime-v${identity.runtime_version}`)
    || !identity.files || !identity.files["package-lock.json"] || !identity.files["db/schema.sql"]
    || !identity.files["apps/runtime/src/source-identity.ts"]) throw new Error("runtime_identity_invalid");
  for (const [file, digest] of Object.entries(identity.files)) {
    if (!/^[a-zA-Z0-9_.@/~-]+$/.test(file) || file.startsWith("/") || file.split("/").includes("..")
      || !/^[a-f0-9]{64}$/.test(digest)
      || createHash("sha256").update(readFileSync(join(root, file))).digest("hex") !== digest) throw new Error("runtime_identity_file_mismatch");
  }
  return identity;
}
// Image identity is fixed at packaging; an environment variable cannot replace it.
// Consumers must first verify the archive checksum and loaded image ID.
export function sourceIdentity(root = process.cwd()): { revision: string; runtime?: RuntimeIdentity } {
  if (!existsSync(join(root, ".git"))) {
    const runtime = readRuntimeIdentity(root);
    if (runtime) return { revision: runtime.source_revision, runtime };
  }
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("backup_clean_checkout_required");
  return { revision: git(["rev-parse", "HEAD"]) };
}
export function assertUpgradeTarget(target: string, root = process.cwd()): void {
  const identity = sourceIdentity(root);
  if (identity.runtime) {
    if (!identity.runtime.source_tag || target !== identity.runtime.source_tag) throw new Error("upgrade_target_identity_mismatch");
    return;
  }
  const sdkVersion = JSON.parse(readFileSync(join(root, "sdk/unity/com.openmasu.sdk/package.json"), "utf8")).version;
  if (target !== `v${sdkVersion}` || !/^v\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(target)) throw new Error("upgrade_target_unsupported");
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git(["cat-file", "-t", target]) !== "tag" || git(["rev-parse", `${target}^{commit}`]) !== identity.revision
      || git(["status", "--porcelain"])) throw new Error("upgrade_target_identity_mismatch");
}
