import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fileDigest } from "../apps/runtime/src/upgrade.js";
import { readRuntimeIdentity, type RuntimeIdentity } from "../apps/runtime/src/source-identity.js";

const services = ["bootstrap", "migrate", "api", "worker", "redirector", "seed", "operations"];
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export function imageOverride(imageId: string): string {
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  return `# Generated image-only override of the unchanged source Compose topology.\nservices:\n${services.map(name =>
    `  ${name}:\n    build: !reset null\n    image: ${imageId}\n    pull_policy: never\n    platform: linux/amd64\n`).join("")}`;
}
export function artifactVersion(revision: string, tag?: string): string {
  assert.match(revision, /^[a-f0-9]{40}$/);
  if (tag !== undefined) {
    assert.match(tag, /^runtime-v\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/);
    return tag.slice("runtime-v".length);
  }
  return `0.1.0-dev.${revision.slice(0, 12)}`;
}
export function identityFiles(paths: readonly string[]): string[] {
  return paths.filter(path => /^(apps\/|packages\/|db\/|schemas\/|registries\/|runtime-schemas\/|config\/|tools\/|package(?:-lock)?\.json$|sdk\/unity\/com\.openmasu\.sdk\/package\.json$)/.test(path)
    && !/\.(csv|tsv|xlsx?|parquet)$/.test(path) && !path.split("/").includes("input"));
}
function command(binary: string, args: string[], cwd: string): string {
  const result = spawnSync(binary, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    // Packaging uses committed public source only, never generated runtime secrets.
    console.error(`Runtime artifact packaging failed (${binary} ${args[0]}): ${result.stderr.slice(-4000)}`);
    throw new Error(`runtime_artifact_command_failed:${binary}:${args[0]}`);
  }
  return result.stdout.trim();
}
interface RuntimeManifest {
  format: "openmasu-runtime-artifact-v1"; version: string; source_revision: string; source_tag: string | null;
  sdk_version: string; contract_version: string; contract_patch: string; platform: "linux/amd64";
  image_id: string; archive: "runtime-image.tar"; files: Record<string, string>;
}
export async function verifyRuntimeBundle(bundle: string, imageRoot = process.cwd(), includeArchive = false): Promise<RuntimeManifest> {
  const identity = readRuntimeIdentity(imageRoot);
  if (!identity) throw new Error("runtime_artifact_image_identity_missing");
  const manifest = JSON.parse(readFileSync(join(bundle, "runtime-manifest.json"), "utf8")) as RuntimeManifest;
  assert.equal(manifest.format, "openmasu-runtime-artifact-v1");
  assert.match(manifest.image_id, /^sha256:[a-f0-9]{64}$/);
  assert.equal(manifest.platform, "linux/amd64");
  assert.equal(manifest.archive, "runtime-image.tar");
  for (const key of ["source_revision", "source_tag", "sdk_version", "contract_version", "contract_patch"] as const) assert.equal(manifest[key], identity[key]);
  assert.equal(manifest.version, identity.runtime_version);
  assert.equal(manifest.files["runtime-identity.json"], hash(readFileSync(join(imageRoot, ".runtime-identity.json"))));
  for (const required of ["compose.yaml", "compose.override.yaml", "runtime-image.tar", "runtime-identity.json", "runtime.cdx.json", "runtime.sh", ".env.example", "config/Caddyfile", "INSTALL.md"]) assert.ok(manifest.files[required]);
  for (const [file, digest] of Object.entries(manifest.files)) {
    assert.match(file, /^[a-zA-Z0-9_.\/-]+$/);
    assert.ok(!file.startsWith("/") && !file.split("/").includes(".."));
    assert.match(digest, /^[a-f0-9]{64}$/);
    if (file !== manifest.archive || includeArchive) assert.equal(await fileDigest(join(bundle, file)), digest, `runtime artifact checksum: ${file}`);
  }
  assert.equal(readFileSync(join(bundle, "compose.override.yaml"), "utf8"), imageOverride(manifest.image_id));
  const sbom = JSON.parse(readFileSync(join(bundle, "runtime.cdx.json"), "utf8"));
  assert.equal(sbom.metadata.component.version, manifest.version);
  assert.ok(sbom.metadata.properties.some((entry: { name: string; value: string }) => entry.name === "openmasu:image-id" && entry.value === manifest.image_id));
  return manifest;
}
export async function buildRuntimeArtifact(output: string, root = process.cwd(), tag?: string): Promise<RuntimeManifest> {
  output = resolve(output);
  assert.ok(!existsSync(output), "runtime artifact output already exists");
  assert.equal(command("git", ["status", "--porcelain=v1", "--untracked-files=all"], root), "", "runtime artifact requires clean committed source");
  const revision = command("git", ["rev-parse", "HEAD"], root), version = artifactVersion(revision, tag);
  if (tag) {
    assert.equal(command("git", ["cat-file", "-t", tag], root), "tag", "runtime publication needs an annotated tag");
    assert.equal(command("git", ["rev-parse", `${tag}^{commit}`], root), revision);
  }
  const staging = mkdtempSync(join(tmpdir(), "openmasu-runtime-build-"));
  try {
    // Only committed files reach the image; host .env, payloads and caches cannot.
    command("git", ["archive", "--format=tar", "--output", join(staging, "source.tar"), "HEAD"], root);
    const context = join(staging, "source"); mkdirSync(context);
    command("tar", ["-xf", join(staging, "source.tar"), "-C", context], root);
    const paths = command("git", ["ls-tree", "-r", "--name-only", "HEAD"], root).split(/\r?\n/);
    const patches = [...readFileSync(join(context, "docs/schema-versioning.md"), "utf8").matchAll(/^\|\s*(\d+)\.(\d+)\.(\d+)\s*\|/gm)]
      .map(match => [Number(match[1]), Number(match[2]), Number(match[3])]).sort((a, b) => a[0]-b[0] || a[1]-b[1] || a[2]-b[2]);
    const identity: RuntimeIdentity = { format: "openmasu-runtime-identity-v1", source_revision: revision, source_tag: tag ?? null,
      runtime_version: version, sdk_version: JSON.parse(readFileSync(join(context, "sdk/unity/com.openmasu.sdk/package.json"), "utf8")).version,
      contract_version: JSON.parse(readFileSync(join(context, "package.json"), "utf8")).version, contract_patch: patches.at(-1)!.join("."),
      files: Object.fromEntries(identityFiles(paths).map(file => [file, hash(readFileSync(join(context, file)))])) };
    writeFileSync(join(context, ".runtime-identity.json"), JSON.stringify(identity, null, 2) + "\n");
    const imageTag = `openmasu-runtime:${version}`;
    command("docker", ["build", "--platform", "linux/amd64", "--tag", imageTag,
      "--label", `org.opencontainers.image.revision=${revision}`, "--label", `org.opencontainers.image.version=${version}`,
      "--label", "org.opencontainers.image.source=https://github.com/yubisuke/openmasu", context], root);
    const inspect = JSON.parse(command("docker", ["image", "inspect", imageTag], root))[0];
    assert.equal(inspect.Os, "linux"); assert.equal(inspect.Architecture, "amd64");
    assert.equal(inspect.Config.Labels["org.opencontainers.image.revision"], revision);
    const imageId: string = inspect.Id;
    mkdirSync(output, { recursive: true });
    for (const file of ["compose.yaml", ".env.example", "config/Caddyfile"]) {
      mkdirSync(dirname(join(output, file)), { recursive: true }); copyFileSync(join(context, file), join(output, file));
    }
    copyFileSync(join(context, ".runtime-identity.json"), join(output, "runtime-identity.json"));
    writeFileSync(join(output, "compose.override.yaml"), imageOverride(imageId));
    command("docker", ["image", "save", "--output", join(output, "runtime-image.tar"), imageTag], root);
    const sbom = JSON.parse(command("docker", ["run", "--rm", "--network", "none", imageId, "npm", "sbom", "--sbom-format", "cyclonedx"], root));
    const packages = command("docker", ["run", "--rm", "--network", "none", imageId, "apk", "info", "-v"], root).split(/\r?\n/);
    const systemComponents = packages.map(line => {
      const match = /^(.+)-(\d.*)$/.exec(line); assert.ok(match, "Alpine inventory format");
      return { type: "library", group: "Alpine", name: match[1], version: match[2], "bom-ref": `apk:${match[1]}@${match[2]}` };
    });
    const nodeVersion = command("docker", ["run", "--rm", "--network", "none", imageId, "node", "--version"], root);
    systemComponents.push({ type: "application", group: "Node.js", name: "node", version: nodeVersion, "bom-ref": `node:${nodeVersion}` });
    sbom.components.push(...systemComponents);
    const previousRoot = sbom.metadata.component["bom-ref"];
    sbom.metadata.component = { type: "container", name: "openmasu-runtime", version, "bom-ref": imageId };
    for (const dependency of sbom.dependencies ?? []) {
      if (dependency.ref === previousRoot) {
        dependency.ref = imageId;
        dependency.dependsOn = [...(dependency.dependsOn ?? []), ...systemComponents.map(component => component["bom-ref"])];
      }
      dependency.dependsOn = (dependency.dependsOn ?? []).map((ref: string) => ref === previousRoot ? imageId : ref);
    }
    sbom.metadata.properties = [{ name: "openmasu:image-id", value: imageId }, { name: "openmasu:source-revision", value: revision }];
    writeFileSync(join(output, "runtime.cdx.json"), JSON.stringify(sbom, null, 2) + "\n");
    writeFileSync(join(output, "runtime.sh"), `#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\nIMAGE='${imageId}'\ncase "\${1:-}" in\n  verify) sha256sum -c SHA256SUMS; exit ;;\n  load) sha256sum -c SHA256SUMS; docker image load --input runtime-image.tar; shift ;;\n  compose) shift ;;\n  *) echo 'Usage: sh runtime.sh verify | load | compose [docker compose arguments]' >&2; exit 2 ;;\nesac\n[ "$(docker image inspect --format '{{.Id}}' "$IMAGE")" = "$IMAGE" ]\ndocker run --rm --network none --mount "type=bind,src=$(pwd),dst=/bundle,readonly" "$IMAGE" node --import tsx tools/runtime-artifact.ts --verify=/bundle\n[ "$#" -gt 0 ] || exit 0\nexec docker compose -f compose.yaml -f compose.override.yaml "$@"\n`);
    writeFileSync(join(output, "INSTALL.md"), `# OpenMasu runtime ${version}\n\nSource: ${revision}\nTag: ${tag ?? "none (development candidate, not a published release)"}\nSDK: ${identity.sdk_version}; contract wire: ${identity.contract_version}; patch: ${identity.contract_patch}.\n\nLinux amd64, Docker Engine and Compose 2.24.4+ are required. No host Node/npm/Python/Git is needed.\nVerify SHA256SUMS against a trusted publisher receipt before running these files. Checksums prove byte consistency, not publisher authenticity.\n\n\`\`\`sh\nsh runtime.sh verify\nsh runtime.sh load\ncp .env.example .env\n# Set deployment purpose and public URLs in .env; keep secrets private.\nsh runtime.sh compose up -d --wait --no-build\n\`\`\`\n\nThe default is persistent: seed/reset is refused. PostgreSQL and the optional proxy still pull their declared images. This is not an offline bundle. Keep this directory, .env and the Compose project name stable for existing volumes. Never use down --volumes on a persistent deployment.\n\nThe image includes migrations and PostgreSQL 17 backup tools. Use the operations profile with a private backup directory mounted at /private; stop all writers first. See https://github.com/yubisuke/openmasu/blob/${revision}/docs/operations/runtime-artifacts.md for upgrade/backup/recovery commands and publication boundaries.\n`);
    const files = ["runtime-image.tar", "runtime-identity.json", "runtime.cdx.json", "compose.yaml", "compose.override.yaml", "config/Caddyfile", ".env.example", "runtime.sh", "INSTALL.md"];
    const manifest: RuntimeManifest = { format: "openmasu-runtime-artifact-v1", version, source_revision: revision, source_tag: tag ?? null,
      sdk_version: identity.sdk_version, contract_version: identity.contract_version, contract_patch: identity.contract_patch,
      platform: "linux/amd64", image_id: imageId, archive: "runtime-image.tar", files: {} };
    for (const file of files) manifest.files[file] = await fileDigest(join(output, file));
    writeFileSync(join(output, "runtime-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(output, "SHA256SUMS"), [...Object.entries(manifest.files), ["runtime-manifest.json", await fileDigest(join(output, "runtime-manifest.json"))]]
      .map(([file, digest]) => `${digest}  ${file}`).join("\n") + "\n");
    await verifyRuntimeBundle(output, context, true);
    return manifest;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0].startsWith("--verify=")) {
    await verifyRuntimeBundle(args[0].slice(9)); console.log("Runtime artifact identity and deployment files verified.");
  } else {
    const output = args.find(arg => arg.startsWith("--output="))?.slice(9), tag = args.find(arg => arg.startsWith("--tag="))?.slice(6);
    assert.ok(output && args.every(arg => arg.startsWith("--output=") || arg.startsWith("--tag=")) && args.length === (tag ? 2 : 1));
    const manifest = await buildRuntimeArtifact(output, process.cwd(), tag);
    console.log(JSON.stringify({ runtime_artifact: "built", version: manifest.version, source_revision: manifest.source_revision, source_tag: manifest.source_tag, image_id: manifest.image_id }));
  }
}
