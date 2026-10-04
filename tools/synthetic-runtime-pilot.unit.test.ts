import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertCleanDemo,
  assertRuntimeParityOutput,
  assertRestartPreserved,
  assertSeedOutput,
  parseSyntheticPilotArguments,
  plannedSyntheticPilotSteps,
  reviewedRuntimeInventory,
  syntheticComposeEnvironment,
  syntheticProcessEnvironment,
} from "./synthetic-runtime-pilot.js";

describe("disposable synthetic runtime pilot", () => {
  it("requires an explicit destructive-scope flag and rejects unknown options", () => {
    assert.throws(() => parseSyntheticPilotArguments([]), /--disposable is required/);
    assert.throws(() => parseSyntheticPilotArguments(["--disposable", "--keep"]), /unknown synthetic pilot arguments/);
    assert.deepEqual(parseSyntheticPilotArguments(["--disposable"]), { disposable: true, load: false });
    assert.deepEqual(parseSyntheticPilotArguments(["--disposable", "--load"]), { disposable: true, load: true });
  });

  it("passes only host process primitives and strips Docker, OpenMasu, proxy, Node, npm, and credential variables", () => {
    assert.deepEqual(syntheticProcessEnvironment({
      PATH: "synthetic-path",
      HOME: "synthetic-home",
      OPENMASU_ADMIN_KEY: "secret-a",
      DOCKER_HOST: "remote-host",
      NODE_OPTIONS: "--require private-hook",
      npm_config_userconfig: "private-config",
      HTTPS_PROXY: "private-proxy",
      CLOUD_ACCESS_TOKEN: "secret-b",
    }), { PATH: "synthetic-path", HOME: "synthetic-home" });
  });

  it("fixes provider integrations off and uses only synthetic identities and isolated ports", () => {
    const environment = syntheticComposeEnvironment({ api: 41001, postgres: 41002, redirector: 41003 });
    assert.match(environment, /^OPENMASU_API_HOST_PORT=41001$/m);
    assert.match(environment, /^OPENMASU_PUBLIC_BASE_URL=http:\/\/127\.0\.0\.1:41001$/m);
    assert.match(environment, /^OPENMASU_REDIRECTOR_BASE_URL=http:\/\/127\.0\.0\.1:41003$/m);
    assert.match(environment, /^OPENMASU_MAX_TENANT_ID=tenant-a$/m);
    assert.match(environment, /^OPENMASU_MAX_APP_ID=app-a$/m);
    assert.match(environment, /^OPENMASU_COMMERCE_READBACKS=off$/m);
    assert.match(environment, /^OPENMASU_GOOGLE_DATA_MANAGER_ENABLED=off$/m);
    assert.match(environment, /^OPENMASU_APP_STORE_API_PRIVATE_KEY_FILE=$/m);
    assert.doesNotMatch(environment, /secret|token|credential/i);
  });

  it("orders writer shutdown before seed and always plans cleanup verification", () => {
    const ordinary = plannedSyntheticPilotSteps(false);
    assert.ok(ordinary.indexOf("stop_writers") < ordinary.indexOf("seed_contract_fixtures"));
    assert.deepEqual(ordinary.slice(-2), ["cleanup", "cleanup_verification"]);
    assert.ok(!ordinary.includes("synthetic_load"));
    assert.ok(plannedSyntheticPilotSteps(true).includes("synthetic_load"));
    assert.ok(ordinary.indexOf("normal_restart") > ordinary.indexOf("seed_contract_fixtures"));
    assert.ok(ordinary.indexOf("normal_restart") < ordinary.indexOf("runtime_smoke"));
  });

  it("refuses a normal restart that loses data or rotates the secret set", () => {
    const before = { counts: { origin: "postgresql_ledger", raw_records: 12, metric_runs: 3 }, secret_fingerprint: "a".repeat(64) };
    assert.doesNotThrow(() => assertRestartPreserved(before, structuredClone(before)));
    assert.throws(() => assertRestartPreserved(before, { ...before, counts: { raw_records: 0 } }));
    assert.throws(() => assertRestartPreserved(before, { ...before, secret_fingerprint: "b".repeat(64) }));
  });

  it("accepts only the clean-ledger demo and the two reviewed fixture-33 preview values", () => {
    const valid = {
      tenant_id: "tenant-a",
      app_id: "app-a",
      ledger_counts: {
        origin: "postgresql_ledger",
        raw_records: 0,
        logical_events: 0,
        attributions: 0,
        metric_runs: 0,
        current_cost_rows: 0,
      },
      synthetic_contract_preview: [
        { metric_name: "d7_roas", value_unscaled: "1500000", ratio_scale: 6 },
        { metric_name: "retention_d1", value_unscaled: "1000000", ratio_scale: 6 },
      ],
    };
    assert.doesNotThrow(() => assertCleanDemo(valid));
    assert.throws(() => assertCleanDemo({ ...valid, ledger_counts: { ...valid.ledger_counts, raw_records: 1 } }));
  });

  it("requires the reviewed runtime inventory rather than stale fixture counts or all contract artifact families", () => {
    const expected = reviewedRuntimeInventory();
    assert.ok(expected.fixtures > 0 && expected.artifacts > 0);
    assert.equal(expected.families, 10);
    assert.doesNotThrow(() => assertSeedOutput(
      `> openmasu-contract@0.4.0 seed\n\nSeeded ${expected.fixtures} synthetic fixtures through PostgreSQL ingestion (${expected.artifacts} parity artifacts).\n`,
    ));
    assert.doesNotThrow(() => assertRuntimeParityOutput(
      `> openmasu-contract@0.4.0 verify:parity\n\nRuntime parity passed: ${expected.fixtures} fixtures, 10 artifact families, ${expected.artifacts} JCS byte-identical artifacts.\n`,
    ));
    assert.throws(() => assertSeedOutput(
      `Seeded ${expected.fixtures - 1} synthetic fixtures through PostgreSQL ingestion (${expected.artifacts} parity artifacts).\n`,
    ));
    assert.throws(() => assertRuntimeParityOutput(
      `Runtime parity passed: ${expected.fixtures} fixtures, 13 artifact families, ${expected.artifacts} JCS byte-identical artifacts.\n`,
    ));
    assert.throws(() => assertRuntimeParityOutput(
      `Runtime parity passed: ${expected.fixtures} fixtures, 10 artifact families, ${expected.artifacts + 1} JCS byte-identical artifacts.\n`,
    ));
  });
});
