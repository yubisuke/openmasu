import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { EnvironmentSecretStore } from "@openmasu/runtime";
import { checkBackup, createBackup, readPrivacyBoundary, requireBackupOperator, validatePrivacyBoundary } from "@openmasu/runtime/backup";
import { restoreBackup } from "./backup-operations.js";

const execute = promisify(execFile);

// libpq password file avoids including passwords in argv or child-process diagnostics.
async function postgresTool(tool: "pg_dump" | "pg_restore", urlString: string, path: string): Promise<void> {
  const url = new URL(urlString);
  const privateRoot = await mkdtemp(join(tmpdir(), "openmasu-pg-"));
  try {
    const escape = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
    const passfile = join(privateRoot, "pgpass");
    await writeFile(passfile, [url.hostname, url.port || "5432", decodeURIComponent(url.pathname.slice(1)), decodeURIComponent(url.username), decodeURIComponent(url.password)].map(escape).join(":") + "\n", { mode: 0o600 });
    url.password = "";
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|LANG|LC_[A-Z_]+)$/i.test(name)));
    env.PGPASSFILE = passfile;
    const args = tool === "pg_dump" ? ["--format=custom", "--file", path, "--dbname", url.toString()]
      : ["--exit-on-error", "--dbname", url.toString(), path];
    try { await execute(tool, args, { env, timeout: 3_600_000, maxBuffer: 1024 * 1024 }); }
    catch { throw new Error(`backup_${tool}_failed`); }
  } finally { await rm(privateRoot, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const allowed = new Set(["--output", "--directory", "--payload-output", "--boundary", "--master-key-ref", "--maximum-age-hours"]);
  const flags = new Set(["--writers-stopped", "--privacy-intake-stopped"]);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (options.has(name) || (!allowed.has(name) && !flags.has(name))) throw new Error("backup_arguments_invalid");
    const value = flags.has(name) ? "true" : args[++index];
    if (!value || value.startsWith("--")) throw new Error("backup_arguments_invalid");
    options.set(name, value);
  }
  const required = (name: string): string => {
    const value = options.get(name);
    if (!value) throw new Error("backup_required_argument_missing");
    return value;
  };
  if (!["create", "check", "boundary", "restore"].includes(command)) throw new Error("backup_command_invalid");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim()) throw new Error("backup_clean_checkout_required");
  const boundary = async () => validatePrivacyBoundary(JSON.parse(await readFile(required("--boundary"), "utf8")));
  const maximumAgeHours = Number(options.get("--maximum-age-hours") ?? "24");
  if (!Number.isFinite(maximumAgeHours) || maximumAgeHours <= 0) throw new Error("backup_freshness_limit_invalid");
  if (command === "check") {
    const manifest = await checkBackup({ directory: required("--directory"), boundary: await boundary(), revision, maximumAgeHours });
    process.stdout.write(JSON.stringify({ backup_valid: true, captured_at: manifest.captured_at, privacy_requests: manifest.privacy.request_count }) + "\n");
    return;
  }
  const url = process.env.OPENMASU_MIGRATION_DATABASE_URL;
  if (!url) throw new Error("backup_migration_database_url_required");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await requireBackupOperator(client);
    if (command === "boundary") {
      if (!options.has("--writers-stopped")) throw new Error("backup_writers_stopped_ack_required");
      const destination = resolve(required("--output"));
      const { realpath } = await import("node:fs/promises");
      const { relative, isAbsolute } = await import("node:path");
      const rel = relative(await realpath(process.cwd()), join(await realpath(resolve(destination, "..")), destination.split(/[\\/]/).at(-1)!));
      if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) throw new Error("backup_destination_must_be_outside_repository");
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const checkpoint = await readPrivacyBoundary(client);
      await client.query("COMMIT");
      await writeFile(destination, JSON.stringify(checkpoint, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      process.stdout.write(JSON.stringify({ privacy_boundary_written: true, privacy_requests: checkpoint.request_count }) + "\n");
      return;
    }
    const secrets = new EnvironmentSecretStore({ OPENMASU_PAYLOAD_MASTER_KEY: {
      value: process.env.OPENMASU_PAYLOAD_MASTER_KEY, file: process.env.OPENMASU_PAYLOAD_MASTER_KEY_FILE,
    } });
    const masterKey = secrets.require("OPENMASU_PAYLOAD_MASTER_KEY");
    const masterKeyRef = required("--master-key-ref");
    if (command === "create") {
      const payloadRoot = process.env.OPENMASU_PAYLOAD_STORE_DIR;
      if (!payloadRoot) throw new Error("backup_payload_store_dir_required");
      const manifest = await createBackup({ client, output: required("--output"), payloadRoot, masterKey, masterKeyRef,
        revision, writersStopped: options.has("--writers-stopped"), dump: (path) => postgresTool("pg_dump", url, path) });
      process.stdout.write(JSON.stringify({ backup_complete: true, captured_at: manifest.captured_at, privacy_requests: manifest.privacy.request_count }) + "\n");
    } else {
      const result = await restoreBackup({ admin: client, adminUrl: url, directory: required("--directory"), payloadOutput: required("--payload-output"),
        masterKey, masterKeyRef, revision, maximumAgeHours, privacyIntakeStopped: options.has("--privacy-intake-stopped"),
        currentBoundary: boundary, restoreArchive: (target, archive) => postgresTool("pg_restore", target, archive) });
      process.stdout.write(JSON.stringify(result) + "\n");
    }
  } finally { await client.end(); }
}

try { await main(); }
catch (error) {
  const code = error instanceof Error && /^backup_[a-z_]+$/.test(error.message) ? error.message : "backup_operation_failed";
  process.stderr.write(JSON.stringify({ backup_ok: false, code }) + "\n");
  process.exitCode = 2;
}
