type Any = Record<string, any>;
export type EngagementCase = { name: string; input: Any; expected: string[] };
// Money then converters, in metric_run_id order: a, all, b, c, empty.
const empty = ["empty_cohort", "empty_cohort"];
const normal = ["2000000", "1", "5000000", "1", "3000000", "1", "0", "0", ...empty];
export function syntheticEngagementCases(baseline: Any): EngagementCase[] {
  const cases: EngagementCase[] = [];
  const batch = (value: Any, id: string) => value.batches.find((b: Any) => b.records[0].record_id === id);
  const record = (value: Any, id: string) => batch(value, id).records[0];
  const add = (name: string, expected: string[], change: (input: Any) => void = () => {}) => {
    const input = structuredClone(baseline); change(input); cases.push({ name, input, expected });
  };
  add("latest-open-is-chosen-before-campaign-filter-with-zero-and-undefined-separated", normal);
  add("duplicate-deliveries-and-repeated-conversions-do-not-inflate-outcomes", normal, value => {
    for (const original of [...value.batches]) {
      const retry = structuredClone(original), r = retry.records[0];
      retry.batch_id += "-retry"; r.record_id += "-retry"; r.delivery_id += "-retry";
      r.received_at = new Date(Date.parse(r.received_at) + 1000).toISOString();
      retry.server_context.received_at = r.received_at;
      value.batches.push(retry);
    }
    const repeat = structuredClone(batch(value, "conversion64-a"));
    repeat.batch_id += "-repeat";
    for (const key of ["record_id", "delivery_id", "event_id"]) repeat.records[0][key] += "-repeat";
    value.batches.push(repeat);
  });
  add("equal-time-open-tie-uses-record-id-not-input-order", ["5000000", "1", "5000000", "1", "0", "0", "0", "0", ...empty], value => {
    record(value, "open64-b").occurred_at = record(value, "open64-a").occurred_at;
  });
  for (const status of ["unknown", "inactive", "reused_install_click"]) {
    add(`${status}-does-not-claim-or-displace-eligible-engagement`, ["5000000", "1", "5000000", "1", ...empty, "0", "0", ...empty], value => {
      const b = batch(value, "open64-b");
      if (status === "reused_install_click") {
        b.records[0].payload.open_source = "android_deferred_referrer";
        b.server_context.deep_link_resolution.install_attribution_click_id = "synthetic_0000000000000064";
        b.records[0].payload.click_id = "synthetic_0000000000000064";
      } else b.server_context.deep_link_resolution.status = status;
    });
  }
  add("anchor-date-not-outcome-date-selects-the-series", ["5000000", "1", "5000000", "1", ...empty, "0", "0", ...empty], value => {
    const b = batch(value, "open64-b");
    b.records[0].occurred_at = "2026-08-22T00:00:00.000Z";
    b.records[0].received_at = b.server_context.received_at = "2026-08-22T00:00:01.000Z";
  });
  add("fixed-watermark-excludes-later-opens-and-outcomes", ["2000000", "1", "2000000", "1", ...empty, ...empty, ...empty], value => {
    for (const evaluation of value.metric_evaluations) evaluation.input_received_at_watermark = "2026-08-21T11:00:00.000Z";
  });
  add("24h-is-inclusive-at-open-and-exclusive-at-the-upper-bound", ["2000001", "1", "9000001", "1", "7000000", "1", "0", "0", ...empty], value => {
    const atOpen = record(value, "revenue64-before");
    atOpen.occurred_at = "2026-08-21T10:00:00.000Z";
    atOpen.received_at = batch(value, "revenue64-before").server_context.received_at = "2026-08-21T10:00:01.000Z";
    atOpen.payload.amount_unscaled = "1";
    const beforeEnd = structuredClone(batch(value, "revenue64-boundary")), r = beforeEnd.records[0];
    beforeEnd.batch_id += "-before";
    for (const key of ["record_id", "delivery_id", "event_id"]) r[key] += "-before";
    r.occurred_at = "2026-08-22T11:59:59.999Z"; r.payload.amount_unscaled = "4000000";
    value.batches.push(beforeEnd);
  });
  const redact = (value: Any, id: string) => {
    value.privacy_requests = [{ contract_version: "0.4.0", tenant_id: "tenant-a", app_id: "app-a",
      privacy_request_id: "privacy-engagement-64", deletion_subject_digest: "6".repeat(64), deletion_scope: "installation",
      requested_via: "tenant_admin_api", requester_auth_ref: "admin:synthetic-engagement",
      requested_at: "2026-08-23T00:00:00.000Z", completed_at: "2026-08-23T00:01:00.000Z", status: "completed",
      reason_code: "privacy_deletion", policy_version: "privacy-v0.4", affected_records: [{ record_id: id, lifecycle_status: "redacted" }] }];
    for (const evaluation of value.metric_evaluations) evaluation.privacy_state = "after";
  };
  add("removed-winning-open-never-transfers-credit-to-an-older-open", ["2000000", "1", "2000000", "1", ...empty, "0", "0", ...empty], value => redact(value, "open64-b"));
  add("removed-outcome-is-excluded-without-removing-the-population", ["0", "1", "3000000", "1", "3000000", "1", "0", "0", ...empty], value => redact(value, "revenue64-a"));
  add("other-installation-outcomes-never-join-on-campaign-alone", ["2000000", "1", "2000000", "1", "0", "0", "0", "0", ...empty], value => {
    for (const id of ["conversion64-b", "revenue64-b"]) record(value, id).payload.installation_id = "synthetic-foreign-installation";
  });
  add("money-rounds-half-even-per-event-before-summing", ["2", "1", "4", "1", "2", "1", "0", "0", ...empty], value => {
    for (const [id, amount] of [["revenue64-a", "15"], ["revenue64-b", "25"]]) {
      Object.assign(record(value, id).payload, { amount_unscaled: amount, amount_scale: 7 });
    }
  });
  return cases;
}
