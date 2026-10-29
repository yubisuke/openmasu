import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PoolClient } from "pg";
import { assertSyntheticValidationDeployment, parseSyntheticValidationDefinition, syntheticValidationToken,
  syntheticValidationTokenDigest, attachSyntheticValidationReceipt } from "@openmasu/runtime";
import { renderSyntheticValidation } from "./dashboard/synthetic-validations.js";

describe("bounded disposable validation configuration", () => {
  it("accepts only closed classes, exact bounded custom keys and a non-sliding TTL", () => {
    assert.deepEqual(parseSyntheticValidationDefinition({}), { ttl_seconds: 600, expected_events: ["install", "session_start"], expected_custom_keys: [] });
    assert.deepEqual(parseSyntheticValidationDefinition({ expected_events: ["custom_event"], expected_custom_keys: ["synthetic_b", "synthetic_a"], ttl_seconds: 1800 }).expected_custom_keys, ["synthetic_a", "synthetic_b"]);
    for (const input of [null, [], { ttl_seconds: 1801 }, { ttl_seconds: 59 }, { ttl_seconds: "600" },
      { expected_events: [] }, { expected_events: ["install", "install"] }, { expected_events: ["private-free-form"] },
      { expected_custom_keys: ["synthetic_key"] }, { expected_events: ["custom_event"], expected_custom_keys: ["a", "a"] },
      { expected_events: ["custom_event"], expected_custom_keys: ["x".repeat(65)] },
      { expected_events: ["custom_event"], expected_custom_keys: ["Invalid-Event"] }, { purpose: "synthetic_disposable" }]) {
      assert.throws(() => parseSyntheticValidationDefinition(input), /validation_request_invalid/);
    }
  });
  it("binds opaque token digests and trusts only the database deployment purpose", async () => {
    const token = syntheticValidationToken(); assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(syntheticValidationTokenDigest(token), /^[a-f0-9]{64}$/);
    for (const value of [undefined, null, "", "A".repeat(44), "x".repeat(43), 5]) assert.throws(() => syntheticValidationTokenDigest(value));
    for (const purpose of ["persistent", undefined, "synthetic_disposable"]) {
      const client = { query: async (sql: string) => {
        assert.equal(sql, "SELECT purpose FROM control.deployment_purpose WHERE singleton");
        return { rows: purpose ? [{ purpose }] : [] };
      } } as unknown as PoolClient;
      if (purpose === "synthetic_disposable") await assertSyntheticValidationDeployment(client);
      else await assert.rejects(assertSyntheticValidationDeployment(client), /synthetic_deployment_required/);
    }
  });
  it("renders an escaped no-script form and shows the token only on creation", () => {
    const page = { appId: "app-synthetic", csrfToken: "synthetic-csrf", canAdminister: true };
    const token = syntheticValidationToken();
    const created = renderSyntheticValidation({ ...page, created: { session_id: "synthetic-id", session_token: token, expires_at: "2026-10-29T00:10:00.000Z" } });
    assert.ok(created.includes(token)); assert.doesNotMatch(created, /<script\b|javascript:|\son[a-z]+=/i);
    assert.doesNotMatch(renderSyntheticValidation({ ...page, error: "<unsafe>" }), /<unsafe>/);
    const status = renderSyntheticValidation({ ...page, status: { session_id: "synthetic-id", expires_at: "2026-10-29T00:10:00.000Z", batch_count: 0, event_count: 0, expectations: [], receipts: [] } });
    assert.equal(status.includes(token), false); assert.match(status, /not proof that an event contributed/);
    assert.doesNotMatch(renderSyntheticValidation({ ...page, canAdminister: false }), /<form/);
  });
  it("retains only server record references and exact declared custom-key indexes in ephemeral marks", async () => {
    let marks: unknown;
    const client = { query: async (sql: string, values?: unknown[]) => {
      if (sql.includes("control.deployment_purpose")) return { rows: [{ purpose: "synthetic_disposable" }] };
      if (sql.includes("FOR UPDATE")) return { rows: [{ session_id: "synthetic-session", expected_custom_keys: ["synthetic_key"], expired: false, batch_count: 0, event_count: 0 }] };
      if (sql.includes("INSERT INTO ephemeral.synthetic_validation_receipts")) marks = JSON.parse(String(values?.[5]));
      return { rows: [] };
    } } as unknown as PoolClient;
    await attachSyntheticValidationReceipt(client, { tenantId: "tenant-synthetic", appId: "app-synthetic", token: syntheticValidationToken(),
      receipt: syntheticValidationToken(), batchId: "synthetic-batch", records: [
        { record_id: "record:synthetic-one", event_name: "custom_event", payload: { event_key: "synthetic_key" } },
        { record_id: "record:synthetic-two", event_name: "custom_event", payload: { event_key: ["synthetic_key"] } },
        { record_id: "record:synthetic-three", event_name: "untrusted-free-form", payload: { event_key: "private-not-copied" } },
      ] });
    assert.deepEqual(marks, [
      { record_id: "record:synthetic-one", event_class: "custom_event", custom_key_index: 0 },
      { record_id: "record:synthetic-two", event_class: "custom_event", custom_key_index: null },
      { record_id: "record:synthetic-three", event_class: "other", custom_key_index: null },
    ]);
  });
});
