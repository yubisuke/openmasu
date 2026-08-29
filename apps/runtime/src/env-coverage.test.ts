import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child) : [child];
  });
}

const root = process.cwd();
const sourceFiles = ["apps", "packages"].flatMap((path) => files(join(root, path)))
  .filter((path) => /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(path));
const referenceFiles = [...sourceFiles, ...files(join(root, "tools"))
  .filter((path) => /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(path))];
const names = new Set<string>();
const dynamicReads: string[] = [];
for (const path of sourceFiles) {
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(match[1]);
  if (/process\.env\s*\[/.test(source)) dynamicReads.push(relative(root, path));
}

if (dynamicReads.length) throw new Error(`dynamic environment reads are not auditable: ${dynamicReads.join(", ")}`);
const example = readFileSync(join(root, ".env.example"), "utf8");
const documented = new Set(
  [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]),
);
const missing = [...names].filter((name) => !documented.has(name)).sort();
if (missing.length) throw new Error(`environment variables missing from .env.example: ${missing.join(", ")}`);

const referenceText = [
  ...referenceFiles.map((path) => readFileSync(path, "utf8")),
  readFileSync(join(root, "compose.yaml"), "utf8"),
].join("\n");
const stale = [...documented].filter((name) => !referenceText.includes(name)).sort();
if (stale.length) throw new Error(`unused variables must be removed from .env.example: ${stale.join(", ")}`);

console.log(`Environment coverage passed: ${names.size} runtime variables, 0 missing, ${documented.size} documented variables, 0 unused.`);
