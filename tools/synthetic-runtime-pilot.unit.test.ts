import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertCleanDemo,
  assertRuntimeParityOutput,
  assertSeedOutput,
  parseSyntheticPilotArguments,
  plannedSyntheticPilotSteps,
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

  it("pins the database parity gate to the measured 57-fixture, 10-family, 558-artifact result", () => {
    assert.doesNotThrow(() => assertSeedOutput(
      "> openmasu-contract@0.4.0 seed\n> npm run seed --workspace @openmasu/worker\n\nSeeded 57 synthetic fixtures through PostgreSQL ingestion (558 parity artifacts).\n",
    ));
    assert.doesNotThrow(() => assertRuntimeParityOutput(
      "> openmasu-contract@0.4.0 verify:parity\n\nRuntime parity passed: 57 fixtures, 10 artifact families, 558 JCS byte-identical artifacts.\n",
    ));
    assert.throws(() => assertSeedOutput(
      "Seeded 57 synthetic fixtures through PostgreSQL ingestion (741 parity artifacts).\n",
    ));
  });
});
