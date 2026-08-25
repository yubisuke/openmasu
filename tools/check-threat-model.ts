import { readFileSync } from "node:fs";

function markers(path: string, kind: string): string[] {
  const values = [...readFileSync(path, "utf8").matchAll(new RegExp(`<!-- ${kind}:([a-z0-9-]+) -->`, "g"))]
    .map((match) => match[1]);
  if (values.length === 0) throw new Error(`${path} contains no ${kind} markers`);
  if (new Set(values).size !== values.length) throw new Error(`${path} contains duplicate ${kind} markers`);
  return values.sort();
}

const architecture = markers("docs/architecture.md", "m1-component");
const threats = markers("docs/threat-model.md", "threat-component");
if (JSON.stringify(architecture) !== JSON.stringify(threats)) {
  throw new Error(`threat model component coverage differs: architecture=${architecture.join(",")} threats=${threats.join(",")}`);
}
console.log(`Threat model coverage passed: ${architecture.length} M1 components.`);
