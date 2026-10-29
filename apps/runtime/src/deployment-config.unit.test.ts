import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { applyDeploymentConfiguration, configurationJournalPath, planDeploymentConfiguration } from "./deployment-config.js";

function workspace(check: (paths: { app: string; repository: string }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "openmasu-config-")); mkdirSync(join(root, "app"));
  const paths = { app: join(root, "app", "runtime.env"), repository: join(root, ".env") };
  const original = "OPENMASU_PUBLIC_BASE_URL=https://api.synthetic.example\nOPENMASU_REDIRECTOR_BASE_URL=https://links.synthetic.example\nOPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST=\nOPENMASU_WORKER_CONCURRENCY=4\nOPENMASU_ADSERVICES_PROVIDER_TIMEOUT_MS=30000\nOPENMASU_ADSERVICES_CLAIM_LEASE_MS=300000\nOPENMASU_ADMIN_KEY=synthetic-private-key\nOPENMASU_MAX_APP_ID=app-synthetic\nOPENMASU_PAYLOAD_MASTER_KEY=synthetic-payload-key\n";
  writeFileSync(paths.app, original); writeFileSync(paths.repository, `${original}OPENMASU_APP_DATABASE_URL=postgresql://synthetic-private-value\n`);
  try { check(paths); } finally { rmSync(root, { force: true, recursive: true }); }
}
const patch = { OPENMASU_PUBLIC_BASE_URL: "https://new-api.synthetic.example", OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST: "https://destination.synthetic.example" };

it("plans only supported non-secret values and hides unsupported values", () => workspace(paths => {
  const before = [readFileSync(paths.app, "utf8"), readFileSync(paths.repository, "utf8")];
  const plan = planDeploymentConfiguration(paths, { ...patch, OPENMASU_ADMIN_KEY: "never-print-this-secret" });
  assert.equal(plan.status, "refused"); assert.equal(plan.receipt, null);
  assert.deepEqual(plan.unsupported, ["OPENMASU_ADMIN_KEY"]);
  assert.deepEqual(plan.restart_services, ["api", "worker", "redirector"]);
  assert.doesNotMatch(JSON.stringify(plan), /never-print|private-key|payload-key|postgresql/);
  assert.deepEqual([readFileSync(paths.app, "utf8"), readFileSync(paths.repository, "utf8")], before);
  writeFileSync(paths.app, before[0].replace("https://api.synthetic.example", "https://legacy:never-print-this-secret@api.synthetic.example"));
  const legacyPlan = planDeploymentConfiguration(paths, patch);
  assert.equal(legacyPlan.status, "planned");
  assert.equal(legacyPlan.changes.find(change => change.name === "OPENMASU_PUBLIC_BASE_URL")?.before, null);
  assert.doesNotMatch(JSON.stringify(legacyPlan), /legacy:|never-print-this-secret/);
}));

it("applies matching configuration to both files without changing credentials or identity", () => workspace(paths => {
  const before = [readFileSync(paths.app, "utf8"), readFileSync(paths.repository, "utf8")];
  const plan = planDeploymentConfiguration(paths, patch);
  const result = applyDeploymentConfiguration(paths, patch, plan.receipt!);
  assert.equal(result.status, "applied");
  for (const [index, path] of [paths.app, paths.repository].entries()) {
    assert.equal(readFileSync(path, "utf8"), before[index].replace("https://api.synthetic.example", patch.OPENMASU_PUBLIC_BASE_URL)
      .replace("OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST=", `OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST=${patch.OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST}`));
  }
  assert.equal(existsSync(configurationJournalPath(paths)), false);
  const empty = { OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST: "" };
  applyDeploymentConfiguration(paths, empty, planDeploymentConfiguration(paths, empty).receipt!);
  assert.match(readFileSync(paths.app, "utf8"), /^OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST=$/m);
}));

it("rejects invalid and stale configuration before replacing any file", () => workspace(paths => {
  const before = [readFileSync(paths.app, "utf8"), readFileSync(paths.repository, "utf8")];
  for (const invalid of [
    { OPENMASU_PUBLIC_BASE_URL: "https://user:private@synthetic.example" },
    { OPENMASU_PUBLIC_BASE_URL: "https://synthetic.example/path" },
    { OPENMASU_PUBLIC_BASE_URL: "http://synthetic.example" },
    { OPENMASU_PUBLIC_BASE_URL: "https://synthetic.example;echo-secret" },
    { OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST: "https://synthetic.example\nSECRET=leak" },
    { OPENMASU_WORKER_CONCURRENCY: "17" },
    { OPENMASU_ADSERVICES_CLAIM_LEASE_MS: "30000" },
  ]) assert.throws(() => planDeploymentConfiguration(paths, invalid), /configuration_/);
  const plan = planDeploymentConfiguration(paths, patch);
  assert.throws(() => applyDeploymentConfiguration(paths, { ...patch, OPENMASU_WORKER_CONCURRENCY: "2" }, plan.receipt!), /configuration_plan_stale/);
  assert.deepEqual([readFileSync(paths.app, "utf8"), readFileSync(paths.repository, "utf8")], before);
  writeFileSync(paths.repository, `${before[1]}# changed since plan\n`);
  assert.throws(() => applyDeploymentConfiguration(paths, patch, plan.receipt!), /configuration_plan_stale/);
  assert.equal(readFileSync(paths.app, "utf8"), before[0]);
}));

it("rolls back an earlier replacement when the second replacement fails", () => workspace(paths => {
  const before = [readFileSync(paths.app, "utf8"), readFileSync(paths.repository, "utf8")];
  const receipt = planDeploymentConfiguration(paths, patch).receipt!;
  assert.throws(() => applyDeploymentConfiguration(paths, patch, receipt, index => {
    if (index === 1) throw new Error("synthetic replacement failure");
  }), /configuration_apply_failed_rolled_back/);
  assert.deepEqual([readFileSync(paths.app, "utf8"), readFileSync(paths.repository, "utf8")], before);
  assert.equal(existsSync(configurationJournalPath(paths)), false);
}));

it("recovers only the two fixed files after interruption using the original receipt", () => workspace(paths => {
  const originals = [readFileSync(paths.app, "utf8"), readFileSync(paths.repository, "utf8")];
  const receipt = planDeploymentConfiguration(paths, patch).receipt!;
  writeFileSync(configurationJournalPath(paths), JSON.stringify({ receipt, originals }));
  writeFileSync(paths.app, originals[0].replace("https://api.synthetic.example", patch.OPENMASU_PUBLIC_BASE_URL));
  assert.throws(() => planDeploymentConfiguration(paths, patch), /configuration_recovery_required/);
  assert.throws(() => applyDeploymentConfiguration(paths, patch, "0".repeat(64)), /configuration_recovery_requires_original_receipt/);
  assert.equal(applyDeploymentConfiguration(paths, patch, receipt).status, "applied");
  assert.equal(existsSync(configurationJournalPath(paths)), false);
  assert.match(readFileSync(paths.repository, "utf8"), /new-api\.synthetic\.example/);
}));
