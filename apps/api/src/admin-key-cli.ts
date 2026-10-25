import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { createAppPool, EnvironmentSecretStore } from "@openmasu/runtime";
import { issueAdminKey, parseAdminRole, retireAdminKey, verifyAdminKey, type AdminRole } from "./admin-auth.js";

export type AdminKeyCommand = { command: "issue"; tenantId: string; role: AdminRole; appScope?: string }
  | { command: "retire"; tenantId: string; keyId: string };
const identifier = /^[A-Za-z0-9._:-]{1,128}$/;

export function parseAdminKeyCommand(args: readonly string[]): AdminKeyCommand {
  const [command, ...options] = args;
  const values = new Map<string, string>();
  const invalid = () => { throw new Error("admin_key_arguments_invalid"); };
  if (command !== "issue" && command !== "retire") return invalid();
  const allowed = command === "issue" ? ["tenant", "role", "app"] : ["tenant", "key-id"];
  for (const option of options) {
    const match = /^--([a-z-]+)=(.+)$/.exec(option);
    if (!match || !allowed.includes(match[1]!) || values.has(match[1]!)) return invalid();
    values.set(match[1]!, match[2]!);
  }
  const tenantId = values.get("tenant");
  if (!tenantId || !identifier.test(tenantId)) return invalid();
  if (command === "retire") {
    const keyId = values.get("key-id");
    if (!keyId || !identifier.test(keyId)) return invalid();
    return { command, tenantId, keyId };
  }
  const role = values.get("role"), appScope = values.get("app");
  if (!role || !["admin", "operator", "read_only"].includes(role) || appScope !== undefined && !identifier.test(appScope)) return invalid();
  return { command, tenantId, role: parseAdminRole(role), ...(appScope !== undefined ? { appScope } : {}) };
}

/** The server's existing owner credential authorizes the operation; it is never an argv value. */
export async function runAdminKeyCommand(pool: Pool, command: AdminKeyCommand, authorization: string) {
  const actor = await verifyAdminKey(pool, command.tenantId, authorization);
  if (!actor) throw new Error("unauthorized");
  if (command.command === "issue") return issueAdminKey(pool, actor, { role: command.role, appScope: command.appScope });
  return { key_id: command.keyId, retired: await retireAdminKey(pool, actor, command.keyId) };
}

async function main(): Promise<void> {
  if (process.argv[2] === "--help" && process.argv.length === 3) {
    process.stdout.write("admin:keys issue --tenant=<id> --role=admin|operator|read_only [--app=<id>]\nadmin:keys retire --tenant=<id> --key-id=<id>\n");
    return;
  }
  let pool: Pool | undefined;
  try {
    const command = parseAdminKeyCommand(process.argv.slice(2));
    const secrets = new EnvironmentSecretStore({
      OPENMASU_ADMIN_KEY: { value: process.env.OPENMASU_ADMIN_KEY, file: process.env.OPENMASU_ADMIN_KEY_FILE },
    });
    const key = secrets.require("OPENMASU_ADMIN_KEY");
    pool = createAppPool();
    const result = await runAdminKeyCommand(pool, command, `Bearer ${key}`);
    // Deliberate one-time operator output, never an operational log or audit payload.
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const allowed = ["admin_key_arguments_invalid", "unauthorized", "forbidden", "app_not_found",
      "admin_key_not_found", "admin_key_last_tenant_admin", "admin_key_app_scope_invalid"];
    const code = allowed.includes(message) ? message : message.startsWith("admin key overlap") ? "admin_key_overlap" : "admin_key_operation_failed";
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = 1;
  } finally { await pool?.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
