import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertDashboardBaseUrl,
  clearDashboardSessionCookie,
  csrfToken,
  dashboardCookieName,
  dashboardSessionCookie,
  readDashboardToken,
  verifyCsrfToken,
} from "./session.js";

describe("dashboard session primitives", () => {
  it("C01 selects the secure prefix only for HTTPS and emits the fixed attributes", () => {
    const token = "A".repeat(43);
    assert.equal(dashboardCookieName("https://measure.example.invalid"), "__Host-openmmp_dashboard");
    assert.equal(dashboardCookieName("http://localhost:8080"), "openmmp_dashboard");
    assert.equal(
      dashboardSessionCookie(token, "https://measure.example.invalid", 43200),
      `__Host-openmmp_dashboard=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`,
    );
    assert.match(clearDashboardSessionCookie("http://localhost:8080"), /Max-Age=0$/);
  });

  it("C02 reads only a full 32-byte base64url token from the configured cookie", () => {
    const token = "B".repeat(43);
    assert.equal(readDashboardToken(`other=x; openmmp_dashboard=${token}`, "http://localhost:8080"), token);
    assert.equal(readDashboardToken("openmmp_dashboard=x", "http://localhost:8080"), undefined);
    assert.equal(readDashboardToken(`__Host-openmmp_dashboard=${token}`, "http://localhost:8080"), undefined);
  });

  it("C05 binds the CSRF token to the exact session token", () => {
    const token = "C".repeat(43);
    const expected = csrfToken(token);
    assert.equal(verifyCsrfToken(token, expected), true);
    assert.equal(verifyCsrfToken(`${token.slice(0, -1)}D`, expected), false);
    assert.equal(verifyCsrfToken(token, `${expected.slice(0, -1)}A`), false);
  });

  it("C07 refuses plain HTTP outside loopback and accepts the supported origins", () => {
    assert.throws(
      () => assertDashboardBaseUrl(true, "http://198.51.100.10:8080"),
      /OPENMMP_DASHBOARD_INSECURE_ORIGIN.*proxy/,
    );
    assert.equal(assertDashboardBaseUrl(true, "http://localhost:8080").hostname, "localhost");
    assert.equal(assertDashboardBaseUrl(true, "http://127.0.0.1:8080").hostname, "127.0.0.1");
    assert.equal(assertDashboardBaseUrl(true, "https://example.invalid").protocol, "https:");
    assert.equal(assertDashboardBaseUrl(false, "http://198.51.100.10:8080").hostname, "198.51.100.10");
  });
});
