import { customConversionMetricDefinitions } from "@openmasu/contracts";
import { syntheticRetentionCases } from "./synthetic-retention-cases.js";

type Any = Record<string, any>;
export type ConversionCase = { name: string; input: Any; expected: string[] };

/** Synthetic boundary cases shared by independent-reference and SQL acceptance. */
export function syntheticConversionCases(baseline: Any, native: Any): ConversionCase[] {
  const cases: ConversionCase[] = [];
  const add = (name: string, expected: string[], change: (input: Any) => void = () => {}) => {
    const input = structuredClone(baseline); change(input); cases.push({ name, input, expected });
  };
  add("three-of-ten", ["300000", "3"]);
  add("without-grouping", ["300000", "3"], input => { delete input.metric_evaluations[0].grouping; });
  add("irrelevant-duplicate-and-half-open-boundaries", ["300000", "3"], input => {
    const original = input.records.find((row: Any) => row.event_name === "custom_event");
    // Same logical identity is delivered again; it cannot add a converter.
    input.records.push({ ...structuredClone(original), record_id: "conversion-duplicate", delivery_id: "delivery:conversion-duplicate", processing_sequence: 2 });
    for (const [id, occurred_at, event_key] of [
      ["different-key", "2026-08-07T00:00:00.000Z", "different_outcome"],
      ["before-install", "2026-08-05T23:59:59.999Z", "tutorial_complete"],
      ["at-end", "2026-08-14T00:00:00.000Z", "tutorial_complete"],
    ]) input.records.push({ ...structuredClone(original), record_id: id, delivery_id: `delivery:${id}`, event_id: `event:${id}`,
      occurred_at, payload: { installation_id: "installation:install-conversion-04", event_key } });
  });
  add("last-in-window", ["400000", "4"], input => {
    const original = input.records.find((row: Any) => row.event_name === "custom_event");
    input.records.push({ ...structuredClone(original), record_id: "last-in-window", delivery_id: "delivery:last-in-window",
      event_id: "event:last-in-window", occurred_at: "2026-08-13T23:59:59.999Z",
      payload: { installation_id: "installation:install-conversion-04", event_key: "tutorial_complete" } });
  });
  add("late-outcome", ["300000", "3"], input => {
    const original = input.records.find((row: Any) => row.event_name === "custom_event");
    const late = "2026-08-16T00:00:00.000Z";
    input.batches = [
      { batch_id: "conversion-initial", server_context: input.server_context, records: input.records },
      { batch_id: "conversion-late", server_context: { ...input.server_context, received_at: late }, records: [{
        ...structuredClone(original), record_id: "late-outcome", delivery_id: "delivery:late-outcome", event_id: "event:late-outcome",
        received_at: late, payload: { installation_id: "installation:install-conversion-04", event_key: "tutorial_complete" },
      }] },
    ]; delete input.records;
  });
  add("unreached-key-is-zero", ["0", "0"], input => { input.metric_definitions = customConversionMetricDefinitions("different_outcome"); });
  add("empty-cohort", ["empty_cohort", "empty_cohort"], input => { input.metric_evaluations[0].grouping.country = "JP"; });
  add("unattributed-separated", ["1000000", "1"], input => {
    input.records[0].payload.referrer_status = "unavailable";
    input.metric_evaluations[0].grouping.attribution_status = "unattributed";
  });
  add("privacy-removes-install-and-outcomes", ["222222", "2"], input => {
    input.privacy_requests = [{ contract_version: "0.4.0", tenant_id: "tenant-a", app_id: "app-a",
      privacy_request_id: "privacy-conversion", deletion_subject_digest: "6".repeat(64), deletion_scope: "installation",
      requested_via: "tenant_admin_api", requester_auth_ref: "admin_key:synthetic-conversion",
      requested_at: "2026-08-16T00:00:00.000Z", completed_at: "2026-08-16T00:01:00.000Z", status: "completed",
      reason_code: "privacy_deletion", policy_version: "privacy-v0.4", affected_records: input.records
        .filter((row: Any) => row.payload.installation_id === "installation:install-conversion-03")
        .map((row: Any) => ({ record_id: row.record_id, lifecycle_status: "redacted" })) }];
    input.metric_evaluations[0].privacy_state = "after";
  });
  const nativeCases = syntheticRetentionCases(native).filter(entry => ["selected-campaign", "selected-gross-net"].includes(entry.name));
  for (const entry of nativeCases) {
    const input = entry.input;
    for (const record of input.records.filter((row: Any) => row.event_name === "session_start")) {
      record.event_name = "custom_event";
      record.payload = { installation_id: record.payload.installation_id, event_key: "tutorial_complete" };
    }
    const net = entry.name === "selected-gross-net";
    input.metric_definitions = net ? ["gross", "net"].flatMap(fraud_policy => customConversionMetricDefinitions("tutorial_complete")
      .map(definition => ({ ...definition, fraud_policy, metric_name: `${definition.metric_name}_${fraud_policy}` })))
      : customConversionMetricDefinitions("tutorial_complete");
    input.metric_evaluations[0].metric_names = input.metric_definitions.map((definition: Any) => definition.metric_name);
    cases.push({ name: entry.name, input, expected: net ? ["500000", "0", "1", "0"] : ["1000000", "1"] });
  }
  return cases;
}
