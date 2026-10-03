import { evaluate } from "@openmasu/attribution-core";
import { dailyAcquisitionCaseRuns, dailyAcquisitionPythonProbe, type DailyAcquisitionCase } from "./synthetic-daily-acquisition-cases.js";

type Any = Record<string, any>;
// Run-ID order, derived from three imported installations and USD 2/3/1 revenue.
export const importedAcquisitionValues = ["1","2000000","500000","1","3000000","no_attributed_cost",
  "1","1000000","3","1000000","0","empty_cohort","no_attributed_cost","0","1","5000000"];
const withoutPaid = ["0","empty_cohort","0",...importedAcquisitionValues.slice(3,8),"2",
  "empty_cohort","empty_cohort",...importedAcquisitionValues.slice(11)];
const organicRevision = ["0","empty_cohort","0","2","2500000","no_attributed_cost",
  ...importedAcquisitionValues.slice(6,9),"empty_cohort","empty_cohort",...importedAcquisitionValues.slice(11)];

/** Synthetic evidence and manual scalar expectations; no shared calculator. */
export function syntheticImportedAcquisitionCases(source: Any): DailyAcquisitionCase[] {
  const build = (name: string, change: (input: Any) => void = () => {}, expected = importedAcquisitionValues) => {
    const input = structuredClone(source); change(input); return { name, input, expected: [...expected] };
  };
  const paid = evaluate(source).attributions.find(row => row.subject_ref === "installation:paid-67")!;
  const revision = { ...structuredClone(paid), attribution_id:"revision-import67-z",status:"organic",
    reason_code:"provider_organic",supersedes_attribution_id:paid.attribution_id };
  const corrected: DailyAcquisitionCase = { ...build("eligible imported supersession replaces paid membership"),
    revisions:[revision],expected:organicRevision };
  return [
    build("keeps paid organic unknown provider and native cohorts separate"),
    build("uses canonical import context rather than a legacy install country", input => {
      input.records.find((row: Any) => row.record_id === "paid-67").payload.country = "CA";
    }),
    build("fails closed when canonical import context is absent", input => {
      delete input.records.find((row: Any) => row.record_id === "paid-67").payload.import_context;
    },withoutPaid),
    build("isolates another explicitly selected provider without inferring a shared subject", input => {
      for (const definition of input.metric_definitions) if (definition.import_provider) definition.import_provider = "synthetic-second";
      input.metric_evaluations = input.metric_evaluations.slice(0,1);
    },["1","9000000","2250000"]),
    build("ignores SDK outcomes even when they claim an imported installation", input => {
      input.records.find((row: Any) => row.record_id === "revenue-sdk-67").payload.amount_unscaled = "99000000";
    }),
    build("does not count conflicting corrections as a second accepted event", input => {
      const row = structuredClone(input.records.find((record: Any) => record.record_id === "revenue-paid-67"));
      row.record_id = "revenue-paid-conflict-67"; row.delivery_id = "delivery:revenue-paid-conflict-67";
      row.payload.amount_unscaled = "9000000"; input.records.push(row);
    }),
    build("is stable under record definition cost and evaluation permutations", input => {
      for (const field of ["records","metric_definitions","cost_records","metric_evaluations"]) input[field].reverse();
    }),
    corrected,
    ...["paid-67","revenue-paid-67"].map(record_id => build(`privacy removes ${record_id} without borrowing another producer`, input => {
      input.privacy_requests = [{contract_version:"0.4.0",tenant_id:"tenant-a",app_id:"app-a",
        privacy_request_id:"privacy-import67",deletion_subject_digest:"7".repeat(64),deletion_scope:"installation",
        requested_via:"tenant_admin_api",requester_auth_ref:"admin:synthetic-import67",
        requested_at:"2026-08-14T12:00:00.000Z",completed_at:"2026-08-14T12:01:00.000Z",status:"completed",
        reason_code:"privacy_deletion",policy_version:"privacy-v0.4",affected_records:[{record_id,lifecycle_status:"redacted"}]}];
    }, record_id === "paid-67" ? withoutPaid : ["1","0","0",...importedAcquisitionValues.slice(3)])),
    { ...build("equal-time imported revisions use highest attribution identifier"),revisions:[
      {...structuredClone(paid),attribution_id:"revision-import67-a"},
      {...revision,supersedes_attribution_id:undefined}],expected:organicRevision },
    ...["decided_at","input_cutoff_at"].map(field => ({ ...build(`future imported ${field} cannot replace membership`),
      revisions:[{...revision,[field]:"2026-08-16T00:00:00.000Z"}] })),
    { ...build("net excludes selected imported fraud while gross arithmetic remains unchanged", input => {
      for (const definition of input.metric_definitions) if (definition.import_provider) definition.fraud_policy = "net";
    },withoutPaid),revisions:[{...paid,attribution_id:"revision-import67-excluded",reason_code:"fraud_excluded",
      supersedes_attribution_id:paid.attribution_id}] },
  ];
}

export const importedAcquisitionCaseRuns = dailyAcquisitionCaseRuns;
export const importedAcquisitionPythonProbe = dailyAcquisitionPythonProbe;
