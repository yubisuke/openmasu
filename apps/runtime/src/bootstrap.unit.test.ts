import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

function generatedAppEnvironment(options: {
  readonly allowlist?: string;
  readonly publicBaseUrl?: string;
  readonly redirectorBaseUrl?: string;
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
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "apps/runtime/src/bootstrap.ts"],
      { cwd: process.cwd(), encoding: "utf8", env: environment },
    );
    assert.equal(result.status, 0, result.stderr);
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
  });
});
