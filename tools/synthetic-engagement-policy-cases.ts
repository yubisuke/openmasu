type Any = Record<string, any>;
export type EngagementPolicyCase = { name: string; input: Any; expected: string[] };

// Sorted run order: ad USD micros, converted installations, purchase-net USD micros;
// campaigns a, b, c and empty. Values are hand arithmetic, not evaluator output.
const empty = ["empty_cohort", "empty_cohort", "empty_cohort"];
const unknown = ["insufficient_activity_history", "insufficient_activity_history", "insufficient_activity_history"];
const zero = ["0", "0", "0"];
const values = (a: string[], b = empty, c = unknown, d = empty) => [...a, ...b, ...c, ...d];
const normal = values(["2000000", "1", "5000000"]);

export function syntheticEngagementPolicyCases(baseline: Any): EngagementPolicyCase[] {
  const cases: EngagementPolicyCase[] = [];
  const batch = (v: Any, id: string) => v.batches.find((b: Any) => b.records[0].record_id === id);
  const record = (v: Any, id: string) => batch(v, id).records[0];
  const policy = (v: Any, inactivity: number, window = 3) => v.metric_definitions.forEach((d: Any) => {
    d.engagement_inactivity_days = inactivity; d.definition.window.day = window - 1;
  });
  const at = (b: Any, instant: string) => {
    b.records[0].occurred_at = instant;
    b.records[0].received_at = b.server_context.received_at = new Date(Date.parse(instant) + 1000).toISOString();
  };
  const removeB = (v: Any) => { v.batches = v.batches.filter((b: Any) => b.records[0].record_id !== "open64-b"); };
  const redact = (v: Any, id: string) => {
    v.privacy_requests = [{ contract_version: "0.4.0", tenant_id: "tenant-a", app_id: "app-a",
      privacy_request_id: "privacy-engagement-75", deletion_subject_digest: "7".repeat(64), deletion_scope: "installation",
      requested_via: "tenant_admin_api", requester_auth_ref: "admin:synthetic-engagement",
      requested_at: "2026-08-24T22:00:00.000Z", completed_at: "2026-08-24T22:01:00.000Z", status: "completed",
      reason_code: "privacy_deletion", policy_version: "privacy-v0.4", affected_records: [{ record_id: id, lifecycle_status: "redacted" }] }];
  };
  const add = (name: string, expected: string[], change: (value: Any) => void = () => {}) => {
    const input = structuredClone(baseline); change(input); cases.push({ name, input, expected });
  };
  add("inactive_active_and_unknown_are_distinct_and_partial_refund_keeps_original_purchase_credit", normal);
  add("explicitly_disabled_inactivity_uses_three_day_outcomes_without_double_credit", values(["2000000", "1", "5000000"], ["12000000", "1", "5000000"], zero), v => policy(v, 0));
  add("explicit_one_day_window_excludes_its_exact_upper_boundary", values(["2000000", "1", "5000000"], ["3000000", "1", "5000000"], zero), v => policy(v, 0, 1));
  add("three_day_policy_extends_outcomes_without_changing_the_legacy_24h_profile", values(["14000000", "1", "10000000"]), removeB);
  add("equal_time_opens_choose_the_same_record_id_before_campaign_and_inactivity_filters", values(["14000000", "1", "10000000"], zero), v => {
    record(v, "open64-b").occurred_at = record(v, "open64-a").occurred_at;
  });
  add("half_open_window_includes_the_last_millisecond_but_not_the_end", values(["5000001", "1", "10000000"]), v => {
    removeB(v); at(batch(v, "revenue64-boundary"), "2026-08-24T10:00:00.000Z");
    const prior = structuredClone(batch(v, "revenue64-boundary"));
    prior.batch_id = "engagement75:before-boundary";
    for (const key of ["record_id", "event_id", "delivery_id"]) prior.records[0][key] += "-before";
    at(prior, "2026-08-24T09:59:59.999Z"); prior.records[0].payload.amount_unscaled = "1"; v.batches.push(prior);
  });
  add("duplicate_delivery_preserves_one_canonical_purchase_and_outcome", normal, v => {
    for (const original of [...v.batches]) {
      const retry = structuredClone(original), r = retry.records[0]; retry.batch_id += "-retry";
      r.record_id += "-retry"; r.delivery_id += "-retry";
      r.received_at = retry.server_context.received_at = new Date(Date.parse(r.received_at) + 1000).toISOString();
      v.batches.push(retry);
    }
  });
  add("history_received_after_the_cutoff_cannot_prove_recorded_inactivity", values(unknown), v => {
    const b = batch(v, "install75-x"); b.records[0].received_at = b.server_context.received_at = "2026-08-26T00:00:00.000Z";
  });
  add("removed_winning_open_never_transfers_purchase_or_ad_credit_backwards", values(["2000000", "1", "5000000"], empty, zero), v => {
    policy(v, 0); redact(v, "open64-b");
  });
  add("removed_purchase_also_removes_its_partial_refund_from_net", values(["2000000", "1", "0"]), v => redact(v, "purchase75-a"));
  add("removed_sdk_install_prefix_makes_history_unknown_not_inactive", values(unknown), v => redact(v, "install75-x"));
  add("client_producer_cannot_claim_verified_purchase_net_with_a_trusted_policy_name", values(["2000000", "1", "0"]), v => {
    for (const id of ["purchase75-a", "purchase75-b", "refund75-a"]) record(v, id).producer = "sdk-android";
  });
  add("adapter_producer_without_the_verifier_policy_cannot_claim_verified_purchase_net", values(["2000000", "1", "0"]), v => {
    for (const id of ["purchase75-a", "purchase75-b", "refund75-a"]) batch(v, id).server_context.policy_digest = "synthetic-client-policy";
  });
  add("any_selected_unknown_history_withholds_the_whole_population_not_a_partial_sum", unknown, v => {
    v.metric_evaluations = [v.metric_evaluations[0]]; delete v.metric_evaluations[0].grouping.campaign_id;
  });
  add("exact_verified_refund_cancellation_restores_original_credit_even_after_the_outcome_window", values(["2000000", "1", "8000000"]), v => {
    const reversal = structuredClone(batch(v, "refund75-a")); reversal.batch_id = "engagement75:refund-reversal";
    const r = reversal.records[0];
    for (const key of ["record_id", "event_id", "delivery_id"]) r[key] += "-reversed";
    Object.assign(r.payload, { transaction_id: "refund-transaction75-reversal", financial_status: "reversed", reverses_refund_record_id: "refund75-a" });
    at(reversal, "2026-08-24T12:00:00.000Z"); v.batches.push(reversal);
  });
  add("money_rounds_each_verified_purchase_and_refund_half_even_before_netting", values(["2", "1", "2"]), v => {
    for (const [id, amount] of [["revenue64-a", "15"], ["purchase75-a", "15"], ["refund75-a", "5"]])
      Object.assign(record(v, id).payload, { amount_unscaled: amount, amount_scale: 7 });
  });
  add("fixed_receipt_cutoff_excludes_later_opens_purchases_and_refunds", values(["2000000", "1", "0"], empty, empty), v => {
    for (const evaluation of v.metric_evaluations) evaluation.input_received_at_watermark = "2026-08-21T10:45:00.000Z";
  });
  return cases;
}
