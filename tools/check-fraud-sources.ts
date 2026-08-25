import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const roots = ["apps", "packages", "sdk"];
const sourcePattern = /\.(?:ts|js|mjs|kt|swift|cs|java|mm|m)$/;
const forbidden = [
  /build\.fingerprint/i,
  /jailbreak/i,
  /installed.?packages/i,
  /sensor.?inventory/i,
  /hash(?:Ip|UserAgent)|(?:ipAddress|userAgent)(?:Digest|Hash)/i,
  /click_injection_threshold_ms/,
];

function files(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    if (["node_modules", "build", ".gradle", "DerivedData"].includes(name)) return [];
    return statSync(child).isDirectory() ? files(child) : sourcePattern.test(child) ? [child] : [];
  });
}

const violations = roots.flatMap(files).flatMap((path) => {
  const source = readFileSync(path, "utf8");
  return forbidden.filter((pattern) => pattern.test(source)).map((pattern) =>
    `${relative(process.cwd(), path)}:${pattern.source}`);
});
if (violations.length) throw new Error(`fraud source policy violations: ${violations.join(", ")}`);
console.log("Fraud source policy passed: no fingerprinting symbols or dead CTIT threshold plumbing.");
