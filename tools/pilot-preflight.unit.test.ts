import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPreflightEvidence, sanitizedEnvironment, type CommandExecutor, type CommandResult } from "./pilot-preflight.js";

const expected = { contract: "0.4.0", node: "22.18.0", npm: "11.6.2", python: "3.13.5", sdk: "0.2.0-rc.1" };
const npmCommand = { command: "npm", prefix: [] } as const;

function executor(overrides: Record<string, Partial<CommandResult>> = {}): CommandExecutor {
  return (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    const defaults: Record<string, CommandResult> = {
      [`${process.execPath} --version`]: { status: 0, stdout: "v22.18.0\n", stderr: "" },
      "npm --version": { status: 0, stdout: "11.6.2\n", stderr: "" },
      "python --version": { status: 0, stdout: "Python 3.13.5\n", stderr: "" },
      "git status --porcelain=v1 --untracked-files=all": { status: 0, stdout: "", stderr: "" },
      "git describe --tags --exact-match": { status: 1, stdout: "", stderr: "" },
      "git rev-parse HEAD": { status: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" },
      "git branch --show-current": { status: 0, stdout: "review/wo-24-release-evidence\n", stderr: "" },
      "npm run validate": { status: 0, stdout: "Validated 28 schemas, 8 registries, 56 reviewed fixtures, 728 golden output artifacts, 56 scenario assertions, 27 acceptance criteria, deterministic TypeScript, independent Python, and RFC 8785 conformance.\n", stderr: "" },
      "npm run test": { status: 0, stdout: "# tests 187\n# pass 187\n# fail 0\n", stderr: "" },
      "npm run check:sdk-ios": { status: 0, stdout: "OpenMasu iOS source validation passed.\n", stderr: "" },
    };
    const base = defaults[key] ?? { status: 127, stdout: "", stderr: "unknown command" };
    return { ...base, ...overrides[key] };
  };
}

describe("synthetic offline pilot preflight", () => {
  it("records successful host-only checks and explicit unverified boundaries", () => {
    const evidence = createPreflightEvidence(executor(), expected, npmCommand);
    assert.equal(evidence.status, "passed");
    assert.deepEqual(evidence.checks.map(({ id, status }) => ({ id, status })), [
      { id: "contract_validation", status: "passed" },
      { id: "unit_tests", status: "passed" },
      { id: "ios_source_check", status: "passed" },
    ]);
    assert.deepEqual(evidence.boundaries.map(({ status }) => status), Array(6).fill("not_run"));
  });

  it("does not run package gates or expose changed file names when the worktree is dirty", () => {
    const evidence = createPreflightEvidence(executor({
      "git status --porcelain=v1 --untracked-files=all": { stdout: " M private-path.txt\n?? another-secret-name.json\n" },
    }), expected, npmCommand);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.release.clean_worktree, false);
    assert.equal(evidence.release.change_count, 2);
    assert.ok(evidence.checks.every(({ status }) => status === "not_run"));
    assert.doesNotMatch(JSON.stringify(evidence), /private-path|another-secret-name/);
  });

  it("records a failed command without copying child output into evidence", () => {
    const evidence = createPreflightEvidence(executor({
      "npm run test": { status: 1, stdout: "", stderr: "OPENMASU_ADMIN_KEY=synthetic-secret" },
    }), expected, npmCommand);
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.checks.find(({ id }) => id === "unit_tests")?.status, "failed");
    assert.doesNotMatch(JSON.stringify(evidence), /synthetic-secret|ADMIN_KEY/);
  });

  it("removes OpenMasu and conventional credential variables from child environments", () => {
    assert.deepEqual(sanitizedEnvironment({
      PATH: "synthetic-path",
      OPENMASU_ADMIN_KEY: "secret-a",
      PROVIDER_ACCESS_TOKEN: "secret-b",
      PUBLIC_MODE: "synthetic",
    }), { PATH: "synthetic-path", PUBLIC_MODE: "synthetic" });
  });
});
