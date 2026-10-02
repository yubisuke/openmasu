import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import { requireEnvironment } from "./index.js";
import { upgradePreflight, validateUpgradeBackup, verifyBackupFiles } from "./upgrade.js";

try {
  const args = new Map<string, string>();
  for (const argument of process.argv.slice(2)) {
    const match = /^--(from|to|backup|database-backup|payload-backup)=(.+)$/.exec(argument);
    if (!match || args.has(match[1])) throw new Error("upgrade_arguments_invalid");
    args.set(match[1], match[2]);
  }
  if (args.size !== 5) throw new Error("upgrade_arguments_invalid");
  const target = args.get("to")!;
  const sdkVersion = JSON.parse(readFileSync("sdk/unity/com.openmasu.sdk/package.json", "utf8")).version;
  if (target !== `v${sdkVersion}` || !/^v\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(target)) throw new Error("upgrade_target_unsupported");
  const git = (argument: string[]) => execFileSync("git", argument, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git(["cat-file", "-t", target]) !== "tag" || git(["rev-parse", `${target}^{commit}`]) !== git(["rev-parse", "HEAD"]) || git(["status", "--porcelain"])) throw new Error("upgrade_target_identity_mismatch");
  const backup = validateUpgradeBackup(JSON.parse(readFileSync(args.get("backup")!, "utf8")), args.get("from")!);
  await verifyBackupFiles(backup, args.get("database-backup")!, args.get("payload-backup")!);
  const client = new Client({ connectionString: requireEnvironment("OPENMASU_MIGRATION_DATABASE_URL", process.env.OPENMASU_MIGRATION_DATABASE_URL) });
  await client.connect();
  try { console.log(JSON.stringify({ status: "ready", target, ...await upgradePreflight(client, backup) })); }
  finally { await client.end(); }
} catch (error) {
  const reason = error instanceof Error && /^upgrade_[a-z_]+$/.test(error.message) ? error.message : "upgrade_preflight_failed";
  console.error(JSON.stringify({ status: "refused", reason }));
  process.exitCode = 2;
}
