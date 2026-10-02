import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { deploymentPreflight, deploymentSecretNames, parsePrivateRuntimeEnvironment, deploymentReleaseVersion } from "./deployment-preflight.js";

const version = deploymentReleaseVersion();
const config = { format: "openmasu-single-host-v1", release_tag: `v${version}`, compose_project: "openmasu-service", api_origin: "https://metrics.example.invalid", redirector_origin: "https://links.example.invalid", destination_origins: ["https://app.example.invalid"], tls_termination: "operator_reverse_proxy", certificate_kind: "public_ca" };
const env = { OPENMASU_PUBLIC_BASE_URL: config.api_origin, OPENMASU_REDIRECTOR_BASE_URL: config.redirector_origin, OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST: config.destination_origins.join(","), ...Object.fromEntries(deploymentSecretNames.map((name, index) => [name, `${index}a`.repeat(22)])) };
it("single-host preflight accepts declared HTTPS configuration but never certifies TLS or production", () => {
  const result = deploymentPreflight(config, env, version);
  assert.equal(result.status, "ready"); assert.equal(result.tls_verified, false); assert.equal(result.production_verified, false);
  assert.deepEqual(JSON.parse(readFileSync("examples/deployment/single-host.json", "utf8")), config);
  for (const secret of Object.values(env).slice(3)) assert.ok(!JSON.stringify(result).includes(secret));
  assert.deepEqual(parsePrivateRuntimeEnvironment("# comment\nOPENMASU_PUBLIC_BASE_URL=https://example.invalid\n"), { OPENMASU_PUBLIC_BASE_URL: "https://example.invalid" });
  assert.throws(() => parsePrivateRuntimeEnvironment("A=a\nA=b"), /runtime_environment_invalid/);
});
it("single-host preflight names empty allowlists, development TLS, URL mismatch and absent secrets without printing inputs", () => {
  for (const [input, environment, reason] of [
    [{ ...config, destination_origins: [] }, env, "destination_allowlist_empty"],
    [{ ...config, certificate_kind: "internal" }, env, "development_tls_forbidden"],
    [{ ...config, api_origin: "http://localhost:8080" }, env, "public_url_invalid"],
    [{ ...config, release_tag: "unknown" }, env, "release_unsupported"],
    [config, { ...env, OPENMASU_PUBLIC_BASE_URL: "https://wrong.example.invalid" }, "runtime_public_url_mismatch"],
    [config, { ...env, OPENMASU_PAYLOAD_MASTER_KEY: "" }, "required_secret_missing"],
    [config, { ...env, OPENMASU_ADMIN_KEY: "synthetic-unsafe" }, "required_secret_unsafe"],
    [config, { ...env, OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST: "" }, "runtime_allowlist_mismatch"],
  ] as const) {
    const result = deploymentPreflight(input, environment, version);
    assert.equal(result.status, "refused"); assert.ok(result.reasons.includes(reason));
    assert.ok(!JSON.stringify(result).includes("wrong.example.invalid"));
  }
});
