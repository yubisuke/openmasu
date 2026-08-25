import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Counts = Record<string, number>;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const baselineTag = "contract-v0.3.6";
const verificationRef = "v0.1.0";
const safeRoot = root.replaceAll("\\", "/");
const gitArgs = ["-c", `safe.directory=${safeRoot}`];

function fail(message: string): never {
  throw new Error(message);
}

function git(...args: string[]): string {
  return execFileSync("git", [...gitArgs, ...args], { cwd: root, encoding: "utf8" }).trim();
}

function gitBytes(...args: string[]): Buffer {
  return execFileSync("git", [...gitArgs, ...args], { cwd: root });
}

function baselineGroup(prefix: string): Map<string, string> {
  const entries = git("ls-tree", "-r", baselineTag, prefix).split(/\r?\n/).filter(Boolean).map((line) => {
    const match = /^(?:\d+) blob ([a-f0-9]+)\t(.+)$/.exec(line);
    if (!match) fail(`unexpected git ls-tree row: ${line}`);
    return { oid: match[1], path: match[2] };
  });
  const response = execFileSync("git", [...gitArgs, "cat-file", "--batch"], {
    cwd: root,
    input: `${entries.map((entry) => entry.oid).join("\n")}\n`,
    maxBuffer: 64 * 1024 * 1024,
  });
  let offset = 0;
  const result = new Map<string, string>();
  for (const entry of entries) {
    const newline = response.indexOf(0x0a, offset);
    if (newline < 0) fail(`missing cat-file header for ${entry.path}`);
    const header = response.subarray(offset, newline).toString("utf8");
    const match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
    if (!match || match[1] !== entry.oid) fail(`unexpected cat-file header for ${entry.path}: ${header}`);
    const size = Number(match[2]);
    const start = newline + 1;
    result.set(entry.path, response.subarray(start, start + size).toString("utf8"));
    offset = start + size + 1;
  }
  return result;
}

function parse(text: string, label: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch (error) {
    return fail(`${label} is not valid JSON: ${String(error)}`);
  }
}

function currentJson(path: string): Json {
  return parse(git("show", `${verificationRef}:${path}`), `${verificationRef}:${path}`);
}

function renamed(value: string): string {
  const replacements = [
    ["OPEN" + "MMP", "OPENMASU"],
    ["Open" + "MMP", "OpenMasu"],
    ["Open" + "Mmp", "OpenMasu"],
    ["open" + "Mmp", "openMasu"],
    ["open" + "-mmp", "openmasu"],
    ["open" + "_mmp", "openmasu"],
    ["open" + "mmp", "openmasu"],
    ["Open" + " MMP", "OpenMasu"],
  ] as const;
  return replacements.reduce((result, [from, to]) => result.replaceAll(from, to), value);
}

const contractVersionKeys = new Set([
  "contract_version",
  "schema_version",
  "reason_code_version",
  "difference_reason_version",
]);

const derivedDigestRenames = new Map<string, string>([
  ["905cc3a69e7b7e0a2da55439444aed7e67087c1e96c5e958c5650f04606197b5", "593b3db37b01680452064eacbc32c135832c977933c2a8ac7437fd9d2a50b4ed"],
  ["db1c5fa5ca40a9731b531021f0c34d540fb9f14d2d1836a33fecb7fc36757c87", "3165088f0016e2d7745abfce00a76707c9fb812540dd6e999455e551a3079574"],
  ["05479c420b0300de0ab0d0d0c50a247e88a6123a6c29f947c1a4f687162ccfc4", "b702b0728fbe7d6bf6155c711c515457c27c03e08a9fdd535cb657ed4bf98cba"],
]);

function bump(counts: Counts, name: string): void {
  counts[name] = (counts[name] ?? 0) + 1;
}

function compareFixture(base: Json, current: Json, path: readonly string[], counts: Counts): void {
  if (Array.isArray(base) || Array.isArray(current)) {
    if (!Array.isArray(base) || !Array.isArray(current) || base.length !== current.length) {
      fail(`semantic fixture difference at ${path.join(".")}: array shape changed`);
    }
    base.forEach((value, index) => compareFixture(value, current[index], [...path, String(index)], counts));
    return;
  }
  if (base && current && typeof base === "object" && typeof current === "object") {
    const baseKeys = Object.keys(base).sort();
    const currentKeys = Object.keys(current).sort();
    if (JSON.stringify(baseKeys) !== JSON.stringify(currentKeys)) {
      fail(`semantic fixture difference at ${path.join(".")}: object fields changed`);
    }
    for (const key of baseKeys) compareFixture(base[key], current[key], [...path, key], counts);
    return;
  }
  if (Object.is(base, current)) return;
  const key = path.at(-1) ?? "";
  if (contractVersionKeys.has(key) && base === "0.3.0" && current === "0.4.0") {
    bump(counts, "CONTRACT_SEMVER");
    return;
  }
  if (typeof base === "string" && typeof current === "string" && renamed(base) === current) {
    bump(counts, "NAME_DERIVED");
    return;
  }
  if (typeof base === "string" && derivedDigestRenames.get(base) === current) {
    bump(counts, "DERIVED_DIGEST");
    return;
  }
  fail(`semantic fixture difference at ${path.join(".")}: ${JSON.stringify(base)} -> ${JSON.stringify(current)}`);
}

function compareSchema(base: Json, current: Json, path: readonly string[], counts: Counts): void {
  if (Array.isArray(base) || Array.isArray(current)) {
    if (!Array.isArray(base) || !Array.isArray(current) || base.length !== current.length) {
      fail(`schema structure changed at ${path.join(".")}`);
    }
    base.forEach((value, index) => compareSchema(value, current[index], [...path, String(index)], counts));
    return;
  }
  if (base && current && typeof base === "object" && typeof current === "object") {
    const baseKeys = Object.keys(base).sort();
    const currentKeys = Object.keys(current).sort();
    if (JSON.stringify(baseKeys) !== JSON.stringify(currentKeys)) {
      fail(`schema fields changed at ${path.join(".")}`);
    }
    for (const key of baseKeys) compareSchema(base[key], current[key], [...path, key], counts);
    return;
  }
  if (Object.is(base, current)) return;
  if (typeof base === "string" && typeof current === "string") {
    const urn = renamed(base).replace(/:v0\.3(?=$|#)/, ":v0.4");
    if (urn === current && base.startsWith("urn:")) {
      bump(counts, "SCHEMA_URN");
      return;
    }
    const title = renamed(base).replace(/ v0\.3$/, " v0.4");
    if (title === current && path.at(-1) === "title") {
      bump(counts, "SCHEMA_TITLE");
      return;
    }
    if (renamed(base) === current) {
      bump(counts, "NAME_DERIVED");
      return;
    }
    if (base === "0.3.0" && current === "0.4.0" && path.some((part) => contractVersionKeys.has(part))) {
      bump(counts, "CONTRACT_SEMVER");
      return;
    }
  }
  fail(`schema semantic difference at ${path.join(".")}: ${JSON.stringify(base)} -> ${JSON.stringify(current)}`);
}

function compareRegistry(base: Json, current: Json, path: readonly string[], counts: Counts): void {
  if (Array.isArray(base) || Array.isArray(current)) {
    if (!Array.isArray(base) || !Array.isArray(current) || base.length !== current.length) {
      fail(`registry structure changed at ${path.join(".")}`);
    }
    base.forEach((value, index) => compareRegistry(value, current[index], [...path, String(index)], counts));
    return;
  }
  if (base && current && typeof base === "object" && typeof current === "object") {
    const baseKeys = Object.keys(base).sort();
    const currentKeys = Object.keys(current).sort();
    if (JSON.stringify(baseKeys) !== JSON.stringify(currentKeys)) {
      fail(`registry fields changed at ${path.join(".")}`);
    }
    for (const key of baseKeys) compareRegistry(base[key], current[key], [...path, key], counts);
    return;
  }
  if (Object.is(base, current)) return;
  if (path.at(-1) === "contract_version" && base === "0.3.0" && current === "0.4.0") {
    bump(counts, "CONTRACT_SEMVER");
    return;
  }
  if (typeof base === "string" && typeof current === "string" && renamed(base) === current) {
    bump(counts, "NAME_DERIVED");
    return;
  }
  fail(`registry semantic difference at ${path.join(".")}: ${JSON.stringify(base)} -> ${JSON.stringify(current)}`);
}

const baselineCommit = git("rev-parse", `${baselineTag}^{}`);
execFileSync("git", [...gitArgs, "merge-base", "--is-ancestor", baselineCommit, "HEAD"], { cwd: root });

const fixtureCounts: Counts = {};
const fixtureFileSummary = new Map<string, { files: number; leafChanges: number }>();
const oldFixtures = baselineGroup("fixtures/v0.3");
const oldFixtureFiles = [...oldFixtures.keys()].sort();
const expectedFixtureFiles = oldFixtureFiles.map((path) => path.replace(/^fixtures\/v0\.3/, "fixtures/v0.4"));
const actualFixtureFiles = git("ls-tree", "-r", "--name-only", verificationRef, "fixtures/v0.4").split(/\r?\n/).filter(Boolean).sort();
if (JSON.stringify(expectedFixtureFiles) !== JSON.stringify(actualFixtureFiles)) fail("fixture path inventory changed");
for (const oldPath of oldFixtureFiles.filter((path) => path.endsWith(".json"))) {
  const newPath = oldPath.replace(/^fixtures\/v0\.3/, "fixtures/v0.4");
  const localCounts: Counts = {};
  compareFixture(parse(oldFixtures.get(oldPath) ?? fail(`missing baseline fixture ${oldPath}`), oldPath), currentJson(newPath), [newPath], localCounts);
  const leafChanges = Object.values(localCounts).reduce((sum, value) => sum + value, 0);
  if (leafChanges > 0) {
    const name = newPath.split("/").at(-1) ?? newPath;
    const current = fixtureFileSummary.get(name) ?? { files: 0, leafChanges: 0 };
    fixtureFileSummary.set(name, { files: current.files + 1, leafChanges: current.leafChanges + leafChanges });
  }
  for (const [name, value] of Object.entries(localCounts)) fixtureCounts[name] = (fixtureCounts[name] ?? 0) + value;
}

const schemaCounts: Counts = {};
const baselineSchemas = baselineGroup("schemas");
const oldSchemas = [...baselineSchemas.keys()].filter((path) => path.endsWith(".json")).sort();
const currentSchemas = git("ls-tree", "-r", "--name-only", verificationRef, "schemas").split(/\r?\n/).filter((path) => path.endsWith(".json")).sort();
if (JSON.stringify(oldSchemas) !== JSON.stringify(currentSchemas)) fail("schema inventory changed");
for (const path of oldSchemas) compareSchema(parse(baselineSchemas.get(path) ?? fail(`missing baseline schema ${path}`), path), currentJson(path), [path], schemaCounts);

const registryCounts: Counts = {};
const baselineRegistries = baselineGroup("registries");
const oldRegistries = [...baselineRegistries.keys()].filter((path) => path.endsWith("-v0.3.json")).sort();
const expectedRegistries = oldRegistries.map((path) => path.replace(/-v0\.3\.json$/, "-v0.4.json"));
const currentRegistries = git("ls-tree", "-r", "--name-only", verificationRef, "registries").split(/\r?\n/).filter(Boolean).sort();
if (JSON.stringify(expectedRegistries) !== JSON.stringify(currentRegistries)) fail("registry path inventory changed");
oldRegistries.forEach((oldPath, index) => compareRegistry(
  parse(baselineRegistries.get(oldPath) ?? fail(`missing baseline registry ${oldPath}`), oldPath),
  currentJson(expectedRegistries[index]),
  [expectedRegistries[index]],
  registryCounts,
));

const conversionPath = join(root, "sdk/ios/Sources/OpenMasuApplePostback/Resources/conversion-schema-v1.json");
const unityConversionPath = join(root, "sdk/unity/com.openmasu.sdk/Runtime/Plugins/iOS/Sources/OpenMasuApplePostback/Resources/conversion-schema-v1.json");
const conversionBytes = gitBytes("show", `${verificationRef}:${relative(root, conversionPath).replaceAll("\\", "/")}`);
const unityConversionBytes = gitBytes("show", `${verificationRef}:${relative(root, unityConversionPath).replaceAll("\\", "/")}`);
if (!conversionBytes.equals(unityConversionBytes)) fail("Swift and Unity conversion schemas differ");
const conversionDigest = createHash("sha256").update(conversionBytes).digest("hex");
const fixture45 = currentJson("fixtures/v0.4/45-ios-conversion-schema/input.json") as unknown as { records: Array<{ payload?: { extensions?: { conversion_schema_sha256?: string } } }> };
if (fixture45.records[0]?.payload?.extensions?.conversion_schema_sha256 !== conversionDigest) {
  fail("fixture 45 does not carry the renamed conversion-schema byte digest");
}

const inputs = actualFixtureFiles.filter((path) => path.endsWith("/input.json")).length;
const goldens = actualFixtureFiles.filter((path) => /\/expected_[^/]+\.json$/.test(path)).length;
const fixtureDirectories = new Set(actualFixtureFiles.map((path) => path.split("/")[2]).filter((name) => /^\d{2}-/.test(name))).size;

console.log(`Contract v0.4 rename proof: ${baselineTag} (${baselineCommit})`);
console.log(`Schemas: ${oldSchemas.length}; ${Object.entries(schemaCounts).map(([key, value]) => `${key}=${value}`).join(", ")}; SEMANTIC_DIFF=0`);
console.log(`Registries: ${oldRegistries.length}; PATH_RENAME=${oldRegistries.length}; ${Object.entries(registryCounts).map(([key, value]) => `${key}=${value}`).join(", ")}; SEMANTIC_DIFF=0`);
console.log(`Fixtures: ${fixtureDirectories} inputs=${inputs} goldens=${goldens} files=${actualFixtureFiles.length}`);
console.log(`Fixture diff classification: PATH_RENAME=${actualFixtureFiles.length}; CONTRACT_SEMVER=${fixtureCounts.CONTRACT_SEMVER ?? 0}; NAME_DERIVED=${fixtureCounts.NAME_DERIVED ?? 0}; DERIVED_DIGEST=${fixtureCounts.DERIVED_DIGEST ?? 0}; SEMANTIC_DIFF=0`);
console.log(`Content-changed fixture JSON: ${[...fixtureFileSummary.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value.files} files/${value.leafChanges} leaves`).join("; ")}`);
console.log(`Conversion schema SHA-256: ${conversionDigest}`);
