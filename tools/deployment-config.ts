import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type CommandResult = { status: number | null; stdout: string; stderr: string };
export type ConfigurationCommand = { mode: "plan" | "apply"; project: string; envFile: string; file: string; receipt?: string };
export function parseConfigurationArguments(args: readonly string[]): ConfigurationCommand {
  const mode = args[0];
  if (mode !== "plan" && mode !== "apply") throw new Error("configuration_arguments_invalid");
  const options = new Map<string, string>();
  for (const argument of args.slice(1)) {
    const match = /^--(project|env-file|file|receipt)=(.+)$/.exec(argument);
    if (!match || options.has(match[1])) throw new Error("configuration_arguments_invalid");
    options.set(match[1], match[2]);
  }
  const project = options.get("project"), envFile = options.get("env-file"), file = options.get("file"), receipt = options.get("receipt");
  if (!project || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project) || !envFile || !file
    || (mode === "apply" ? !receipt || !/^[a-f0-9]{64}$/.test(receipt) : receipt !== undefined)) throw new Error("configuration_arguments_invalid");
  return { mode, project, envFile: resolve(envFile), file: resolve(file), receipt };
}
export function assertStoppedConfigurationWriters(output: string, project: string): void {
  const rows = output.trim().startsWith("[") ? JSON.parse(output) : output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (!Array.isArray(rows)) throw new Error("configuration_project_unverified");
  for (const row of rows) {
    if (row.Project !== project) throw new Error("configuration_project_unverified");
    if (["api", "worker", "redirector"].includes(row.Service) && !["exited", "created"].includes(row.State)) {
      throw new Error("configuration_writers_must_be_stopped");
    }
  }
}
export function runDeploymentConfiguration(command: ConfigurationCommand, options: {
  cwd?: string;
  run?: (args: readonly string[], input?: string) => CommandResult;
} = {}): unknown {
  const cwd = options.cwd ?? process.cwd();
  const run = options.run ?? ((args, input) => {
    const result = spawnSync("docker", [...args], { cwd, input, encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  });
  const compose = ["compose", "--project-directory", cwd, "-f", resolve(cwd, "compose.yaml"), "--project-name", command.project, "--env-file", command.envFile];
  const config = run([...compose, "config", "--format", "json"]);
  if (config.status !== 0 || JSON.parse(config.stdout).name !== command.project) throw new Error("configuration_project_unverified");
  if (command.mode === "apply") {
    const writers = run([...compose, "ps", "--all", "--format", "json"]);
    if (writers.status !== 0) throw new Error("configuration_project_unverified");
    assertStoppedConfigurationWriters(writers.stdout, command.project);
  }
  const patchSource = readFileSync(command.file, "utf8");
  if (Buffer.byteLength(patchSource) > 16 * 1024) throw new Error("configuration_patch_invalid");
  const patch: unknown = JSON.parse(patchSource);
  // A fixed temporary container name serializes operations, including recovery.
  // JSON goes through stdin; arbitrary patch values never become shell arguments.
  const result = run([...compose, "run", "--rm", "--no-deps", "-T", "--name", `${command.project}-config-operation`,
    "bootstrap", "node", "--import", "tsx", "apps/runtime/src/bootstrap.ts", "config"],
  JSON.stringify({ mode: command.mode, patch, receipt: command.receipt }));
  if (result.status !== 0) {
    try {
      const refusal = JSON.parse(result.stderr.trim().split(/\r?\n/).at(-1)!);
      if (/^configuration_[a-z_]+$/.test(refusal.reason)) throw new Error(refusal.reason);
    } catch (error) {
      if (error instanceof Error && /^configuration_[a-z_]+$/.test(error.message)) throw error;
    }
    // A refused plan may still safely report unsupported setting names.
    try { const value = JSON.parse(result.stdout); if (value.status === "refused") return value; } catch { /* fixed error below */ }
    throw new Error("configuration_command_failed");
  }
  return JSON.parse(result.stdout);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = runDeploymentConfiguration(parseConfigurationArguments(process.argv.slice(2))) as { status?: string };
    console.log(JSON.stringify(result));
    if (result.status === "refused") process.exitCode = 2;
  } catch (error) {
    const reason = error instanceof Error && /^configuration_[a-z_]+$/.test(error.message) ? error.message : "configuration_command_failed";
    console.error(JSON.stringify({ status: "refused", reason })); process.exitCode = 2;
  }
}
