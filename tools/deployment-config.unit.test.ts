import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { assertStoppedConfigurationWriters, parseConfigurationArguments, runDeploymentConfiguration } from "./deployment-config.js";

it("requires explicit project, environment, patch and apply receipt", () => {
  assert.throws(() => parseConfigurationArguments(["plan"]), /configuration_arguments_invalid/);
  assert.throws(() => parseConfigurationArguments(["apply", "--project=synthetic", "--env-file=synthetic.env", "--file=patch.json"]), /configuration_arguments_invalid/);
  assert.equal(parseConfigurationArguments(["plan", "--project=synthetic", "--env-file=synthetic.env", "--file=patch.json"]).mode, "plan");
});
it("refuses active or wrong-project writers before starting the configuration container", () => {
  for (const state of ["running", "restarting", "paused", "removing", "unknown"]) {
    assert.throws(() => assertStoppedConfigurationWriters(JSON.stringify([{ Project: "synthetic", Service: "worker", State: state }]), "synthetic"), /configuration_writers_must_be_stopped/);
  }
  assert.throws(() => assertStoppedConfigurationWriters(JSON.stringify([{ Project: "other", Service: "worker", State: "exited" }]), "synthetic"), /configuration_project_unverified/);
  assert.doesNotThrow(() => assertStoppedConfigurationWriters(JSON.stringify([{ Project: "synthetic", Service: "worker", State: "exited" }, { Project: "synthetic", Service: "postgres", State: "running" }]), "synthetic"));
  const calls: string[][] = [];
  assert.throws(() => runDeploymentConfiguration({ mode: "apply", project: "synthetic", envFile: "unused", file: "not-read", receipt: "a".repeat(64) }, {
    run(args) { calls.push([...args]); return { status: 0, stderr: "", stdout: args.includes("config")
      ? JSON.stringify({ name: "synthetic" }) : JSON.stringify([{ Project: "synthetic", Service: "api", State: "running" }]) }; },
  }), /configuration_writers_must_be_stopped/);
  assert.equal(calls.length, 2);
});
it("sends patch content only on stdin and serializes the one-shot operation name", () => {
  const root = mkdtempSync(join(tmpdir(), "openmasu-config-command-"));
  const file = join(root, "patch.json"); writeFileSync(file, JSON.stringify({ OPENMASU_ADMIN_KEY: "do-not-put-in-argv" }));
  try {
    const result = runDeploymentConfiguration({ mode: "plan", project: "synthetic", envFile: "synthetic.env", file }, {
      run(args, input) {
        assert.ok(!args.join(" ").includes("do-not-put-in-argv"));
        if (args.includes("config") && !args.includes("run")) return { status: 0, stderr: "", stdout: '{"name":"synthetic"}' };
        assert.ok(args.includes("synthetic-config-operation"));
        assert.equal(JSON.parse(input!).patch.OPENMASU_ADMIN_KEY, "do-not-put-in-argv");
        return { status: 2, stderr: "", stdout: '{"status":"refused","unsupported":["OPENMASU_ADMIN_KEY"]}' };
      },
    });
    assert.deepEqual(result, { status: "refused", unsupported: ["OPENMASU_ADMIN_KEY"] });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
