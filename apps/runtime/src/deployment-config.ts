import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const integerSettings = {
  OPENMASU_WORKER_CONCURRENCY: [1, 16],
  OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS: [1000, 300000],
  OPENMASU_SDK_INBOX_BATCH_LIMIT: [1, 1000],
  OPENMASU_MAX_INBOX_BATCH_LIMIT: [1, 1000],
  OPENMASU_ADSERVICES_PROVIDER_TIMEOUT_MS: [10, 120000],
  OPENMASU_ADSERVICES_CLAIM_LEASE_MS: [1000, 900000],
} as const;
export const deploymentSettingNames = [
  "OPENMASU_PUBLIC_BASE_URL", "OPENMASU_REDIRECTOR_BASE_URL", "OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST",
  ...Object.keys(integerSettings),
] as readonly string[];
export type ConfigurationPaths = { app: string; repository: string };
export type ConfigurationPlan = {
  status: "planned" | "refused";
  changes: Array<{ name: string; before: string | null; after: string }>;
  unsupported: string[];
  receipt: string | null;
  restart_services: readonly string[];
  writers_must_be_stopped: true;
};
const maximumBytes = 256 * 1024;
export function configurationJournalPath(paths: ConfigurationPaths): string {
  return join(dirname(paths.app), ".deployment-config-recovery.json");
}
function source(path: string, maximum = maximumBytes): string {
  const value = readFileSync(path, "utf8");
  if (Buffer.byteLength(value) > maximum) throw new Error("configuration_environment_invalid");
  return value;
}
function environment(value: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const line of value.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (separator < 1 || !/^[A-Z][A-Z0-9_]*$/.test(key) || key in values) throw new Error("configuration_environment_invalid");
    values[key] = line.slice(separator + 1);
  }
  return values;
}
function origin(value: string): boolean {
  if (!/^[A-Za-z0-9.:/\[\]-]+$/.test(value)) return false;
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return url.origin === value && !url.username && !url.password
      && (url.protocol === "https:" || (url.protocol === "http:" && loopback));
  } catch { return false; }
}
function setting(name: string, value: unknown): string {
  if (typeof value !== "string" || value.length > 10000) throw new Error("configuration_value_invalid");
  if (name in integerSettings) {
    const [minimum, maximum] = integerSettings[name as keyof typeof integerSettings];
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) {
      throw new Error("configuration_value_invalid");
    }
    return String(Number(value));
  }
  if (name === "OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST") {
    if (value === "") return value;
    const values = value.split(",");
    if (values.length > 100 || values.some(entry => !origin(entry)) || new Set(values).size !== values.length) throw new Error("configuration_value_invalid");
    return [...values].sort().join(",");
  }
  if (!origin(value)) throw new Error("configuration_value_invalid");
  return value;
}
function patchSettings(input: unknown): { settings: Record<string, string>; unsupported: string[] } {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length > 100) throw new Error("configuration_patch_invalid");
  const settings: Record<string, string> = Object.create(null);
  const unsupported: string[] = [];
  for (const name of Object.keys(input).sort()) {
    if (!deploymentSettingNames.includes(name)) {
      unsupported.push(/^[A-Z][A-Z0-9_]{0,127}$/.test(name) ? name : "invalid_setting_name");
    } else settings[name] = setting(name, (input as Record<string, unknown>)[name]);
  }
  return { settings, unsupported };
}
function replacement(original: string, settings: Readonly<Record<string, string>>): string {
  let result = original.replace(/\s*$/, "");
  for (const [name, value] of Object.entries(settings)) {
    const expression = new RegExp(`^${name}=.*$`, "m");
    result = expression.test(result) ? result.replace(expression, `${name}=${value}`) : `${result}\n${name}=${value}`;
  }
  return `${result}\n`;
}
function displayedBefore(name: string, value: string | undefined): string | null {
  if (value === undefined) return null;
  try { return setting(name, value); }
  catch { return null; } // Invalid legacy settings can contain credentials; never echo them.
}
function planFromSources(originals: [string, string], input: unknown): ConfigurationPlan {
  const { settings, unsupported } = patchSettings(input);
  const current = environment(originals[0]), repository = environment(originals[1]);
  const next = { ...current, ...settings };
  if (Number(next.OPENMASU_ADSERVICES_PROVIDER_TIMEOUT_MS ?? "30000") >= Number(next.OPENMASU_ADSERVICES_CLAIM_LEASE_MS ?? "300000")) {
    throw new Error("configuration_timeout_not_below_lease");
  }
  const changes = Object.entries(settings).map(([name, after]) => ({ name,
    before: displayedBefore(name, current[name]), after,
  })).filter(({ name, before, after }) => before !== after || repository[name] !== after);
  const receipt = createHash("sha256").update(JSON.stringify({ version: 1, originals, settings })).digest("hex");
  return { status: unsupported.length ? "refused" : "planned", changes, unsupported,
    receipt: unsupported.length ? null : receipt, restart_services: ["api", "worker", "redirector"], writers_must_be_stopped: true };
}
export function planDeploymentConfiguration(paths: ConfigurationPaths, input: unknown): ConfigurationPlan {
  if (existsSync(configurationJournalPath(paths))) throw new Error("configuration_recovery_required");
  return planFromSources([source(paths.app), source(paths.repository)], input);
}
function writeDurable(path: string, content: string): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
}
function replaceFile(path: string, content: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  try { writeDurable(temporary, content); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
/** Writer-stop enforcement and single-operation container ownership belong to the host CLI. */
export function applyDeploymentConfiguration(paths: ConfigurationPaths, input: unknown, receipt: string,
  beforeReplace?: (index: number) => void): Omit<ConfigurationPlan, "status"> & { status: "applied" } {
  if (!/^[a-f0-9]{64}$/.test(receipt)) throw new Error("configuration_receipt_invalid");
  const journal = configurationJournalPath(paths);
  const targets = [paths.app, paths.repository];
  if (existsSync(journal)) {
    const recovery = JSON.parse(source(journal, 2 * maximumBytes + 1024)) as { receipt?: string; originals?: unknown };
    if (recovery.receipt !== receipt || !Array.isArray(recovery.originals) || recovery.originals.length !== 2
      || recovery.originals.some(value => typeof value !== "string" || Buffer.byteLength(value) > maximumBytes)) throw new Error("configuration_recovery_requires_original_receipt");
    for (let index = 0; index < targets.length; index++) replaceFile(targets[index], recovery.originals[index]);
    unlinkSync(journal);
  }
  const originals: [string, string] = [source(paths.app), source(paths.repository)];
  const plan = planFromSources(originals, input);
  if (plan.status !== "planned" || plan.receipt !== receipt) throw new Error("configuration_plan_stale_or_unsupported");
  const settings = patchSettings(input).settings;
  writeDurable(journal, JSON.stringify({ receipt, originals }));
  try {
    for (let index = 0; index < targets.length; index++) {
      beforeReplace?.(index);
      replaceFile(targets[index], replacement(originals[index], settings));
    }
    unlinkSync(journal);
  } catch {
    try {
      for (let index = 0; index < targets.length; index++) replaceFile(targets[index], originals[index]);
      unlinkSync(journal);
    } catch { throw new Error("configuration_recovery_required"); }
    throw new Error("configuration_apply_failed_rolled_back");
  }
  return { ...plan, status: "applied" };
}

export async function configurationBootstrapCommand(paths: ConfigurationPaths): Promise<void> {
  try {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of process.stdin) {
      const value = Buffer.from(chunk); bytes += value.length;
      if (bytes > 32 * 1024) throw new Error("configuration_patch_invalid");
      chunks.push(value);
    }
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (request.mode !== "plan" && request.mode !== "apply") throw new Error("configuration_arguments_invalid");
    const result = request.mode === "plan" ? planDeploymentConfiguration(paths, request.patch)
      : applyDeploymentConfiguration(paths, request.patch, request.receipt);
    console.log(JSON.stringify(result));
    if (result.status === "refused") process.exitCode = 2;
  } catch (error) {
    const reason = error instanceof Error && /^configuration_[a-z_]+$/.test(error.message) ? error.message : "configuration_command_failed";
    console.error(JSON.stringify({ status: "refused", reason })); process.exitCode = 2;
  }
}
