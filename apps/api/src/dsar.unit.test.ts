import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertDsarResponseSafe, parseDsarRequest } from "./dsar.js";

describe("subject access and portability", () => {
  it("accepts only an installation-scoped access or portability request", () => {
    assert.deepEqual(parseDsarRequest({ installation_id: "installation:synthetic", request_type: "access" }), {
      installationId: "installation:synthetic", requestType: "access",
    });
    assert.throws(() => parseDsarRequest({
      installation_id: "installation:synthetic", request_type: "access", tenant_id: "tenant:forged",
    }), /dsar_request_invalid/);
    assert.throws(() => parseDsarRequest({ installation_id: "installation:synthetic", request_type: "delete" }), /dsar_request_type_invalid/);
  });

  it("fails closed if a portable response exposes protected identifiers", () => {
    assert.doesNotThrow(() => assertDsarResponseSafe({ records: [{ record_ref: "a".repeat(64) }] }));
    assert.throws(() => assertDsarResponseSafe({ raw_payload_ref: "encrypted:synthetic" }), /dsar_forbidden_field/);
    assert.throws(() => assertDsarResponseSafe({ transaction_id: "transaction:synthetic" }), /dsar_forbidden_field/);
  });
});
