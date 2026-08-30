import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

function generatedAppEnvironment(options: {
  readonly allowlist?: string;
  readonly publicBaseUrl?: string;
  readonly redirectorBaseUrl?: string;
  readonly workerConcurrency?: string;
  readonly workerShutdownTimeout?: string;
  readonly sdkInboxBatchLimit?: string;
  readonly maxInboxBatchLimit?: string;
  readonly reconciledWorkerConcurrency?: string;
  readonly reconciledSdkInboxBatchLimit?: string;
  readonly reconciledMaxInboxBatchLimit?: string;
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), "openmasu-bootstrap-"));
  const repositoryRoot = join(root, "repository");
  const runtimeRoot = join(root, "runtime");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    OPENMASU_REPOSITORY_ROOT: repositoryRoot,
    OPENMASU_RUNTIME_SECRET_ROOT: runtimeRoot,
  };
  if (options.allowlist === undefined) delete environment.OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST;
  else environment.OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST = options.allowlist;
  if (options.publicBaseUrl === undefined) delete environment.OPENMASU_PUBLIC_BASE_URL;
  else environment.OPENMASU_PUBLIC_BASE_URL = options.publicBaseUrl;
  if (options.redirectorBaseUrl === undefined) delete environment.OPENMASU_REDIRECTOR_BASE_URL;
  else environment.OPENMASU_REDIRECTOR_BASE_URL = options.redirectorBaseUrl;
  if (options.workerConcurrency === undefined) delete environment.OPENMASU_WORKER_CONCURRENCY;
  else environment.OPENMASU_WORKER_CONCURRENCY = options.workerConcurrency;
  if (options.workerShutdownTimeout === undefined) {
    delete environment.OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS;
  } else {
    environment.OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS = options.workerShutdownTimeout;
  }
  if (options.sdkInboxBatchLimit === undefined) delete environment.OPENMASU_SDK_INBOX_BATCH_LIMIT;
  else environment.OPENMASU_SDK_INBOX_BATCH_LIMIT = options.sdkInboxBatchLimit;
  if (options.maxInboxBatchLimit === undefined) delete environment.OPENMASU_MAX_INBOX_BATCH_LIMIT;
  else environment.OPENMASU_MAX_INBOX_BATCH_LIMIT = options.maxInboxBatchLimit;
  try {
    let result = spawnSync(
      process.execPath,
      ["--import", "tsx", "apps/runtime/src/bootstrap.ts"],
      { cwd: process.cwd(), encoding: "utf8", env: environment },
    );
    assert.equal(result.status, 0, result.stderr);
    if (options.reconciledWorkerConcurrency !== undefined
      || options.reconciledSdkInboxBatchLimit !== undefined
      || options.reconciledMaxInboxBatchLimit !== undefined) {
      const repositoryEnvironmentPath = join(repositoryRoot, ".env");
      let repositoryEnvironment = readFileSync(repositoryEnvironmentPath, "utf8");
      if (options.reconciledWorkerConcurrency !== undefined) {
        repositoryEnvironment = repositoryEnvironment.replace(
          /^OPENMASU_WORKER_CONCURRENCY=.*$/m,
          `OPENMASU_WORKER_CONCURRENCY=${options.reconciledWorkerConcurrency}`,
        );
      }
      if (options.reconciledSdkInboxBatchLimit !== undefined) {
        repositoryEnvironment = repositoryEnvironment.replace(
          /^OPENMASU_SDK_INBOX_BATCH_LIMIT=.*$/m,
          `OPENMASU_SDK_INBOX_BATCH_LIMIT=${options.reconciledSdkInboxBatchLimit}`,
        );
      }
      if (options.reconciledMaxInboxBatchLimit !== undefined) {
        repositoryEnvironment = repositoryEnvironment.replace(
          /^OPENMASU_MAX_INBOX_BATCH_LIMIT=.*$/m,
          `OPENMASU_MAX_INBOX_BATCH_LIMIT=${options.reconciledMaxInboxBatchLimit}`,
        );
      }
      writeFileSync(
        repositoryEnvironmentPath,
        repositoryEnvironment,
        "utf8",
      );
      delete environment.OPENMASU_WORKER_CONCURRENCY;
      result = spawnSync(
        process.execPath,
        ["--import", "tsx", "apps/runtime/src/bootstrap.ts"],
        { cwd: process.cwd(), encoding: "utf8", env: environment },
      );
      assert.equal(result.status, 0, result.stderr);
    }
    return readFileSync(join(runtimeRoot, "app", "runtime.env"), "utf8");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("runtime bootstrap environment", () => {
  it("propagates the configured redirect destination allowlist into runtime secrets", () => {
    const appEnvironment = generatedAppEnvironment({
      allowlist: "https://links.synthetic.example,https://second.synthetic.example",
    });
    assert.match(
      appEnvironment,
      /^OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST=https:\/\/links\.synthetic\.example,https:\/\/second\.synthetic\.example$/m,
    );
  });

  it("keeps an unset redirect destination allowlist empty and fail-closed", () => {
    assert.match(
      generatedAppEnvironment(),
      /^OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST=$/m,
    );
  });

  it("propagates externally reachable API and redirector base URLs", () => {
    const appEnvironment = generatedAppEnvironment({
      publicBaseUrl: "https://api.synthetic.example",
      redirectorBaseUrl: "https://links.synthetic.example",
    });
    assert.match(
      appEnvironment,
      /^OPENMASU_PUBLIC_BASE_URL=https:\/\/api\.synthetic\.example$/m,
    );
    assert.match(
      appEnvironment,
      /^OPENMASU_REDIRECTOR_BASE_URL=https:\/\/links\.synthetic\.example$/m,
    );
  });

  it("keeps the bundled Compose overrides configurable and loopback-bound", () => {
    const compose = readFileSync("compose.yaml", "utf8");
    assert.match(
      compose,
      /OPENMASU_PUBLIC_BASE_URL: \$\{OPENMASU_PUBLIC_BASE_URL:-http:\/\/localhost:8080\}/,
    );
    assert.match(
      compose,
      /OPENMASU_REDIRECTOR_BASE_URL: \$\{OPENMASU_REDIRECTOR_BASE_URL:-http:\/\/localhost:8090\}/,
    );
    assert.match(compose, /127\.0\.0\.1:\$\{OPENMASU_PROXY_HOST_PORT:-8443\}:443/);
    assert.match(
      compose,
      /OPENMASU_WORKER_CONCURRENCY: \$\{OPENMASU_WORKER_CONCURRENCY:-4\}/,
    );
    assert.match(
      compose,
      /OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS: \$\{OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS:-30000\}/,
    );
    assert.match(
      compose,
      /OPENMASU_SDK_INBOX_BATCH_LIMIT: \$\{OPENMASU_SDK_INBOX_BATCH_LIMIT:-100\}/,
    );
    assert.match(
      compose,
      /OPENMASU_MAX_INBOX_BATCH_LIMIT: \$\{OPENMASU_MAX_INBOX_BATCH_LIMIT:-100\}/,
    );
  });

  it("propagates bounded tenant concurrency with a safe development default", () => {
    assert.match(
      generatedAppEnvironment(),
      /^OPENMASU_WORKER_CONCURRENCY=4$/m,
    );
    assert.match(
      generatedAppEnvironment({ workerConcurrency: "7" }),
      /^OPENMASU_WORKER_CONCURRENCY=7$/m,
    );
    assert.match(
      generatedAppEnvironment({ workerShutdownTimeout: "45000" }),
      /^OPENMASU_WORKER_SHUTDOWN_TIMEOUT_MS=45000$/m,
    );
    const boundedInboxEnvironment = generatedAppEnvironment({
      sdkInboxBatchLimit: "2",
      maxInboxBatchLimit: "3",
    });
    assert.match(boundedInboxEnvironment, /^OPENMASU_SDK_INBOX_BATCH_LIMIT=2$/m);
    assert.match(boundedInboxEnvironment, /^OPENMASU_MAX_INBOX_BATCH_LIMIT=3$/m);
  });

  it("reconciles non-secret worker controls in an existing runtime environment", () => {
    const appEnvironment = generatedAppEnvironment({
      workerConcurrency: "7",
      reconciledWorkerConcurrency: "1",
      reconciledSdkInboxBatchLimit: "2",
      reconciledMaxInboxBatchLimit: "3",
    });
    assert.match(appEnvironment, /^OPENMASU_WORKER_CONCURRENCY=1$/m);
    assert.doesNotMatch(appEnvironment, /^OPENMASU_WORKER_CONCURRENCY=7$/m);
    assert.match(appEnvironment, /^OPENMASU_ADMIN_KEY=[A-Za-z0-9_-]+$/m);
    assert.equal(appEnvironment.match(/^OPENMASU_WORKER_CONCURRENCY=/gm)?.length, 1);
    assert.match(appEnvironment, /^OPENMASU_SDK_INBOX_BATCH_LIMIT=2$/m);
    assert.equal(appEnvironment.match(/^OPENMASU_SDK_INBOX_BATCH_LIMIT=/gm)?.length, 1);
    assert.match(appEnvironment, /^OPENMASU_MAX_INBOX_BATCH_LIMIT=3$/m);
    assert.equal(appEnvironment.match(/^OPENMASU_MAX_INBOX_BATCH_LIMIT=/gm)?.length, 1);
  });
});
