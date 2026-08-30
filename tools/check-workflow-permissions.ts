import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertLeastPrivilegeWorkflow(source: string, label = "workflow"): void {
  const lines = source.split(/\r?\n/);
  const topLevel = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^permissions:\s*(?:#.*)?$/.test(line));
  if (topLevel.length !== 1) {
    throw new Error(`${label} must contain exactly one top-level permissions block`);
  }
  if (lines.some((line) => /^\s+permissions:\s*(?:#.*)?$/.test(line))) {
    throw new Error(`${label} must not override permissions at job or step scope`);
  }

  const entries: Array<[string, string]> = [];
  for (let index = topLevel[0].index + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break;
    const match = /^  ([a-z-]+):\s*([a-z-]+)\s*(?:#.*)?$/.exec(line);
    if (!match) throw new Error(`${label} contains an unsupported permissions entry: ${line.trim()}`);
    entries.push([match[1], match[2]]);
  }

  if (entries.length !== 1 || entries[0][0] !== "contents" || entries[0][1] !== "read") {
    const rendered = entries.map(([name, value]) => `${name}:${value}`).join(",") || "none";
    throw new Error(`${label} permissions must be exactly contents:read; received ${rendered}`);
  }
}

export function checkWorkflowPermissions(root = process.cwd()): number {
  const workflowDirectory = resolve(root, ".github/workflows");
  const workflowNames = readdirSync(workflowDirectory)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort();
  if (workflowNames.length === 0) throw new Error("repository contains no GitHub Actions workflows");
  for (const name of workflowNames) {
    assertLeastPrivilegeWorkflow(readFileSync(resolve(workflowDirectory, name), "utf8"), name);
  }
  return workflowNames.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const count = checkWorkflowPermissions();
  console.log(`Workflow permission check passed: ${count} workflows use only contents: read.`);
}
