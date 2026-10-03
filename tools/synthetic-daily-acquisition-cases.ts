import { evaluate } from "@openmasu/attribution-core";
import { readFileSync } from "node:fs";
import { attempts, attemptDecisionKey, createFixtureCandidateProvider, sortCandidateAttempts } from "../packages/attribution-core/src/candidates.js";
import { decide, privacyIndex } from "../packages/attribution-core/src/ingestion-decisions.js";
import { metricRuns } from "../packages/attribution-core/src/metric-runs.js";

type Any = Record<string, any>;
export type DailyAcquisitionCase = { name: string; input: Any; expected: string[]; revisions?: Any[] };
const normal = ["1", "1", "1", "0", "0", "3", "2", "1", "0"];
const organicRevision = ["0", "2", "1", "0", "0", "3", "3", "0", "0"];

/** Shared synthetic evidence and hand-counted populations, never shared calculations. */
export function syntheticDailyAcquisitionCases(baseline: Any): DailyAcquisitionCase[] {
  const cases: DailyAcquisitionCase[] = [];
  const add = (name: string, expected: string[], change: (value: Any) => void = () => {}) => {
    const input = structuredClone(baseline); change(input); cases.push({ name, input, expected });
  };
  add("selected-daily-and-cohort-share-paid-campaign-without-rewriting-raw", normal);
  add("occurrence-day-is-not-receipt-day", ["0", "0", "0", "0", "0", "0", "0", "1", "0"], value => {
    for (const row of value.metric_evaluations.slice(0, 7)) row.grouping.metric_date = "2026-08-12";
  });
  add("explicit-cohort-date-is-an-intersection-not-an-override", ["0", ...normal.slice(1)], value => {
    value.metric_evaluations[0].grouping.cohort_date = "2026-08-07";
  });
  add("receipt-watermark-excludes-backfilled-records", Array(9).fill("0"), value => {
    for (const row of value.metric_evaluations) row.input_received_at_watermark = "2026-08-11T00:00:00.000Z";
  });
  add("late-click-cannot-supply-an-earlier-selected-campaign", ["0", "1", "2", "0", "0", "3", "3", "0", "0"], value => {
    const click = value.records.shift();
    const late = "2026-08-13T00:00:00.000Z";
    value.batches = [{ batch_id: "daily-65-installs", server_context: value.server_context, records: value.records },
      { batch_id: "daily-65-late-click", server_context: { ...value.server_context, received_at: late }, records: [{ ...click, received_at: late }] }];
    delete value.records;
  });
  const privacy = (record_id: string) => ({ contract_version: "0.4.0", tenant_id: "tenant-a", app_id: "app-a",
    privacy_request_id: "privacy-daily-65", deletion_subject_digest: "6".repeat(64), deletion_scope: "installation",
    requested_via: "tenant_admin_api", requester_auth_ref: "admin:synthetic-daily",
    requested_at: "2026-08-12T00:00:00.000Z", completed_at: "2026-08-12T00:01:00.000Z", status: "completed",
    reason_code: "privacy_deletion", policy_version: "privacy-v0.4", affected_records: [{ record_id, lifecycle_status: "redacted" }] });
  add("privacy-removed-click-is-unknown-not-a-retained-campaign", ["0", "1", "1", "1", "0", "3", "3", "0", "0"], value => {
    value.privacy_requests = [privacy("click-1")];
  });
  add("privacy-removed-install-leaves-the-daily-population", ["0", "1", "1", "0", "0", "2", "2", "0", "0"], value => {
    value.privacy_requests = [privacy("install-1")];
  });
  add("duplicate-deliveries-do-not-add-installs", normal, value => {
    value.records.push(...value.records.map((record: Any) => ({ ...structuredClone(record), record_id: `${record.record_id}-retry`, delivery_id: `${record.delivery_id}-retry` })));
  });
  add("imported-organic-is-not-native-daily-acquisition", ["1", "0", "1", "0", "0", "2", "1", "1", "0"], value => {
    value.records[2].producer = "import:synthetic-provider";
    value.records[2].payload.import_context = { provider: "synthetic-provider", provider_attributed: false, provider_attribution_strategy: "organic" };
  });
  add("Apple-aggregate-postbacks-do-not-add-native-installs", normal, value => {
    const apple = JSON.parse(readFileSync("fixtures/v0.4/44-apple-aggregate-metrics/input.json", "utf8"));
    value.records.push(...apple.records.map((record: Any) => ({ ...record, received_at: "2026-08-12T00:00:00.000Z" })));
  });
  for (const fraud_policy of ["gross", "net"]) add(`daily-${fraud_policy}-population`, fraud_policy === "net"
    ? ["0", "1", "1", "0", "0", "2", "2", "0", "0"] : ["0", "1", "2", "0", "0", "3", "3", "0", "0"], value => {
    value.server_context.fraud_actions_enabled = true;
    value.records[0].payload.bot_prefetch = true;
    value.metric_definitions[0].fraud_policy = fraud_policy;
  });
  // Explicit saved revisions exercise the calculator boundary, not a new wire input.
  const paid = evaluate(baseline).attributions.find(row => row.subject_ref === "installation:install-1")!;
  const organic = { ...structuredClone(paid), attribution_id: "revision-65", status: "organic", method: "none", model: "none",
    reason_code: "no_referrer", evidence_refs: paid.evidence_refs.filter(row => row.ref === "install-1") };
  cases.push({ name: "eligible-supersession-replaces-campaign", input: structuredClone(baseline), expected: organicRevision,
    revisions: [{ ...organic, supersedes_attribution_id: paid.attribution_id }] });
  cases.push({ name: "same-time-revisions-use-highest-identifier", input: structuredClone(baseline), expected: organicRevision,
    revisions: [{ ...structuredClone(paid), attribution_id: "revision-65-a" }, { ...organic, attribution_id: "revision-65-z" }] });
  for (const field of ["decided_at", "input_cutoff_at"]) cases.push({ name: `future-${field}-revision-cannot-supersede`,
    input: structuredClone(baseline), expected: normal,
    revisions: [{ ...organic, [field]: "2026-08-13T00:00:00.000Z", supersedes_attribution_id: paid.attribution_id }] });
  return cases;
}

/** Inject saved revision evidence only at the existing pure calculator boundary. */
export function dailyAcquisitionCaseRuns(entry: DailyAcquisitionCase) {
  const output = evaluate(entry.input);
  if (!entry.revisions) return output.metric_runs;
  const all = sortCandidateAttempts(attempts(entry.input)), candidates = createFixtureCandidateProvider(all);
  const decisions = new Map(all.map(attempt => [attemptDecisionKey(attempt), decide(attempt, candidates)]));
  return metricRuns(entry.input, all, decisions, privacyIndex(entry.input), [...output.attributions, ...entry.revisions] as typeof output.attributions);
}

export const dailyAcquisitionPythonProbe = `
import json, runpy, sys
n = runpy.run_path('tools/python_evaluator.py')
result = []
for entry in json.load(sys.stdin):
    value = entry['input']
    output = n['evaluate'](value)
    if entry.get('revisions'):
        attempts = n['flatten_attempts'](value)
        decisions = {n['attempt_decision_key'](item): n['decide'](item, attempts) for item in attempts}
        runs = n['metric_runs'](value, attempts, decisions, n['lifecycle_index'](value), output['attributions'] + entry['revisions'])
    else:
        runs = output['metric_runs']
    result.append(runs)
json.dump(result, sys.stdout)
`;
