import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { assertLeastPrivilegeWorkflow, assertPinnedWorkflowActions } from "./check-workflow-permissions.js";

const workflow = (permissions: string) => `name: synthetic\non: push\n${permissions}\njobs:\n  check:\n    runs-on: ubuntu-latest\n`;

describe("GitHub Actions token permissions", () => {
  it("accepts only a top-level contents read grant", () => {
    assert.doesNotThrow(() => assertLeastPrivilegeWorkflow(workflow("permissions:\n  contents: read")));
  });

  it("rejects an implicit repository-default token", () => {
    assert.throws(() => assertLeastPrivilegeWorkflow(workflow("")), /exactly one top-level permissions block/);
  });

  it("rejects write access and additional token scopes", () => {
    assert.throws(
      () => assertLeastPrivilegeWorkflow(workflow("permissions:\n  contents: write")),
      /must be exactly contents:read/,
    );
    assert.throws(
      () => assertLeastPrivilegeWorkflow(workflow("permissions:\n  contents: read\n  issues: read")),
      /must be exactly contents:read/,
    );
  });

  it("rejects job-level permission escalation", () => {
    const source = `${workflow("permissions:\n  contents: read")}    permissions:\n      contents: write\n`;
    assert.throws(() => assertLeastPrivilegeWorkflow(source), /must not override permissions/);
  });

  it("accepts only immutable external action revisions", () => {
    assert.equal(
      assertPinnedWorkflowActions(
        `${workflow("permissions:\n  contents: read")}    steps:\n      - uses: actions/checkout@${"a".repeat(40)}\n`,
      ),
      1,
    );
    assert.throws(
      () => assertPinnedWorkflowActions("steps:\n  - uses: actions/checkout@v7\n"),
      /immutable 40-hex revision/,
    );
  });

  it("keeps the workflow permission gate in root validation", () => {
    const scripts = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    assert.match(scripts.scripts.validate, /(?:^|&&\s*)npm run check:workflow-permissions(?:\s*&&|$)/);
  });
});
