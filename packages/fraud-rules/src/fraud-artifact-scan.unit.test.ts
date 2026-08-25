import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sensitiveFraudArtifactFinding } from "../../../tools/check-fraud-artifacts.js";

describe("F-A-17 fraud artifact privacy scanner", () => {
  it("rejects IPv4, IPv6, User-Agent-shaped strings, and forbidden keys", () => {
    assert.match(sensitiveFraudArtifactFinding({ evidence: "203.0.113.8" })!, /ipv4_literal/);
    assert.match(sensitiveFraudArtifactFinding({ evidence: "2001:db8::8" })!, /ipv6_literal/);
    assert.match(sensitiveFraudArtifactFinding({ evidence: "Mozilla/5.0 Synthetic" })!, /user_agent_shape/);
    assert.match(sensitiveFraudArtifactFinding({ user_agent: "redacted" })!, /forbidden_key/);
  });

  it("accepts bounded classes, timestamps, hashes, and synthetic identifiers", () => {
    assert.equal(sensitiveFraudArtifactFinding({
      client_class: "mobile_app_eligible",
      source_rate_class: "normal",
      captured_at: "2026-08-21T00:00:00.000Z",
      digest: "a".repeat(64),
      subject_ref: "synthetic-record-1",
    }), undefined);
  });
});
