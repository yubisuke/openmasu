import { SELECTED_COMMERCE_METRIC_DEFINITIONS } from "@openmasu/contracts/definitions";

type Any = Record<string, any>;
export type RefundReversalCase = { name: string; input: Any; expectedNet: string[]; rejected: boolean };

/** Shared synthetic inputs, with independently specified USD-micro outcomes. */
export function syntheticRefundReversalCases(baseline: Any): RefundReversalCase[] {
  const cases: RefundReversalCase[] = [];
  const add = (name: string, expectedNet: string[], change: (input: Any) => void = () => {}, rejected = false) => {
    const input = structuredClone(baseline); change(input); cases.push({ name, input, expectedNet, rejected });
  };
  const normal = ["10000000", "6000000", "10000000"];
  const unchanged = ["10000000", "6000000", "6000000"];
  add("explicit-cancellation-restores-only-the-target", normal);
  add("legacy-definition-keeps-its-original-meaning", unchanged, value => {
    value.metric_definitions = SELECTED_COMMERCE_METRIC_DEFINITIONS.filter(d => value.metric_definitions.some((v: Any) => v.metric_name === d.metric_name));
  });
  add("unlinked-reversed-is-not-a-cancellation", unchanged, value => { delete value.batches[2].records[0].payload.reverses_refund_record_id; });
  add("duplicate-delivery-and-business-retry-restore-once", normal, value => {
    const record = value.batches[2].records[0];
    value.batches[2].records.push({ ...structuredClone(record), record_id: "reversal-retry", delivery_id: "delivery:retry" },
      { ...structuredClone(record), record_id: "reversal-business-retry", event_id: "event:business-retry", delivery_id: "delivery:business-retry" });
  });
  add("two-cancellation-claims-never-add-a-second-credit", normal, value => {
    const record = structuredClone(value.batches[2].records[0]);
    Object.assign(record, { record_id: "reversal-second-claim", event_id: "event:second-claim", delivery_id: "delivery:second-claim" });
    record.payload.transaction_id = "reversal-second-claim";
    value.batches[2].records.push(record);
  });
  add("other-partial-refund-remains-deducted", ["10000000", "4000000", "8000000"], value => {
    const refund = structuredClone(value.batches[1].records[0]);
    Object.assign(refund, { record_id: "refund-second-part", event_id: "event:second-part", delivery_id: "delivery:second-part" });
    Object.assign(refund.payload, { transaction_id: "refund-second-part", amount_unscaled: "2000000" });
    value.batches[1].records.push(refund);
  });
  for (const [field, replacement] of Object.entries({ reverses_refund_record_id: "missing-refund",
    installation_id: "different-installation", original_transaction_id: "different-original", currency: "EUR", amount_unscaled: "4000001" })) {
    add(`reject-${field}-mismatch`, unchanged, value => { value.batches[2].records[0].payload[field] = replacement; }, true);
  }
  add("target-purchase-is-not-a-refund", unchanged, value => { value.batches[2].records[0].payload.reverses_refund_record_id = "purchase-60"; }, true);
  add("cancellation-before-refund-occurrence-is-rejected", unchanged, value => { value.batches[2].records[0].occurred_at = "2026-08-06T02:59:59.999Z"; }, true);
  add("target-not-yet-received-is-rejected", unchanged, value => {
    value.batches[2].server_context.received_at = value.batches[2].records[0].received_at = "2026-08-12T12:00:00.000Z";
  }, true);
  for (const field of ["tenant_id", "app_id"]) add(`cross-${field}-cannot-cancel`, unchanged, value => {
    value.batches[2].server_context[field] = value.batches[2].records[0][field] = `synthetic-other-${field}`;
  }, true);
  add("exact-equivalent-scale-is-accepted", normal, value => {
    Object.assign(value.batches[2].records[0].payload, { amount_unscaled: "4000", amount_scale: 3 });
  });
  add("late-cancellation-uses-refund-window-not-new-purchase-time", normal, value => {
    value.batches[2].records[0].occurred_at = "2026-12-01T00:00:00.000Z";
    value.batches[2].server_context.received_at = value.batches[2].records[0].received_at = "2026-12-02T00:00:00.000Z";
    value.metric_evaluations[2].input_received_at_watermark = value.metric_evaluations[2].computed_at = "2026-12-02T00:00:00.000Z";
  });
  add("excluded-refund-does-not-create-positive-revenue", ["10000000", "10000000", "10000000"], value => {
    value.batches[1].records[0].occurred_at = "2026-09-06T00:00:00.000Z";
    value.batches[1].server_context.received_at = value.batches[1].records[0].received_at = "2026-09-07T00:00:00.000Z";
    value.batches[2].records[0].occurred_at = "2026-09-07T00:00:00.000Z";
    value.batches[2].server_context.received_at = value.batches[2].records[0].received_at = "2026-09-08T00:00:00.000Z";
    for (const n of [1, 2]) value.metric_evaluations[n].input_received_at_watermark = value.metric_evaluations[n].computed_at = value.batches[n].server_context.received_at;
  });
  for (const [recordId, expected] of [["reversal-62", "6000000"], ["refund-60", "10000000"], ["purchase-60", "0"]]) {
    add(`privacy-removes-${recordId}`, ["10000000", "6000000", expected], value => {
      value.privacy_requests = [{ contract_version: "0.4.0", tenant_id: "tenant-a", app_id: "app-a",
        privacy_request_id: "privacy-reversal-62", deletion_subject_digest: "6".repeat(64), deletion_scope: "installation",
        requested_via: "tenant_admin_api", requester_auth_ref: "admin:synthetic-reversal",
        requested_at: "2026-08-14T00:00:00.000Z", completed_at: "2026-08-14T00:01:00.000Z", status: "completed",
        reason_code: "privacy_deletion", policy_version: "privacy-v0.4",
        affected_records: [{ record_id: recordId, lifecycle_status: "redacted" }] }];
      value.metric_evaluations[2].privacy_state = "after";
    });
  }
  return cases;
}
