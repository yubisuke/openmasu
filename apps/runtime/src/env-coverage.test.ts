import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child) : [child];
  });
}

const root = process.cwd();
const sourceFiles = ["apps", "packages"].flatMap((path) => files(join(root, path)))
  .filter((path) => /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(path));
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

console.log(`Environment coverage passed: ${names.size} variables, 0 missing.`);
