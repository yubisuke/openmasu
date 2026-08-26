import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const excludedDirectories = new Set([".git", ".openmasu", "build", "node_modules"]);

function markdownFiles(root: string, directory = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory).sort()) {
    if (excludedDirectories.has(entry)) continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) files.push(...markdownFiles(root, path));
    else if (entry.endsWith(".md")) files.push(path);
  }
  return files;
}

function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export function headingAnchors(markdown: string): Set<string> {
  const counts = new Map<string, number>();
  const anchors = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (!match) continue;
    const base = slug(match[1]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

export function localMarkdownLinks(markdown: string): string[] {
  return [...markdown.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)]
    .map((match) => match[1].trim().replace(/^<|>$/g, ""))
    .filter((target) => !/^(?:https?:|mailto:)/i.test(target));
}

export function documentationLinkFailures(root: string): string[] {
  const failures: string[] = [];
  for (const source of markdownFiles(root)) {
    const sourceText = readFileSync(source, "utf8");
    for (const target of localMarkdownLinks(sourceText)) {
      const [rawPath, rawAnchor] = target.split("#", 2);
      const targetPath = rawPath.length === 0 ? source : resolve(dirname(source), decodeURIComponent(rawPath));
      const label = `${relative(root, source).split(sep).join("/")} -> ${target}`;
      if (!existsSync(targetPath)) {
        failures.push(`${label} (missing file)`);
        continue;
      }
      if (rawAnchor && targetPath.endsWith(".md")) {
        const anchors = headingAnchors(readFileSync(targetPath, "utf8"));
        if (!anchors.has(decodeURIComponent(rawAnchor).toLowerCase())) failures.push(`${label} (missing heading)`);
      }
    }
  }
  return failures;
}

export function checkDocumentationLinks(root = process.cwd()): void {
  const failures = documentationLinkFailures(root);
  assert.deepEqual(failures, [], `documentation links are invalid:\n${failures.join("\n")}`);
  console.log(`Documentation link check passed for ${markdownFiles(root).length} Markdown files.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) checkDocumentationLinks();
