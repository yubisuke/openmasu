import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isPublicWebhookAddress,
  normalizeOperatorWebhookEvents,
  normalizeWebhookAllowlist,
  normalizeWebhookEndpoint,
  resolveWebhookEndpoint,
  operatorWebhookReference,
  operatorWebhookSignature,
} from "./webhook-security.js";

describe("operator webhook destination security", () => {
  it("keeps events closed and derives deterministic destination-scoped references and signatures", () => {
    assert.deepEqual(normalizeOperatorWebhookEvents(["purchase", "custom_event"]), ["custom_event", "purchase"]);
    assert.throws(() => normalizeOperatorWebhookEvents(["install"]), /events_invalid/);
    assert.throws(() => normalizeOperatorWebhookEvents(["purchase", "purchase"]), /events_invalid/);
    const secret = Buffer.from("synthetic-webhook-secret-material-32-bytes", "utf8");
    const reference = operatorWebhookReference(secret, "subject_ref", "installation:synthetic");
    assert.match(reference, /^[a-f0-9]{64}$/);
    assert.equal(reference.includes("installation"), false);
    assert.equal(operatorWebhookReference(secret, "subject_ref", "installation:synthetic"), reference);
    assert.match(operatorWebhookSignature(secret, Buffer.from("{\"synthetic\":true}")), /^sha256=[a-f0-9]{64}$/);
  });

  it("requires an exact HTTPS allowlisted origin and rejects URL credentials or query secrets", () => {
    assert.equal(normalizeWebhookEndpoint(
      "https://events.example.test/openmasu", ["https://events.example.test"],
    ).href, "https://events.example.test/openmasu");
    for (const value of [
      "http://events.example.test/hook",
      "https://user:secret@events.example.test/hook",
      "https://events.example.test/hook?token=secret",
      "https://other.example.test/hook",
    ]) assert.throws(() => normalizeWebhookEndpoint(value, ["https://events.example.test"]), /operator_webhook_/);
    assert.deepEqual(normalizeWebhookAllowlist([
      "https://events.example.test", "https://events.example.test/",
    ]), ["https://events.example.test"]);
  });

  it("rejects private, loopback, link-local, documentation, and mixed DNS answers", async () => {
    for (const address of [
      "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1",
      "192.0.2.1", "198.51.100.1", "203.0.113.1", "::1", "fd00::1", "fe80::1", "2001:db8::1",
    ]) assert.equal(isPublicWebhookAddress(address), false, address);
    assert.equal(isPublicWebhookAddress("8.8.8.8"), true);
    assert.equal(isPublicWebhookAddress("2606:4700:4700::1111"), true);
    await assert.rejects(() => resolveWebhookEndpoint(
      "https://events.example.test/hook", ["https://events.example.test"], {
        lookup: async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }],
      },
    ), /operator_webhook_address_forbidden/);
  });

  it("pins a public resolved address and permits loopback only in an explicit synthetic test mode", async () => {
    const resolved = await resolveWebhookEndpoint(
      "https://events.example.test/hook", ["https://events.example.test"], {
        lookup: async () => [{ address: "2606:4700:4700::1111", family: 6 }, { address: "8.8.8.8", family: 4 }],
      },
    );
    assert.deepEqual({ address: resolved.address, family: resolved.family }, { address: "8.8.8.8", family: 4 });
    const synthetic = await resolveWebhookEndpoint(
      "http://127.0.0.1:18080/hook", ["http://127.0.0.1:18080"], { allowSyntheticLoopback: true },
    );
    assert.equal(synthetic.address, "127.0.0.1");
    await assert.rejects(() => resolveWebhookEndpoint(
      "https://127.0.0.1/hook", ["https://127.0.0.1"],
    ), /operator_webhook_address_forbidden/);
  });

  it("bounds DNS resolution before any connection is attempted", async () => {
    await assert.rejects(() => resolveWebhookEndpoint(
      "https://events.example.test/hook",
      ["https://events.example.test"],
      {
        lookup: () => new Promise(() => undefined),
        resolutionTimeoutMilliseconds: 100,
      },
    ), /operator_webhook_dns_timeout/);
  });
});
