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

export function assertThreatComponentStructure(source: string): number {
  const markerPattern = /<!-- threat-component:([a-z0-9-]+) -->/g;
  const matches = [...source.matchAll(markerPattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const component = match[1];
    const start = (match.index ?? 0) + match[0].length;
    const nextMarker = matches[index + 1]?.index ?? source.length;
    const nextHeadingOffset = source.slice(start, nextMarker).search(/\n##\s/);
    const end = nextHeadingOffset === -1 ? nextMarker : start + nextHeadingOffset;
    const section = source.slice(start, end);
    const label = /^\s*\*\*([^*\r\n]+):\*\*\s*/.exec(section);
    if (!label) throw new Error(`threat component ${component} has no explicit component label`);

    const control = /\bControls\s+(?:include|require|limit)\b/i.exec(section.slice(label[0].length));
    if (!control) throw new Error(`threat component ${component} has no Controls statement`);
    const controlStart = label[0].length + (control.index ?? 0);
    const riskText = section.slice(label[0].length, controlStart).replace(/\s+/g, " ").trim();
    const controlText = section.slice(controlStart + control[0].length).replace(/\s+/g, " ").trim();
    if (riskText.length < 20) throw new Error(`threat component ${component} has no substantive risk description`);
    if (controlText.length < 20) throw new Error(`threat component ${component} has no substantive control description`);
  }
  return matches.length;
}

export function assertThreatModelCoverage(architectureSource: string, threatSource: string): number {
  const architecture = componentMarkers(architectureSource, "m1-component");
  const threats = componentMarkers(threatSource, "threat-component");
  if (JSON.stringify(architecture) !== JSON.stringify(threats)) {
    throw new Error(`threat model component coverage differs: architecture=${architecture.join(",")} threats=${threats.join(",")}`);
  }
  assertThreatComponentStructure(threatSource);
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
