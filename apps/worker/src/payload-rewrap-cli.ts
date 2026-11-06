import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { EncryptedFilePayloadStore, EnvironmentSecretStore, recoverOfflinePayloadLock } from "@openmasu/runtime";
import { lockStoppedWriters, requireBackupOperator } from "@openmasu/runtime/backup";

async function main(): Promise<void> {
  const args = process.argv.slice(2), options = new Map<string, string>();
  const flags = new Set(["--writers-stopped", "--recover-stale-lock"]);
  const names = new Set(["--from-key-ref", "--to-key-ref", "--target-key-file", "--limit"]);
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (options.has(name) || (!names.has(name) && !flags.has(name))) throw new Error("payload_rewrap_arguments_invalid");
    const value = flags.has(name) ? "true" : args[++index];
    if (!value || value.startsWith("--")) throw new Error("payload_rewrap_arguments_invalid");
    options.set(name, value);
  }
  if (!options.has("--writers-stopped")) throw new Error("payload_writers_stopped_ack_required");
  const required = (name: string): string => {
    const value = options.get(name);
    if (!value) throw new Error("payload_rewrap_arguments_invalid");
    return value;
  };
  const fromKeyRef = required("--from-key-ref"), toKeyRef = required("--to-key-ref");
  const limit = Number(options.get("--limit") ?? "500");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error("payload_rewrap_arguments_invalid");
  const url = process.env.OPENMASU_MIGRATION_DATABASE_URL, configuredRoot = process.env.OPENMASU_PAYLOAD_STORE_DIR;
  if (!url || !configuredRoot) throw new Error("payload_rewrap_environment_required");
  const root = realpathSync(resolve(configuredRoot));
  const secrets = new EnvironmentSecretStore({
    OPENMASU_PAYLOAD_MASTER_KEY: { value: process.env.OPENMASU_PAYLOAD_MASTER_KEY, file: process.env.OPENMASU_PAYLOAD_MASTER_KEY_FILE },
    target: { file: required("--target-key-file") },
  });
  const store = new EncryptedFilePayloadStore(root, secrets.require("OPENMASU_PAYLOAD_MASTER_KEY"));
  const targetSecret = secrets.require("target");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await requireBackupOperator(client);
    await client.query("BEGIN");
    try {
      await lockStoppedWriters(client);
      if (options.has("--recover-stale-lock")) recoverOfflinePayloadLock(root, true);
      const result = await store.rewrapBatch({ fromKeyRef, toKeyRef, targetSecret, limit, writersStopped: true });
      await client.query("COMMIT");
      process.stdout.write(JSON.stringify({ payload_rewrap_ok: true, ...result, traffic_restart: "manual" }) + "\n");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  } finally { await client.end(); }
}

try { await main(); }
catch (error) {
  const code = error instanceof Error && /^(payload|backup)_[a-z_]+$/.test(error.message) ? error.message : "payload_rewrap_failed";
  process.stderr.write(JSON.stringify({ payload_rewrap_ok: false, code }) + "\n");
  process.exitCode = 2;
}
