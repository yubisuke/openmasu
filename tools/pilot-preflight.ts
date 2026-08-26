import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type CommandResult = { status: number | null; stdout: string; stderr: string; error?: Error };
export type CommandExecutor = (command: string, args: readonly string[]) => CommandResult;

type CheckEvidence = {
  id: string;
  command: string;
  evidence_scope: "synthetic_local" | "source_static";
  status: "passed" | "failed" | "not_run";
  exit_code?: number;
  summary?: string;
};

export type PreflightEvidence = {
  schema_version: 1;
  tool: "openmasu-pilot-preflight";
  scope: "synthetic_offline";
  status: "passed" | "failed";
  release: {
    sdk_version: string;
    contract_wire_identity: string;
    git_sha: string;
    git_ref: string;
    exact_tag: string | null;
    clean_worktree: boolean;
    change_count: number;
  };
  environment: {
    real_data: false;
    external_provider: false;
    physical_device: false;
    production_deployment: false;
    operator_acceptance: false;
  };
  toolchain: { node: string; npm: string; python: string };
  checks: CheckEvidence[];
  boundaries: Array<{ id: string; status: "not_run"; reason: string }>;
  redaction: {
    absolute_paths_excluded: true;
    credential_values_excluded: true;
    raw_provider_payloads_excluded: true;
  };
};

type ExpectedVersions = { contract: string; node: string; npm: string; python: string; sdk: string };

const boundaries: PreflightEvidence["boundaries"] = [
  { id: "docker_runtime", status: "not_run", reason: "requires the separate disposable synthetic runtime gate" },
  { id: "android_emulator", status: "not_run", reason: "requires the pinned Android CI workflow" },
  { id: "ios_simulator", status: "not_run", reason: "requires the pinned macOS CI workflow" },
  { id: "real_device", status: "not_run", reason: "operator-only evidence is outside this synthetic preflight" },
  { id: "live_provider", status: "not_run", reason: "provider credentials and live connectivity are outside this repository" },
  { id: "real_data", status: "not_run", reason: "real data is prohibited in this public repository" },
];

export function sanitizedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key]) =>
    !key.startsWith("OPENMASU_") && !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY|API_KEY)/i.test(key),
  ));
}

function safeVersion(value: string, prefix = ""): string {
  return value.trim().replace(prefix, "").trim();
}

export function createPreflightEvidence(
  execute: CommandExecutor,
  expected: ExpectedVersions,
  npmCommand: { command: string; prefix: readonly string[] },
): PreflightEvidence {
  const versionResult = (command: string, args: readonly string[], label: string): string => {
    const result = execute(command, args);
    assert.equal(result.status, 0, `${label} version command failed`);
    return safeVersion(result.stdout, label === "node" ? "v" : label === "python" ? "Python " : "");
  };
  const nodeVersion = versionResult(process.execPath, ["--version"], "node");
  const npmVersion = versionResult(npmCommand.command, [...npmCommand.prefix, "--version"], "npm");
  const pythonVersion = versionResult("python", ["--version"], "python");
  const status = execute("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  assert.equal(status.status, 0, "git status failed");
  const changes = status.stdout.split(/\r?\n/).filter(Boolean);
  const git = (args: readonly string[]): string => {
    const result = execute("git", args);
    assert.equal(result.status, 0, `git ${args.join(" ")} failed`);
    return result.stdout.trim();
  };
  const tag = execute("git", ["describe", "--tags", "--exact-match"]);
  const clean = changes.length === 0;
  const preconditionsMatch = clean
    && nodeVersion === expected.node
    && npmVersion === expected.npm
    && pythonVersion === expected.python;

  const checks: CheckEvidence[] = [];
  const commands = [
    { id: "contract_validation", script: "validate", evidence_scope: "synthetic_local" },
    { id: "unit_tests", script: "test", evidence_scope: "synthetic_local" },
    { id: "ios_source_check", script: "check:sdk-ios", evidence_scope: "source_static" },
  ] as const;
  for (const entry of commands) {
    const commandLabel = `npm run ${entry.script}`;
    if (!preconditionsMatch) {
      checks.push({ id: entry.id, command: commandLabel, evidence_scope: entry.evidence_scope, status: "not_run" });
      continue;
    }
    const result = execute(npmCommand.command, [...npmCommand.prefix, "run", entry.script]);
    const passed = result.status === 0;
    const summary = entry.id === "contract_validation"
      ? result.stdout.match(/Validated \d+ schemas[^\r\n]+/)?.[0]
      : entry.id === "unit_tests"
        ? (() => {
            const passedCount = result.stdout.match(/^# pass (\d+)$/m)?.[1];
            const failedCount = result.stdout.match(/^# fail (\d+)$/m)?.[1];
            return passedCount && failedCount ? `${passedCount} passed, ${failedCount} failed` : undefined;
          })()
        : result.stdout.match(/OpenMasu iOS source validation passed[^\r\n]*/)?.[0];
    checks.push({
      id: entry.id,
      command: commandLabel,
      evidence_scope: entry.evidence_scope,
      status: passed ? "passed" : "failed",
      ...(result.status === null ? {} : { exit_code: result.status }),
      ...(summary ? { summary } : {}),
    });
  }

  const passed = preconditionsMatch && checks.every((check) => check.status === "passed");
  return {
    schema_version: 1,
    tool: "openmasu-pilot-preflight",
    scope: "synthetic_offline",
    status: passed ? "passed" : "failed",
    release: {
      sdk_version: expected.sdk,
      contract_wire_identity: expected.contract,
      git_sha: git(["rev-parse", "HEAD"]),
      git_ref: git(["branch", "--show-current"]) || "detached",
      exact_tag: tag.status === 0 ? tag.stdout.trim() : null,
      clean_worktree: clean,
      change_count: changes.length,
    },
    environment: {
      real_data: false,
      external_provider: false,
      physical_device: false,
      production_deployment: false,
      operator_acceptance: false,
    },
    toolchain: { node: nodeVersion, npm: npmVersion, python: pythonVersion },
    checks,
    boundaries,
    redaction: {
      absolute_paths_excluded: true,
      credential_values_excluded: true,
      raw_provider_payloads_excluded: true,
    },
  };
}

function expectedVersions(root: string): ExpectedVersions {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    engines: { node: string; npm: string };
    version: string;
  };
  const android = readFileSync(join(root, "sdk/android/build.gradle.kts"), "utf8");
  const sdk = android.match(/^version = "([^"]+)"$/m)?.[1];
  assert.ok(sdk, "Android SDK release version is missing");
  return {
    contract: packageJson.version,
    node: packageJson.engines.node,
    npm: packageJson.engines.npm,
    python: readFileSync(join(root, ".python-version"), "utf8").trim(),
    sdk,
  };
}

function npmInvocation(): { command: string; prefix: readonly string[] } {
  const npmExecPath = process.env.npm_execpath;
  return npmExecPath
    ? { command: process.execPath, prefix: [npmExecPath] }
    : { command: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [] };
}

export function runPreflight(root = process.cwd(), outputPath = "build/pilot-evidence/preflight.json"): PreflightEvidence {
  const environment = sanitizedEnvironment(process.env);
  const execute: CommandExecutor = (command, args) => {
    const result = spawnSync(command, [...args], { cwd: root, encoding: "utf8", env: environment, maxBuffer: 64 * 1024 * 1024 });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error } : {}),
    };
  };
  const evidence = createPreflightEvidence(execute, expectedVersions(root), npmInvocation());
  const absoluteOutput = join(root, outputPath);
  mkdirSync(dirname(absoluteOutput), { recursive: true });
  writeFileSync(absoluteOutput, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`Synthetic offline preflight ${evidence.status}; evidence: ${outputPath.replaceAll("\\", "/")}`);
  return evidence;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outputArgument = process.argv.find((value) => value.startsWith("--output="));
  const evidence = runPreflight(process.cwd(), outputArgument?.slice("--output=".length));
  if (evidence.status !== "passed") process.exitCode = 1;
}
