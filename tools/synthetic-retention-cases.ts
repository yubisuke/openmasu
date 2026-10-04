import { M1B_METRIC_DEFINITIONS, SELECTED_ACQUISITION_METRIC_DEFINITIONS, standardRetentionMetricDefinitions } from "@openmasu/contracts/definitions";

type Any = Record<string, any>;

/** Shared synthetic inputs only; expected arithmetic is independent of evaluators. */
export function syntheticRetentionCases(baseline: Any, platform?: Any, imported?: Any): Array<{
  name: string; input: Any; expected: Record<string, string>; undefinedReasons?: Record<string, string>;
}> {
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
    ...standardRetentionCases(selected, mixed, platform, imported),
  ];
}

function standardRetentionCases(selected: Any, mixed: Any, platform?: Any, imported?: Any) {
  type Case = { name: string; input: Any; expected: Record<string, string>; undefinedReasons?: Record<string, string> };
  const cases: Case[] = [];
  const definitions = standardRetentionMetricDefinitions();
  const records = (input: Any): Any[] => input.records ?? input.batches.flatMap((batch: Any) => batch.records);
  const prepare = (source: Any, target: Any, inside: boolean, basis: Parameters<typeof standardRetentionMetricDefinitions>[0] = "selected_first_party_click", provider?: string) => {
    const input = structuredClone(source), server = input.server_context ?? input.batches[0].server_context;
    const profile = standardRetentionMetricDefinitions(basis, provider);
    const original = records(input).filter(record => ["click", "install"].includes(record.event_name));
    const sessions = profile.flatMap(definition => {
      const day = definition.definition.window.day, start = Date.parse(target.occurred_at) + day * 86_400_000;
      // Outside pair alone proves both boundaries; inside pair proves distinct-installation dedupe.
      return (inside ? [start, start + 86_400_000 - 1] : [start - 1, start + 86_400_000]).map((at, index) => ({
        ...structuredClone(target), record_id: `retention-${day}-${index}`, event_id: `event:retention-${day}-${index}`,
        delivery_id: `delivery:retention-${day}-${index}`, event_name: "session_start", occurred_at: new Date(at).toISOString(),
        received_at: new Date(at + 1000).toISOString(), processing_sequence: day + index + 2,
        payload: { event_name: "session_start", installation_id: target.payload.installation_id, session_id: `retention-${day}-${index}` },
      }));
    });
    input.batches = [...original, ...sessions].map((record, index) => ({ batch_id: `retention-${index}`,
      server_context: { ...server, received_at: record.received_at }, records: [record] }));
    delete input.records;
    input.metric_definitions = profile;
    const watermark = new Date(Date.parse(target.occurred_at.slice(0, 10)) + 34 * 86_400_000).toISOString();
    input.metric_evaluations = [{ ...input.metric_evaluations[0], metric_run_id_prefix: "standard-retention",
      metric_names: profile.map(definition => definition.metric_name), input_received_at_watermark: watermark,
      computed_at: watermark, grouping: { cohort_date: target.occurred_at.slice(0, 10) } }];
    input.cost_records = [];
    return input;
  };
  const expected = (input: Any, value: string) => Object.fromEntries(input.metric_definitions.map((definition: Any) => [definition.metric_name, value]));
  const install = records(selected).find(record => record.event_name === "install");
  if (!install) throw new Error("synthetic retention install missing");
  const outside = prepare(selected, install, false), inside = prepare(selected, install, true);
  cases.push({ name: "standard-half-open-boundaries", input: outside, expected: expected(outside, "0") },
    { name: "standard-multiple-sessions-one-installation", input: inside, expected: expected(inside, "1000000") });
  const excluded = records(mixed).find(record => record.event_name === "install" && record.record_id !== install.record_id);
  if (!excluded) throw new Error("synthetic excluded retention install missing");
  const population = prepare(mixed, excluded, true);
  population.metric_definitions = ["gross", "net"].flatMap(fraud_policy => definitions.map(definition => ({
    ...structuredClone(definition), metric_name: `${definition.metric_name}_${fraud_policy}`, fraud_policy,
  })));
  population.metric_evaluations[0].metric_names = population.metric_definitions.map((definition: Any) => definition.metric_name);
  cases.push({ name: "standard-excluded-install-gross-net", input: population, expected: Object.fromEntries(population.metric_definitions.map((definition: Any) => [definition.metric_name, definition.fraud_policy === "gross" ? "500000" : "0"])) });
  const delayed = structuredClone(inside);
  const watermark = delayed.metric_evaluations[0].input_received_at_watermark;
  for (const batch of delayed.batches) if (batch.records[0].event_name === "session_start") {
    batch.server_context.received_at = new Date(Date.parse(watermark) + 86_400_000).toISOString();
    batch.records[0].received_at = batch.server_context.received_at;
  }
  cases.push({ name: "standard-late-session-cutoff", input: delayed, expected: expected(delayed, "0") });
  const backfill = structuredClone(delayed);
  backfill.metric_evaluations[0].computed_at = backfill.metric_evaluations[0].input_received_at_watermark = new Date(Date.parse(watermark) + 2 * 86_400_000).toISOString();
  cases.push({ name: "standard-explicit-late-session-correction", input: backfill, expected: expected(backfill, "1000000") });
  // Installed at the date's start, but the policy conservatively covers every install time in that date.
  for (const elapsedDays of [5 - 1 / 86_400_000, 5, 16, 32]) {
    const immature = structuredClone(inside);
    immature.batches = immature.batches.filter((batch: Any) => batch.records[0].event_name !== "session_start");
    for (const batch of immature.batches) batch.server_context.received_at = batch.records[0].received_at = "2026-08-10T00:00:00.000Z";
    immature.metric_evaluations[0].computed_at = immature.metric_evaluations[0].input_received_at_watermark = new Date(Date.parse("2026-08-06") + Math.round(elapsedDays * 86_400_000)).toISOString();
    cases.push({ name: `standard-maturity-${elapsedDays}`, input: immature,
      expected: Object.fromEntries(definitions.filter(definition => definition.definition.window.day + 2 <= elapsedDays).map(definition => [definition.metric_name, "0"])),
      undefinedReasons: Object.fromEntries(definitions.filter(definition => definition.definition.window.day + 2 > elapsedDays).map(definition => [definition.metric_name, "observation_window_not_elapsed"])) });
  }
  const privacy = structuredClone(inside);
  privacy.metric_evaluations[0].privacy_state = "after";
  privacy.privacy_requests = [{ contract_version: "0.4.0", tenant_id: "tenant-a", app_id: "app-a", privacy_request_id: "privacy-standard-retention",
    deletion_subject_digest: "7".repeat(64), deletion_scope: "installation", requested_via: "tenant_admin_api", requester_auth_ref: "synthetic-admin",
    requested_at: "2026-09-08T00:00:00.000Z", completed_at: "2026-09-08T00:01:00.000Z", status: "completed", reason_code: "privacy_deletion", policy_version: "privacy-v1",
    affected_records: [{ record_id: install.record_id, lifecycle_status: "redacted" }] }];
  cases.push({ name: "standard-privacy-current-cohort", input: privacy, expected: {}, undefinedReasons: expected(privacy, "empty_cohort") });
  for (const [source, basis, id, provider] of [[platform, "selected_verified_platform", "meta-66", undefined],
    [imported, "selected_imported_provider", "paid-67", "synthetic-export"]] as const) {
    if (!source) continue;
    const target = records(source).find(record => record.record_id === id);
    if (!target) throw new Error(`synthetic retention install missing: ${id}`);
    const input = prepare(source, target, true, basis, provider);
    input.metric_evaluations[0].grouping = { ...source.metric_evaluations[0].grouping };
    // One explicit paid platform/imported cohort, never a matching native campaign string.
    cases.push({ name: `standard-${basis}`, input, expected: expected(input, "1000000") });
    if (provider) {
      const wrong = structuredClone(input);
      for (const batch of wrong.batches) if (batch.records[0].event_name === "session_start") batch.records[0].producer = "import:synthetic-second";
      cases.push({ name: "standard-imported-wrong-producer", input: wrong, expected: expected(wrong, "0") });
    }
  }
  return cases;
}
