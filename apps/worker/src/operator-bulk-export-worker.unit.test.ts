import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { describe, it } from "node:test";
import { buildOperatorWebhookRequest } from "./operator-webhook-worker.js";
import {
  buildOperatorBulkRows,
  prepareOperatorBulkExport,
  type OperatorBulkEventCandidate,
} from "./operator-bulk-export-worker.js";

const secret = Buffer.from("synthetic-bulk-reference-secret-material-32", "utf8");
const candidate: OperatorBulkEventCandidate = {
  destination_id: "bulk:synthetic",
  endpoint_url: "https://objects.example.test",
  secret_ref: "synthetic-ref",
  logical_event_id: "event:synthetic",
  record_id: "record:synthetic",
  app_id: "app-a",
  event_name: "purchase",
  occurred_at: "2026-08-30T00:00:00.000Z",
  received_at: "2026-08-30T00:00:01.000Z",
  installation_id: "installation:synthetic",
  event_key: null,
  transaction_id: "transaction:synthetic",
  original_transaction_id: null,
  amount_unscaled: "1230000",
  amount_scale: 6,
  currency: "USD",
  financial_status: "paid",
  revenue_source: null,
  ad_network: null,
  country: null,
};

describe("operator bulk export files", () => {
  it("reuses the webhook event object byte-for-byte and never exports ledger identifiers", () => {
    const [row] = buildOperatorBulkRows({ events: [candidate], deletions: [], referenceSecret: secret });
    const webhook = buildOperatorWebhookRequest({
      candidate, deliveryId: "019c0000-0000-7000-8000-000000000001",
      emittedAt: "2026-08-30T00:00:02.000Z", secret,
    });
    assert.equal(row?.record_kind, "event");
    if (row?.record_kind !== "event") throw new Error("synthetic_event_row_missing");
    assert.deepEqual(row.event, webhook.envelope.event);
    const serialized = JSON.stringify(row);
    for (const forbidden of ["record:synthetic", "event:synthetic", "installation:synthetic", "transaction:synthetic"]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  });

  it("emits a deterministic gzip NDJSON manifest, event, and destination-scoped deletion row", () => {
    const rows = buildOperatorBulkRows({
      events: [candidate],
      deletions: [{
        deletion_seq: "1", app_id: "app-a", subject_ref: "a".repeat(64),
        recognized_at: "2026-08-30T00:00:03.000Z",
      }],
      referenceSecret: secret,
    });
    const input = {
      exportId: "export:synthetic",
      destinationId: "bulk:synthetic",
      appId: "app-a",
      objectPrefix: "openmasu/events",
      generatedAt: "2026-08-30T00:00:04.000Z",
      cursorBefore: { event_received_at: null, event_record_id: null, deletion_seq: "0" },
      cursorAfter: {
        event_received_at: candidate.received_at, event_record_id: candidate.record_id, deletion_seq: "1",
      },
      rows,
    } as const;
    const first = prepareOperatorBulkExport(input);
    const second = prepareOperatorBulkExport(input);
    assert.equal(first.body.equals(second.body), true);
    assert.equal(first.bodyDigest, second.bodyDigest);
    assert.equal(first.objectKey, "openmasu/events/date=2026-08-30/bulk_synthetic-export_synthetic.ndjson.gz");
    const lines = gunzipSync(first.body).toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines[0].schema, "openmasu.operator_event_export_manifest.v1");
    assert.equal(lines[0].row_count, 2);
    assert.deepEqual(lines[1], {
      schema: "openmasu.operator_event_export.v1",
      record_kind: "privacy_deletion",
      app_id: "app-a",
      subject_ref: "a".repeat(64),
      recognized_at: "2026-08-30T00:00:03.000Z",
    });
    assert.equal(lines[2].record_kind, "event");
  });
});
