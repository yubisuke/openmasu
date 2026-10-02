import { M1B_METRIC_DEFINITIONS, SELECTED_ACQUISITION_METRIC_DEFINITIONS } from "@openmasu/contracts";

type Any = Record<string, any>;

/** Shared synthetic inputs only; expected arithmetic is independent of evaluators. */
export function syntheticRetentionCases(baseline: Any): Array<{ name: string; input: Any; expected: Record<string, string> }> {
  const selected = structuredClone(baseline);
  const install = selected.records.find((row: Any) => row.event_name === "install");
  const session = { ...structuredClone(install), record_id: "session-retention", delivery_id: "delivery:session-retention",
    event_id: "event:session-retention", event_name: "session_start", processing_sequence: 2,
    occurred_at: new Date(Date.parse(install.occurred_at) + 86_400_000).toISOString(),
    payload: { event_name: "session_start", installation_id: install.payload.installation_id, session_id: "session-retention" } };
  selected.records.push(session);
  selected.metric_definitions = structuredClone(SELECTED_ACQUISITION_METRIC_DEFINITIONS.filter(definition =>
    ["retention_d1", "cohort_install_count"].includes(definition.metric_name)));
  selected.metric_evaluations[0].metric_names = ["retention_d1", "cohort_install_count"];

  const mixed = structuredClone(selected);
  mixed.server_context.fraud_actions_enabled = true;
  const click = structuredClone(mixed.records.find((row: Any) => row.event_name === "click"));
  Object.assign(click, { record_id: "click-retention-excluded", event_id: "event:click-retention-excluded", delivery_id: "delivery:click-retention-excluded" });
  Object.assign(click.payload, { click_id: "click-excluded_0000000000000000", bot_prefetch: true });
  const excludedInstall = structuredClone(install);
  Object.assign(excludedInstall, { record_id: "install-retention-excluded", event_id: "event:install-retention-excluded", delivery_id: "delivery:install-retention-excluded" });
  Object.assign(excludedInstall.payload, { installation_id: "installation:retention-excluded", click_id: click.payload.click_id });
  mixed.records.push(click, excludedInstall);
  mixed.records.find((row: Any) => row.event_name === "session_start").payload.installation_id = excludedInstall.payload.installation_id;
  mixed.metric_evaluations[0].grouping = { cohort_date: "2026-08-06" };
  const policies = (definitions: Any[]) => ["gross", "net"].flatMap(fraud_policy => definitions.map(definition => ({
    ...structuredClone(definition), metric_name: `${definition.metric_name}_${fraud_policy}`, fraud_policy,
  })));
  mixed.metric_definitions = policies(mixed.metric_definitions);
  mixed.metric_evaluations[0].metric_names = mixed.metric_definitions.map((definition: Any) => definition.metric_name);
  const legacy = structuredClone(mixed);
  legacy.metric_definitions = policies(M1B_METRIC_DEFINITIONS.filter(definition =>
    ["retention_d1", "cohort_install_count"].includes(definition.metric_name)));

  const late = structuredClone(selected), receivedAt = "2026-08-13T00:00:00.000Z";
  late.batches = [
    { batch_id: "retention-initial", server_context: late.server_context, records: late.records.filter((row: Any) => row.event_name !== "session_start") },
    { batch_id: "retention-late", server_context: { ...late.server_context, received_at: receivedAt }, records: [{ ...session, received_at: receivedAt }] },
  ];
  delete late.records;
  const mixedExpected = { cohort_install_count_gross: "2", cohort_install_count_net: "1", retention_d1_gross: "500000", retention_d1_net: "0" };
  return [
    { name: "selected-campaign", input: selected, expected: { cohort_install_count: "1", retention_d1: "1000000" } },
    { name: "selected-gross-net", input: mixed, expected: mixedExpected },
    { name: "recorded-gross-net", input: legacy, expected: mixedExpected },
    { name: "late-session", input: late, expected: { cohort_install_count: "1", retention_d1: "0" } },
  ];
}
