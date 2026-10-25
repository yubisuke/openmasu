import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { applyRetention, createAppPool, EncryptedFilePayloadStore, EnvironmentSecretStore, parseRetentionPolicy, previewRetention } from "@openmasu/runtime";
import { verifyAdminKey } from "./admin-auth.js";
import { requireRegisteredApp } from "./apps-admin.js";
import { roleAllows } from "./authorization.js";

export function parseRetentionCommand(args: readonly string[]) {
  const [command,...flags] = args, values = new Map<string,string>();
  const invalid = (): never => { throw new Error("retention_arguments_invalid"); };
  if (command !== "preview" && command !== "apply") return invalid();
  for (const flag of flags) {
    const match = /^--([a-z-]+)=(.+)$/.exec(flag);
    if (!match || !["tenant","app","policy",...(command === "apply" ? ["receipt","limit"] : [])].includes(match[1]!) || values.has(match[1]!)) return invalid();
    values.set(match[1]!,match[2]!);
  }
  const tenantId = values.get("tenant"), appId = values.get("app"), file = values.get("policy");
  if (!tenantId || !appId || !file || !/^[A-Za-z0-9._:-]{1,128}$/.test(tenantId) || !/^[A-Za-z0-9._:-]{1,128}$/.test(appId)) return invalid();
  const receipt = values.get("receipt"), maximumItems = values.has("limit") ? Number(values.get("limit")) : 20;
  if (command === "apply" && (!/^[a-f0-9]{64}$/.test(receipt ?? "") || !Number.isSafeInteger(maximumItems) || maximumItems < 1 || maximumItems > 100)) return invalid();
  return { command,scope:{tenantId,appId},file,receipt,maximumItems };
}

async function main() {
  if (process.argv[2] === "--help" && process.argv.length === 3) {
    process.stdout.write("ops:retention preview --tenant=<id> --app=<id> --policy=<json>\nops:retention apply --tenant=<id> --app=<id> --policy=<same-json> --receipt=<digest> [--limit=20]\n"); return;
  }
  let pool: Pool | undefined;
  try {
    const options = parseRetentionCommand(process.argv.slice(2));
    const policy = parseRetentionPolicy(JSON.parse(readFileSync(options.file,"utf8")));
    const secrets = new EnvironmentSecretStore({
      OPENMASU_ADMIN_KEY:{value:process.env.OPENMASU_ADMIN_KEY,file:process.env.OPENMASU_ADMIN_KEY_FILE},
      OPENMASU_PAYLOAD_MASTER_KEY:{value:process.env.OPENMASU_PAYLOAD_MASTER_KEY,file:process.env.OPENMASU_PAYLOAD_MASTER_KEY_FILE},
    });
    pool = createAppPool();
    const actor = await verifyAdminKey(pool,options.scope.tenantId,`Bearer ${secrets.require("OPENMASU_ADMIN_KEY")}`);
    if (!actor) throw new Error("unauthorized");
    await requireRegisteredApp(pool,actor,options.scope.appId);
    if (options.command === "apply" && !roleAllows(actor.role,"administer")) throw new Error("forbidden");
    if (options.command === "apply" && !policy.enabled) throw new Error("retention_disabled");
    const result = options.command === "preview" ? await previewRetention(pool,options.scope,policy)
      : await applyRetention({pool,scope:options.scope,policy,receipt:options.receipt!,maximumItems:options.maximumItems,actorRef:`admin_key:${actor.keyId}`,
        payloadStore:new EncryptedFilePayloadStore(process.env.OPENMASU_PAYLOAD_STORE_DIR ?? ".openmasu/payloads",secrets.require("OPENMASU_PAYLOAD_MASTER_KEY"))});
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const allowed = ["unauthorized","forbidden","app_not_found","retention_policy_invalid","retention_arguments_invalid",
      "retention_disabled","retention_receipt_mismatch","retention_dependencies_unknown","retention_candidate_limit","retention_busy"];
    process.stderr.write(`${JSON.stringify({error:allowed.includes(message) ? message : "retention_operation_failed"})}\n`);
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
