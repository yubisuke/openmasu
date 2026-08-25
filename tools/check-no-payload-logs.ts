import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const logger = readFileSync(join(root, "apps", "api", "src", "observability.ts"), "utf8");
const forbiddenFields = [
  "payload", "body", "raw_body", "authorization", "cookie", "query",
  "installation_id", "record_id",
] as const;

for (const field of forbiddenFields) {
  assert.match(
    logger,
    new RegExp(`readonly ${field}\\?: never;`),
    `operational log event must reject ${field}`,
  );
}
assert.match(logger, /function writeOperationalLog\(event: OperationalLogEvent/);

const serviceSources = [
  "apps/api/src/server.ts",
  "apps/api/src/router.ts",
  "apps/worker/src/main.ts",
  "apps/redirector/src/server.ts",
] as const;
for (const relativePath of serviceSources) {
  const source = readFileSync(join(root, ...relativePath.split("/")), "utf8");
  assert.doesNotMatch(source, /console\.(?:log|error|warn)\s*\(/, `${relativePath} uses an untyped console logger`);
}

process.stdout.write(`Operational log guard passed: ${forbiddenFields.length} forbidden fields and ${serviceSources.length} service sources.\n`);
