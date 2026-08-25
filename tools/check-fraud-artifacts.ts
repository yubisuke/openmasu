import { isIP } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const forbiddenKeys = new Set(["user_agent", "ip_address", "source_ip", "remote_address"]);
const userAgentShape = /(?:Mozilla\/5\.0|AppleWebKit\/|Chrome\/\d|Safari\/\d|Dalvik\/|CFNetwork\/|okhttp\/|curl\/)/i;

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child) : [child];
  });
}

export function sensitiveFraudArtifactFinding(value: unknown, path = "$"): string | undefined {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const finding = sensitiveFraudArtifactFinding(value[index], `${path}[${index}]`);
      if (finding) return finding;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key.toLocaleLowerCase("en-US"))) return `${path}.${key}:forbidden_key`;
      const finding = sensitiveFraudArtifactFinding(child, `${path}.${key}`);
      if (finding) return finding;
    }
    return undefined;
  }
  if (typeof value !== "string") return undefined;
  if (userAgentShape.test(value)) return `${path}:user_agent_shape`;
  for (const candidate of value.match(/(?:\d{1,3}\.){3}\d{1,3}/g) ?? []) {
    if (isIP(candidate) === 4) return `${path}:ipv4_literal`;
  }
  for (const candidate of value.match(/(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}/gi) ?? []) {
    if (isIP(candidate) === 6) return `${path}:ipv6_literal`;
  }
  return undefined;
}

export function checkFraudArtifacts(root = process.cwd()): void {
  const targets = [
    ...files(join(root, "schemas")).filter((path) => path.endsWith(".json")),
    ...files(join(root, "fixtures", "v0.4")).filter((path) => /expected_[^\\/]+\.json$/.test(path)),
  ];
  const failures: string[] = [];
  for (const path of targets) {
    const finding = sensitiveFraudArtifactFinding(JSON.parse(readFileSync(path, "utf8")));
    if (finding) failures.push(`${relative(root, path)}:${finding}`);
  }
  if (failures.length > 0) throw new Error(`F-A-17 sensitive artifact scan failed:\n${failures.join("\n")}`);
  console.log(`F-A-17 scanned ${targets.length} schema and emitted-artifact JSON files without IP or User-Agent material.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) checkFraudArtifacts();
