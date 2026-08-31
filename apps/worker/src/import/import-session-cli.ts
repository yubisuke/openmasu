import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createAppPool } from "@openmasu/runtime";
import { executeImportSession, prepareImportSession } from "./import-session.js";
import { mappingsForLint, resolveMappingPath } from "./runner.js";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const source = argument("source");
const file = argument("file");
const lintDirectory = argument("lint-directory");
const confirmation = argument("confirm");
if (!source || !file) {
  throw new Error("usage: npm run import:session -- --source=<mapping-name-or-path> --file=<path> [--confirm=<token>]");
}

const mappingPath = resolveMappingPath(source);
const sourcePath = resolve(file);
const mappingBytes = readFileSync(mappingPath);
const prepared = prepareImportSession({
  mappingBytes,
  sourceBytes: readFileSync(sourcePath),
  sourceLabel: basename(sourcePath),
  siblingMappings: mappingsForLint(mappingPath, lintDirectory),
});

const output = await executeImportSession({
  prepared,
  confirmationToken: confirmation,
  poolFactory: createAppPool,
  publicBaseUrl: process.env.OPENMASU_PUBLIC_BASE_URL,
});
console.log(JSON.stringify(output));
