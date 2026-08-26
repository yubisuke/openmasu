import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PilotArguments = { disposable: true; load: boolean };
type CommandResult = { status: number | null; stdout: string; stderr: string };
type StepStatus = { id: string; status: "passed" | "failed" | "not_run"; exit_code?: number };

class PilotStepError extends Error {
  constructor(readonly stepId: string, readonly exitCode?: number) {
    super(`synthetic pilot step failed: ${stepId}`);
  }
}

export function parseSyntheticPilotArguments(args: readonly string[]): PilotArguments {
  const allowed = new Set(["--disposable", "--load"]);
  const unknown = args.filter((value) => !allowed.has(value));
  assert.deepEqual(unknown, [], `unknown synthetic pilot arguments: ${unknown.join(", ")}`);
  assert.ok(args.includes("--disposable"), "--disposable is required; this command deletes its isolated Compose volumes");
  return { disposable: true, load: args.includes("--load") };
}

export function syntheticProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    "APPDATA", "CI", "COMSPEC", "HOME", "LOCALAPPDATA", "NO_COLOR", "PATH", "PATHEXT",
    "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TERM", "TMP", "USERPROFILE",
  ]);
  return Object.fromEntries(Object.entries(environment).filter(([key]) => allowed.has(key)));
}

export function syntheticComposeEnvironment(ports: { api: number; postgres: number; redirector: number }): string {
  const entries: Record<string, string> = {
    OPENMASU_API_HOST_PORT: String(ports.api),
    OPENMASU_POSTGRES_HOST_PORT: String(ports.postgres),
    OPENMASU_REDIRECTOR_HOST_PORT: String(ports.redirector),
    OPENMASU_MAX_TENANT_ID: "tenant-synthetic-pilot",
    OPENMASU_MAX_APP_ID: "app-synthetic-pilot",
    OPENMASU_ENROLL_RATE_RPS: "10000",
    OPENMASU_ENROLL_RATE_BURST: "2000",
    OPENMASU_INGEST_RATE_RPS: "10",
    OPENMASU_INGEST_RATE_BURST: "20",
    OPENMASU_INGEST_APP_RATE_RPS: "10000",
    OPENMASU_INGEST_APP_RATE_BURST: "2000",
    OPENMASU_MAX_RATE_RPS: "20000",
    OPENMASU_MAX_RATE_BURST: "12000",
    OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST: "",
    OPENMASU_GOOGLE_PLAY_RTDN_AUDIENCE: "",
    OPENMASU_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL: "",
    OPENMASU_COMMERCE_READBACKS: "off",
    OPENMASU_APPLE_STORE_NOTIFICATIONS: "off",
    OPENMASU_APPLE_ROOT_SHA256: "",
    OPENMASU_APP_STORE_API_ISSUER_ID: "",
    OPENMASU_APP_STORE_API_KEY_ID: "",
    OPENMASU_APP_STORE_API_PRIVATE_KEY_FILE: "",
    OPENMASU_APP_STORE_API_BASE_URL: "",
    OPENMASU_GOOGLE_DATA_MANAGER_ENABLED: "off",
    OPENMASU_GOOGLE_DATA_MANAGER_SERVICE_ACCOUNT_JSON_FILE: "",
  };
  return `${Object.entries(entries).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

export function plannedSyntheticPilotSteps(load: boolean): string[] {
  return [
    "compose_config",
    "compose_up",
    "clean_demo",
    "stop_writers",
    "seed_contract_fixtures",
    "verify_runtime_parity",
    "resume_runtime",
    "stable_worker",
    "runtime_smoke",
    ...(load ? ["synthetic_load"] : []),
    "cleanup",
    "cleanup_verification",
  ];
}

export function assertCleanDemo(value: unknown): void {
  const demo = value as {
    tenant_id?: string;
    app_id?: string;
    ledger_counts?: {
      origin?: string;
      raw_records?: number;
      logical_events?: number;
      attributions?: number;
      metric_runs?: number;
      current_cost_rows?: number;
    };
    synthetic_contract_preview?: Array<{ metric_name?: string; value_unscaled?: string; ratio_scale?: number }>;
  };
  assert.equal(demo.tenant_id, "tenant-synthetic-pilot");
  assert.equal(demo.app_id, "app-synthetic-pilot");
  assert.equal(demo.ledger_counts?.origin, "postgresql_ledger");
  for (const count of ["raw_records", "logical_events", "attributions", "metric_runs", "current_cost_rows"] as const) {
    assert.equal(demo.ledger_counts?.[count], 0, `${count} must be empty before synthetic seeding`);
  }
  const preview = demo.synthetic_contract_preview ?? [];
  assert.ok(preview.some((row) => row.metric_name === "d7_roas" && row.value_unscaled === "1500000" && row.ratio_scale === 6));
  assert.ok(preview.some((row) => row.metric_name === "retention_d1" && row.value_unscaled === "1000000" && row.ratio_scale === 6));
}

async function freeLoopbackPorts(count: number): Promise<number[]> {
  const servers: Server[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    }
    return servers.map((server) => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      return address.port;
    });
  } finally {
    await Promise.all(servers.map(async (server) => await new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    })));
  }
}

function safeProjectName(): string {
  const configured = process.env.OPENMASU_PILOT_PROJECT;
  const value = configured ?? `openmasu-synthetic-pilot-${process.pid}`;
  assert.match(value, /^openmasu-(?:synthetic|pilot)[a-z0-9-]*$/);
  return value;
}

function writeEvidence(root: string, evidence: unknown): void {
  const path = join(root, "build", "pilot-evidence", "synthetic-runtime.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

export async function runSyntheticRuntimePilot(
  args: readonly string[],
  root = process.cwd(),
): Promise<void> {
  const options = parseSyntheticPilotArguments(args);
  assert.ok(existsSync(join(root, "compose.yaml")), "run the synthetic pilot from the repository root");
  assert.ok(!existsSync(join(root, ".env")), "refusing to run while a repository .env exists");
  assert.ok(!existsSync(join(root, ".openmasu")), "refusing to run while repository runtime state exists");
  assert.ok(!process.env.DOCKER_HOST && !process.env.DOCKER_CONTEXT, "remote Docker hosts and contexts are not allowed");

  const childEnvironment = syntheticProcessEnvironment(process.env);
  const execute = (command: string, commandArgs: readonly string[], cwd = root): CommandResult => {
    const result = spawnSync(command, [...commandArgs], {
      cwd,
      encoding: "utf8",
      env: childEnvironment,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  const requireSuccess = (id: string, command: string, commandArgs: readonly string[], cwd = root): CommandResult => {
    const result = execute(command, commandArgs, cwd);
    if (result.status !== 0) throw new PilotStepError(id, result.status ?? undefined);
    return result;
  };

  const clean = requireSuccess("clean_worktree", "git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  assert.equal(clean.stdout.trim(), "", "synthetic pilot requires a clean Git worktree");
  const sourceRevision = requireSuccess("source_revision", "git", ["rev-parse", "HEAD"]).stdout.trim();
  const context = requireSuccess("docker_context", "docker", ["context", "show"]).stdout.trim();
  assert.ok(["default", "desktop-linux"].includes(context), `Docker context ${context} is not an approved local context`);

  const staging = mkdtempSync(join(tmpdir(), "openmasu-synthetic-pilot-"));
  const control = mkdtempSync(join(tmpdir(), "openmasu-synthetic-control-"));
  const cleanupTemporaryFiles = (): void => {
    rmSync(staging, { recursive: true, force: true });
    rmSync(control, { recursive: true, force: true });
  };
  const envPath = join(control, "synthetic-pilot.env");
  try {
    const prefixPath = `${staging.replaceAll("\\", "/")}/`;
    requireSuccess("tracked_staging", "git", ["checkout-index", "--all", "--force", `--prefix=${prefixPath}`]);
    const [api, postgres, redirector] = await freeLoopbackPorts(3);
    assert.ok(api !== postgres && api !== redirector && postgres !== redirector);
    const ports = { api, postgres, redirector };
    writeFileSync(envPath, syntheticComposeEnvironment(ports), "utf8");
  } catch (error) {
    cleanupTemporaryFiles();
    throw error;
  }
  const project = safeProjectName();
  const compose = ["compose", "--project-name", project, "--env-file", envPath];
  const steps = new Map(plannedSyntheticPilotSteps(options.load).map((id) => [id, "not_run" as StepStatus["status"]]));
  let primaryFailure: PilotStepError | undefined;
  let composeAttempted = false;
  let demoCounts: { raw_records: number; logical_events: number } | undefined;

  const projectResources = (): string[] => {
    const results = [
      execute("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], staging),
      execute("docker", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`], staging),
      execute("docker", ["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`], staging),
    ];
    if (results.some(({ status }) => status !== 0)) return ["resource_query_failed"];
    return results.flatMap(({ stdout }) => stdout.split(/\r?\n/).filter(Boolean));
  };
  try {
    assert.deepEqual(projectResources(), [], "refusing to reuse an existing synthetic Compose project");
  } catch (error) {
    cleanupTemporaryFiles();
    throw error;
  }

  const runStep = (id: string, commandArgs: readonly string[]): CommandResult => {
    const result = requireSuccess(id, "docker", commandArgs, staging);
    steps.set(id, "passed");
    return result;
  };
  const runVerifiedStep = (
    id: string,
    commandArgs: readonly string[],
    verify: (result: CommandResult) => void,
  ): CommandResult => {
    const result = requireSuccess(id, "docker", commandArgs, staging);
    try {
      verify(result);
    } catch {
      steps.set(id, "failed");
      throw new PilotStepError(id);
    }
    steps.set(id, "passed");
    return result;
  };
  const shell = (command: string): readonly string[] => ["/bin/sh", "-c", command];

  try {
    runStep("compose_config", [...compose, "config", "--quiet"]);
    composeAttempted = true;
    runStep("compose_up", [...compose, "up", "-d", "--wait"]);
    const demo = runVerifiedStep("clean_demo", [
      ...compose, "exec", "-T", "api", ...shell("set -a && . /run/openmasu/app/runtime.env && set +a && node --import tsx apps/worker/src/demo-metrics.ts"),
    ], (result) => assertCleanDemo(JSON.parse(result.stdout)));
    const parsedDemo = JSON.parse(demo.stdout) as { ledger_counts: { raw_records: number; logical_events: number } };
    demoCounts = { raw_records: parsedDemo.ledger_counts.raw_records, logical_events: parsedDemo.ledger_counts.logical_events };
    runStep("stop_writers", [...compose, "stop", "worker", "api", "redirector"]);
    runVerifiedStep("seed_contract_fixtures", [
      ...compose, "--profile", "seed", "run", "--rm", "seed",
    ], (result) => assert.match(
      result.stdout,
      /^Seeded 56 synthetic fixtures through PostgreSQL ingestion \(728 parity artifacts\)\.\s*$/,
    ));
    runVerifiedStep("verify_runtime_parity", [
      ...compose, "--profile", "seed", "run", "--rm", "seed",
      ...shell("set -a && . /run/openmasu/seed/runtime.env && set +a && npm run verify:parity"),
    ], (result) => assert.match(result.stdout, /Runtime parity passed: 56 fixtures/));
    runStep("resume_runtime", [...compose, "up", "-d", "--wait"]);
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    const workerId = requireSuccess("stable_worker", "docker", [...compose, "ps", "-q", "worker"], staging).stdout.trim();
    try {
      assert.ok(workerId, "worker container is missing");
      const workerState = requireSuccess("stable_worker", "docker", ["inspect", "--format", "{{.State.Status}} {{.RestartCount}}", workerId], staging).stdout.trim();
      assert.equal(workerState, "running 0");
      steps.set("stable_worker", "passed");
    } catch {
      steps.set("stable_worker", "failed");
      throw new PilotStepError("stable_worker");
    }
    runVerifiedStep("runtime_smoke", [
      ...compose, "exec", "-T", "api",
      ...shell("set -a && . /run/openmasu/app/runtime.env && set +a && OPENMASU_API_HOST_PORT=8080 node --import tsx tools/runtime-smoke.ts"),
    ], (result) => assert.match(
      result.stdout,
      /^Runtime smoke passed: health=200 dashboard=200\/login303 seeded_metric=visible valid_max=204 tampered_max=401 redirect=302 enrollment=201 sdk_batch=202\.\s*$/,
    ));
    if (options.load) {
      const load = runVerifiedStep("synthetic_load", [
        ...compose, "exec", "-T", "api",
        ...shell("set -a && . /run/openmasu/app/runtime.env && set +a && node --import tsx tools/m5-load.ts"),
      ], (result) => {
        const report = JSON.parse(result.stdout) as {
          benchmark?: string;
          sdk_enrollment?: { errors?: number };
          sdk_ingestion?: { errors?: number };
          max_postback?: { errors?: number };
        };
        assert.equal(report.benchmark, "openmasu_m5_synthetic_http_load_v1");
        assert.equal(report.sdk_enrollment?.errors, 0);
        assert.equal(report.sdk_ingestion?.errors, 0);
        assert.equal(report.max_postback?.errors, 0);
      });
      const loadPath = join(root, "build", "pilot-evidence", "m5-load.json");
      mkdirSync(dirname(loadPath), { recursive: true });
      writeFileSync(loadPath, load.stdout, "utf8");
    }
  } catch (error) {
    primaryFailure = error instanceof PilotStepError ? error : new PilotStepError("pilot_assertion");
    if (steps.has(primaryFailure.stepId)) steps.set(primaryFailure.stepId, "failed");
  } finally {
    if (composeAttempted) {
      const cleanup = execute("docker", [...compose, "down", "--volumes", "--remove-orphans", "--timeout", "30"], staging);
      steps.set("cleanup", cleanup.status === 0 ? "passed" : "failed");
      if (cleanup.status !== 0 && !primaryFailure) primaryFailure = new PilotStepError("cleanup", cleanup.status ?? undefined);
    }
    const remaining = projectResources();
    steps.set("cleanup_verification", remaining.length === 0 ? "passed" : "failed");
    if (remaining.length > 0 && !primaryFailure) primaryFailure = new PilotStepError("cleanup_verification");
    cleanupTemporaryFiles();
  }

  const status = primaryFailure ? "failed" : "passed";
  writeEvidence(root, {
    format: "openmasu-synthetic-runtime-pilot-v1",
    scope: "synthetic_compose",
    status,
    source_revision: sourceRevision,
    project,
    environment: {
      real_data: false,
      external_provider: false,
      physical_device: false,
      production_deployment: false,
      operator_acceptance: false,
    },
    checks: [...steps].map(([id, stepStatus]) => ({ id, status: stepStatus })),
    ...(demoCounts ? { clean_demo_counts: demoCounts } : {}),
    ...(primaryFailure ? { failure: { step_id: primaryFailure.stepId, ...(primaryFailure.exitCode === undefined ? {} : { exit_code: primaryFailure.exitCode }) } } : {}),
  });
  if (primaryFailure) throw primaryFailure;
  console.log("Disposable synthetic runtime pilot passed; isolated containers, networks, and volumes were removed.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runSyntheticRuntimePilot(process.argv.slice(2)).catch((error: unknown) => {
    const step = error instanceof PilotStepError ? error.stepId : "precondition";
    console.error(`Disposable synthetic runtime pilot failed at ${step}.`);
    process.exitCode = 1;
  });
}
