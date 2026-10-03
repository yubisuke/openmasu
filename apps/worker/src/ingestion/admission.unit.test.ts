import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { CandidateAttempt } from "@openmasu/attribution-core";
import { schemaInvalidArtifacts } from "./admission.js";
import { acquisitionDimensions, platformInstallEvidence } from "./fact-projections.js";

describe("ingestion admission and shared projection boundaries", () => {
  it("rejects an invalid payload using only the existing non-identifying metadata", () => {
    const input = JSON.parse(readFileSync("fixtures/v0.4/52-bounded-edge-evidence/input.json", "utf8"));
    const attempt: CandidateAttempt = { server: input.server_context, record: input.records[0], batch_id: "synthetic-admission" };
    assert.equal(schemaInvalidArtifacts(attempt), undefined);
    const invalid = { ...attempt, record: {
      ...attempt.record, payload: { ...attempt.record.payload, country: "synthetic-invalid-country", installation_id: "synthetic-protected-marker" },
    } };
    const rejected = schemaInvalidArtifacts(invalid)!;
    assert.equal(rejected.delivery.payload_disposition, "discarded");
    assert.equal(rejected.rejection.retained, "non_identifying_metadata");
    assert.equal(rejected.rejection.reason_code, "payload_schema_invalid");
    assert.ok(rejected.failure.fields.length > 0);
    assert.deepEqual(Object.keys(rejected.failure).sort(), ["delivery_id", "fields", "record_id"]);
    assert.deepEqual(Object.keys(rejected.rejection).sort(), [
      "app_id", "consent_decision_reason_code", "consent_evaluation_policy_version", "contract_version", "delivery_id",
      "payload_disposition", "processing_purpose_id", "reason_code", "reason_code_version", "record_id", "retained", "tenant_id",
    ]);
    assert.doesNotMatch(JSON.stringify(rejected), /synthetic-invalid-country|synthetic-protected-marker|tracking_link_id|campaign_id/);
  });
  it("shares row and bulk acquisition dimensions without changing fallback or empty-string semantics", () => {
    assert.deepEqual(acquisitionDimensions({}), { campaignId: null, network: null, country: null });
    const imported = { provider_campaign_ref: "synthetic-imported", provider_network: "synthetic-network", provider_country: "JP" };
    assert.deepEqual(acquisitionDimensions({ import_context: imported }), { campaignId: "synthetic-imported", network: "synthetic-network", country: "JP" });
    assert.deepEqual(acquisitionDimensions({ campaign_id: "synthetic-declared", network: "", country: "US", import_context: imported }), {
      campaignId: "synthetic-declared", network: "", country: "US",
    });
  });
  it("projects bounded server-decrypted platform evidence without raw referrer data or unverified markers", () => {
    const payload = {
      meta_referrer_status: "decrypted", protected_referrer_evidence_ref: "payload:synthetic-encrypted-referrer",
      meta_referrer_context: { attribution_model: "last_click", campaign_id: "synthetic-campaign", adgroup_id: "synthetic-adgroup",
        account_id: "synthetic-unneeded-account", actual_timestamp: 123 },
      extensions: { meta_decryption_key_id: "synthetic-key", meta_install_referrer_protected: "synthetic-ciphertext" },
    };
    assert.deepEqual(platformInstallEvidence(payload), {
      meta_referrer_status: "decrypted", protected_referrer_evidence_ref: payload.protected_referrer_evidence_ref,
      meta_referrer_context: { attribution_model: "last_click", campaign_id: "synthetic-campaign", adgroup_id: "synthetic-adgroup" },
      extensions: { meta_decryption_key_id: "synthetic-key" },
    });
    assert.deepEqual(platformInstallEvidence({ ...payload, extensions: {} }), {});
    assert.deepEqual(platformInstallEvidence({ ...payload, meta_referrer_status: "auth_failed" }), {});
  });
});
