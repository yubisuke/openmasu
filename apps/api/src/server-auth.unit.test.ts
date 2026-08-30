import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { serverBodyDigest, serverCanonicalString, signServerRequest } from "./server-auth.js";
import { normalizeServerRecord } from "./server-routes.js";

const identity = {
  tenantId: "tenant-synthetic",
  appId: "app-synthetic",
  serverKeyId: "server-key:synthetic",
  producer: "postback:first-party",
  timestampMs: 1_787_097_600_000,
  nonce: "Nonce_abcdefghijklmnopqrstu",
  requestDigest: "a".repeat(64),
};

describe("server-to-server request signing", () => {
  it("binds method, path, app, key, timestamp, nonce, and the raw body digest", () => {
    const input = {
      method: "POST",
      path: "/v1/events/server",
      appId: identity.appId,
      serverKeyId: identity.serverKeyId,
      timestampMs: identity.timestampMs,
      nonce: identity.nonce,
      body: Buffer.from('{"records":[]}', "utf8"),
    };
    const canonical = serverCanonicalString(input);
    assert.equal(canonical.split("\n").length, 8);
    assert.equal(canonical.endsWith(serverBodyDigest(input.body)), true);
    const secret = "synthetic-server-secret-that-is-at-least-32-bytes";
    const signature = signServerRequest(secret, input);
    for (const changed of [
      { ...input, method: "PUT" },
      { ...input, path: "/v1/events/batch" },
      { ...input, appId: "app-other" },
      { ...input, serverKeyId: "server-key:other" },
      { ...input, timestampMs: input.timestampMs + 1 },
      { ...input, nonce: `${input.nonce}x` },
      { ...input, body: Buffer.from('{"records":[1]}', "utf8") },
    ]) assert.notEqual(signServerRequest(secret, changed), signature);
  });

  it("assigns authenticated scope and server-owned contract fields", () => {
    const record = normalizeServerRecord({
      producer_version: "backend-synthetic-1",
      event_id: "event:server:synthetic",
      event_name: "custom_event",
      occurred_at: "2026-08-30T00:00:00.000Z",
      processing_sequence: 7,
      payload: {
        event_name: "custom_event",
        installation_id: "installation:synthetic",
        event_key: "synthetic_backend_event",
      },
    }, identity, "2026-08-30T00:00:01.000Z");
    assert.equal(record.tenant_id, identity.tenantId);
    assert.equal(record.app_id, identity.appId);
    assert.equal(record.producer, identity.producer);
    assert.equal(record.occurred_at_source, "server");
    assert.equal(record.processing_purpose_id, "analytics");
    assert.equal(record.contract_version, "0.4.0");
    assert.match(record.record_id, /^record:/);
    assert.match(record.delivery_id, /^delivery:/);
  });

  it("rejects authority escalation and unsupported event classes", () => {
    const base = {
      producer_version: "backend-synthetic-1",
      event_id: "event:server:synthetic",
      event_name: "custom_event",
      occurred_at: "2026-08-30T00:00:00.000Z",
      processing_sequence: 1,
      payload: { event_name: "custom_event", installation_id: "installation:synthetic", event_key: "synthetic" },
    };
    assert.throws(() => normalizeServerRecord({ ...base, event_name: "install",
      payload: { event_name: "install" } }, identity, "2026-08-30T00:00:01.000Z"), /server_event_name_forbidden/);
    assert.throws(() => normalizeServerRecord({ ...base, payload: {
      ...base.payload, integrity_verdict: { verdict: "verified" },
    } }, identity, "2026-08-30T00:00:01.000Z"), /server_authority_claim_forbidden/);
    assert.throws(() => normalizeServerRecord({ ...base, payload: {
      ...base.payload, extensions: { provider_assertion: "synthetic" },
    } }, identity, "2026-08-30T00:00:01.000Z"), /server_authority_claim_forbidden/);
  });
});
