import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function componentMarkers(source: string, kind: string): string[] {
  const values = [...source.matchAll(new RegExp(`<!-- ${kind}:([a-z0-9-]+) -->`, "g"))]
    .map((match) => match[1]);
  if (values.length === 0) throw new Error(`document contains no ${kind} markers`);
  if (new Set(values).size !== values.length) throw new Error(`document contains duplicate ${kind} markers`);
  return values.sort();
}

export function assertThreatModelCoverage(architectureSource: string, threatSource: string): number {
  const architecture = componentMarkers(architectureSource, "m1-component");
  const threats = componentMarkers(threatSource, "threat-component");
  if (JSON.stringify(architecture) !== JSON.stringify(threats)) {
    throw new Error(`threat model component coverage differs: architecture=${architecture.join(",")} threats=${threats.join(",")}`);
  }
  return architecture.length;
}

export function checkThreatModelCoverage(root = process.cwd()): number {
  const architecture = readFileSync(resolve(root, "docs/architecture.md"), "utf8");
  const threats = readFileSync(resolve(root, "docs/threat-model.md"), "utf8");
  return assertThreatModelCoverage(architecture, threats);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const count = checkThreatModelCoverage();
  console.log(`Threat model coverage passed: ${count} runtime components.`);
}
