import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

function generatedAppEnvironment(allowlist?: string): string {
  const root = mkdtempSync(join(tmpdir(), "openmasu-bootstrap-"));
  const repositoryRoot = join(root, "repository");
  const runtimeRoot = join(root, "runtime");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    OPENMASU_REPOSITORY_ROOT: repositoryRoot,
    OPENMASU_RUNTIME_SECRET_ROOT: runtimeRoot,
  };
  if (allowlist === undefined) delete environment.OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST;
  else environment.OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST = allowlist;
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

describe("WO13 runtime bootstrap environment", () => {
  it("propagates the configured redirect destination allowlist into runtime secrets", () => {
    const appEnvironment = generatedAppEnvironment(
      "https://links.synthetic.example,https://second.synthetic.example",
    );
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
});
