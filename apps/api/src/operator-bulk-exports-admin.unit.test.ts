import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import type { PayloadStore } from "@openmasu/runtime";
import { rotateOperatorBulkExportCredentials } from "./operator-bulk-exports-admin.js";
import { renderBulkExportCredentials } from "./dashboard/bulk-export-credentials.js";

describe("bulk export credential replacement boundary", () => {
  it("rejects partial tuples, immutable fields and malformed revisions without touching protected state", async () => {
    let calls = 0;
    const pool = { connect: async () => { calls++; throw new Error("unexpected_database_access"); } } as unknown as Pool;
    const payloadStore = { write: async () => { calls++; throw new Error("unexpected_secret_write"); } } as unknown as PayloadStore;
    const complete = { expected_revision: "0", access_key_id: "SYNTHETICACCESSKEY", secret_access_key: "synthetic/secret/0001" };
    for (const body of [
      { expected_revision: "0", access_key_id: complete.access_key_id },
      { expected_revision: "0", secret_access_key: complete.secret_access_key },
      { ...complete, expected_revision: "-1" },
      { ...complete, session_token: "synthetic\ninvalid" },
      { ...complete, object_prefix: "private-value-must-not-appear" },
    ]) {
      await assert.rejects(rotateOperatorBulkExportCredentials({ pool, payloadStore,
        identity: { tenantId: "tenant-synthetic", appId: "app-synthetic", keyId: "key-synthetic", role: "admin" },
        destinationId: "bulk:synthetic", body,
      }), error => error instanceof Error && /^operator_bulk_[a-z_]+$/.test(error.message));
    }
    assert.equal(calls, 0);
  });

  it("renders explicit whole-tuple confirmation with revision and CSRF but no secret prefill", () => {
    const html = renderBulkExportCredentials({ destination_id: "bulk:synthetic", tenant_id: "tenant-synthetic",
      app_id: "app-synthetic", endpoint_url: "https://storage.example.test", bucket_name: "synthetic-bucket",
      object_prefix: "events", region: "auto", events: ["custom_event"], status: "active",
      start_at: "2026-08-30T00:00:00.000Z", created_at: "2026-08-30T00:00:00.000Z",
      status_changed_at: "2026-08-30T00:00:00.000Z", credential_revision: "12",
      credential_changed_at: "2026-08-31T00:00:00.000Z",
    }, "synthetic-csrf");
    assert.match(html, /name="expected_revision" value="12"/);
    assert.match(html, /name="csrf_token" value="synthetic-csrf"/);
    assert.equal((html.match(/type="password"/g) ?? []).length, 3);
    assert.doesNotMatch(html, /type="password"[^>]*value=|<script|javascript:|credential_ref|credential_digest/);
    assert.match(html, /blank clears the old token/);
    assert.match(html, /Confirm credential replacement/);
  });
});
