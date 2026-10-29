import { jcs } from "@openmasu/attribution-core/canonical";
import { assertSnapshotPeriod, boundedComparisonSnapshot, parseComparisonRegistration, recurringComparisonResult,
  recurringComparisonLimits, type SavedComparison } from "@openmasu/runtime/recurring-comparisons";
import type { prepareComparisonRegistration } from "@openmasu/runtime/recurring-comparisons";
import { comparisonDigest, snapshotAssurance, type Snapshot } from "@openmasu/runtime/comparison-model";

type Scope = { tenantId: string; appId: string };
type Plan = SavedComparison & { privacy_state: string };
export type ComparisonFormPreview = {
  command: Record<string, unknown>; digest: string; action: string; name: string;
  resultState: string; snapshots: { side: string; snapshot: Snapshot; meaning: string; maturity: string; source?: string }[];
};
const scalar = (form: FormData, name: string) => {
  const value = form.get(name);
  if (typeof value !== "string" || form.getAll(name).length !== 1) throw Error("comparison_input_invalid");
  return value;
};
const exactFields = (form: FormData, fields: string[]) => {
  const allowed = ["csrf_token", ...fields];
  if ([...form.keys()].some(key => !allowed.includes(key) || form.getAll(key).length !== 1)
      || allowed.some(key => !form.has(key))) throw Error("comparison_input_invalid");
};
const integer = (form: FormData, key: string) => {
  const value = scalar(form, key);
  if (!/^(0|[1-9]\d{0,5})$/.test(value)) throw Error("comparison_settings_invalid");
  return Number(value);
};
function scoped(value: unknown, scope: Scope): Snapshot {
  const snapshot = boundedComparisonSnapshot(value);
  if (snapshot.acquisition && (snapshot.acquisition.scope.tenant_id !== scope.tenantId || snapshot.acquisition.scope.app_id !== scope.appId)) {
    throw Error("comparison_scope_mismatch");
  }
  return snapshot;
}
async function upload(form: FormData, key: string, scope: Scope): Promise<Snapshot> {
  const file = form.get(key);
  if (!file || typeof file === "string" || file.size === 0) throw Error("comparison_file_required");
  if (file.size > recurringComparisonLimits.bytes) throw Error("comparison_snapshot_limit");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer())); }
  catch { throw Error("comparison_invalid_json"); }
  return scoped(value, scope);
}
function observed(side: string, snapshot: Snapshot) {
  const { assurance } = snapshotAssurance(snapshot);
  return { side, snapshot, meaning: assurance.meaning, maturity: assurance.conditions.maturity.value ?? "unknown" };
}
/** No storage or provider calls: typed fields use the same validators as the JSON API. */
export async function previewComparisonForm(form: FormData, scope: Scope, plans: Plan[],
    prepareLocal?: (input: unknown) => ReturnType<typeof prepareComparisonRegistration>): Promise<ComparisonFormPreview> {
  const action = scalar(form, "action");
  if (action === "register" || action === "register_local") {
    const local = action === "register_local";
    const policyFields = ["threshold_kind", "threshold_baseline", "minimum_population"];
    const policy = policyFields.some(field => form.has(field));
    exactFields(form, ["action", "name", "first_date", "last_date", "watermark_lag_days", "retention_days", "mode",
      "threshold_value_unscaled", "threshold_scale", "supersedes_id", "right_snapshot",
      ...(policy ? policyFields : []),
      ...(local ? ["metric_schedule_id", "metric_name"] : ["left_snapshot"])]);
    const registration: Record<string, unknown> = { name: scalar(form, "name"), first_date: scalar(form, "first_date"), last_date: scalar(form, "last_date"),
      watermark_lag_days: integer(form, "watermark_lag_days"), retention_days: integer(form, "retention_days"), mode: scalar(form, "mode"),
      threshold: { value_unscaled: scalar(form, "threshold_value_unscaled"), scale: integer(form, "threshold_scale"),
        ...(policy ? { kind: scalar(form, "threshold_kind"), baseline: scalar(form, "threshold_baseline"),
          ...(scalar(form, "minimum_population") ? { minimum_population: scalar(form, "minimum_population") } : {}) } : {}) },
      supersedes_id: scalar(form, "supersedes_id") || null,
      ...(local ? { local_selection: { metric_schedule_id: scalar(form, "metric_schedule_id"), metric_name: scalar(form, "metric_name") } }
        : { left_snapshot: await upload(form, "left_snapshot", scope) }), right_snapshot: await upload(form, "right_snapshot", scope) };
    if (local && !prepareLocal) throw Error("comparison_local_capture_required");
    const parsed = local ? (await prepareLocal!(registration)).parsed : parseComparisonRegistration(registration);
    if (local) registration.expected_left_snapshot_digest = comparisonDigest(parsed.left);
    if (parsed.supersedes_id && !plans.some(plan => plan.comparison_id === parsed.supersedes_id && plan.active && plan.privacy_state === "current")) {
      throw Error("comparison_revision_not_active");
    }
    const command = { action: "register", registration };
    return { command, digest: comparisonDigest(command), action: "register", name: parsed.name,
      resultState: recurringComparisonResult(parsed.definition, parsed.definition.first_date, parsed.left, parsed.right).state,
      snapshots: [{ ...observed("left", parsed.left), source: local ? "server_saved_runs" : "operator_uploaded" },
        { ...observed("right", parsed.right), source: "operator_uploaded" }] };
  }
  if (action !== "deposit" && action !== "delete") throw Error("comparison_action_invalid");
  exactFields(form, action === "deposit" ? ["action", "comparison_id", "target_date", "side", "snapshot"] : ["action", "comparison_id"]);
  const id = scalar(form, "comparison_id"), plan = plans.find(row => row.comparison_id === id);
  if (!plan || (action === "deposit" && (!plan.active || plan.privacy_state !== "current"))) throw Error("comparison_not_available");
  if (action === "delete") {
    const command = { action, comparison_id: id };
    return { command, digest: comparisonDigest(command), action, name: plan.name, resultState: "delete_stored_inputs_and_results", snapshots: [] };
  }
  const day = scalar(form, "target_date"), side = scalar(form, "side");
  if (side !== "left" && side !== "right") throw Error("comparison_side_invalid");
  if (side === "left" && plan.definition.local_selection) throw Error("comparison_local_deposit_forbidden");
  const snapshot = await upload(form, "snapshot", scope);
  assertSnapshotPeriod(plan.definition, day, snapshot);
  const command = { action, comparison_id: id, target_date: day, side, snapshot };
  // The other operand is deliberately not inferred or silently selected from history.
  return { command, digest: comparisonDigest(command), action, name: plan.name, resultState: "deposit_pending_worker_comparison",
    snapshots: [observed(side, snapshot)] };
}
export function confirmedComparisonForm(form: FormData): Record<string, unknown> {
  exactFields(form, ["command", "confirmation_digest"]);
  let command: unknown;
  try { command = JSON.parse(scalar(form, "command")); } catch { throw Error("comparison_input_invalid"); }
  if (!command || typeof command !== "object" || Array.isArray(command)
      || comparisonDigest(command) !== scalar(form, "confirmation_digest")) throw Error("comparison_confirmation_mismatch");
  if (Buffer.byteLength(jcs(command), "utf8") > recurringComparisonLimits.bytes * 2 + 16384) throw Error("comparison_snapshot_limit");
  return command as Record<string, unknown>;
}
