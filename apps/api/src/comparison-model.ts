import { createHash } from "node:crypto";
import { jcs } from "@openmasu/attribution-core/canonical";
import { comparisonMeaning, comparisonMaturity, type MetricComparisonContext } from "@openmasu/runtime/metric-comparison";
import type { GroupingDimension } from "./report-query-model.js";
import { externalWindowMaturity, type ExternalCalculation } from "./external-calculation-declaration.js";
import type { MetricFreshness } from "./metric-freshness.js";

export const fields = ["date_from", "date_to", "time_zone", "maturity", "aggregation", "attribution_scope", "metric_definition", "source_cutoff"] as const;
export type Conditions = Record<typeof fields[number], string>;
export type Row = { key: string; currency: string; scale: number } & ({ state: "present"; value: string } | { state: "undefined"; reason: string });
export type Provenance = { report_sha256: string; runs: { key: string; metric_run_id: string; input_snapshot_id: string }[] };
export type ContextRow = { key: string; context: MetricComparisonContext };
export type FreshnessRow = { key: string; observations: MetricFreshness };
export type MappingProvenance = { version: 1; format: "csv"; interpretation: "operator_declared"; input_sha256: string; mapping_sha256: string; row_count: number };
export type ComparisonAcquisition = {
  version: 1; state: "complete"; method: "postgres_repeatable_read";
  scope: { tenant_id: string; app_id: string };
  filters: { metric_definition_version: string | null; grouping: Partial<Record<GroupingDimension, string>> };
  row_count: number; selection_sha256: string; query_sha256: string; upstream_completeness: "unknown";
};
export type Snapshot = { source: string; conditions: Conditions; rows: Row[]; provenance?: Provenance; comparison_contexts?: ContextRow[]; freshness_observations?: FreshnessRow[]; acquisition?: ComparisonAcquisition; mapping_provenance?: MappingProvenance; external_calculation?: ExternalCalculation };
export const comparisonDigest = (value: unknown) => createHash("sha256").update(jcs(value)).digest("hex");
export function object(v: unknown): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("expected_object");
}
export function keys(v: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(v).length !== allowed.length || Object.keys(v).some(k => !allowed.includes(k))) throw Error("invalid_fields");
}
export function text(v: unknown): asserts v is string {
  if (typeof v !== "string" || !v.trim() || v.length > 256 || /[\u0000-\u001f]/.test(v)) throw Error("invalid_text");
}
export function date(v: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) throw Error("invalid_date");
}
/** Preserve contract microsecond precision while equating zero-fraction spellings. */
export function canonicalComparisonCutoff(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== match[1]) throw Error("invalid_cutoff");
  return `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z`;
}
export function scale(v: unknown): asserts v is number {
  if (!Number.isInteger(v) || Number(v) < 0 || Number(v) > 18) throw Error("invalid_scale");
}
export type Assurance = { acquisition: { state: "complete" | "not_recorded"; row_count: number; upstream_completeness: "unknown" }; conditions: Record<string, { state: "declared" | "external_declared" | "definition_backed" | "unknown"; value: string | null }>;
  meaning: "definition_backed" | "external_declared" | "unknown"; missing: string[]; execution: { definition_digest: string; rule_bundle_id: string; rule_bundle_version: string; rule_bundle_hash: string; fx_policy_version: string; fx_digest: string; metric_run_id: string; input_snapshot_id: string }[] };
export function snapshotAssurance(snapshot: Snapshot) {
  const contexts = snapshot.comparison_contexts ?? [];
  const conditions: Assurance["conditions"] = Object.fromEntries(fields.map(key => [key, { state: "declared", value: snapshot.conditions[key] }]));
  const missing: string[] = [];
  if (snapshot.external_calculation) {
    const d = snapshot.external_calculation.declaration;
    const elapsed = snapshot.rows.length > 0 && snapshot.rows.every(row =>
      externalWindowMaturity(d, JSON.parse(row.key).cohort_date, snapshot.conditions.source_cutoff) === "window_elapsed");
    for (const field of ["time_zone", "aggregation", "metric_definition"] as const) conditions[field].state = "external_declared";
    conditions.maturity = { state: elapsed ? "external_declared" : "unknown", value: elapsed ? "window_elapsed" : "unknown" };
    if (!elapsed) missing.push("window_maturity");
    const assurance: Assurance = { acquisition: { state: "not_recorded", row_count: snapshot.rows.length, upstream_completeness: "unknown" },
      conditions, meaning: elapsed ? "external_declared" : "unknown", missing, execution: [] };
    return { assurance, meaning: undefined };
  }
  if (!snapshot.rows.length || contexts.length !== snapshot.rows.length) missing.push("captured_definition_and_policy");
  const meanings = contexts.map(({ context }) => comparisonMeaning(context));
  if (meanings.some(value => !value)) missing.push("unsupported_implementation_profile");
  if (new Set(meanings.filter(Boolean).map(comparisonDigest)).size > 1) missing.push("mixed_definition_semantics");
  const maturities = contexts.map(({ key, context }) => {
    // Report-generated keys are closed grouping objects, not arbitrary user IDs.
    try { const grouping = JSON.parse(key); object(grouping);
      const dimensions = ["cohort_date", "metric_date", "campaign_id", "network", "country", "attribution_status", "apple_conversion_bucket"];
      const day = grouping.cohort_date ?? grouping.metric_date;
      if (Object.entries(grouping).some(([k, v]) => !dimensions.includes(k) || typeof v !== "string" || !v)
          || typeof day !== "string" || day < snapshot.conditions.date_from || day >= snapshot.conditions.date_to
          || (grouping.attribution_status ?? "all") !== snapshot.conditions.attribution_scope) return "unknown";
      return comparisonMaturity(context, grouping as Record<string, string>, snapshot.conditions.source_cutoff).state;
    } catch { return "unknown"; }
  });
  const maturity = new Set(maturities).size === 1 ? maturities[0] : "unknown";
  if (!maturity || maturity === "unknown") missing.push("window_maturity");
  const meaning = meanings[0];
  if (meaning && contexts.length === snapshot.rows.length && snapshot.rows.length) {
    conditions.metric_definition = { state: "definition_backed", value: snapshot.conditions.metric_definition };
    conditions.time_zone = { state: "definition_backed", value: meaning.time_zone };
    conditions.aggregation = { state: "definition_backed", value: meaning.aggregation };
  }
  conditions.maturity = { state: maturity && maturity !== "unknown" ? "definition_backed" : "unknown", value: maturity ?? null };
  const assurance: Assurance = { acquisition: { state: snapshot.acquisition ? "complete" : "not_recorded", row_count: snapshot.rows.length, upstream_completeness: "unknown" }, conditions, meaning: missing.length ? "unknown" : "definition_backed", missing: [...new Set(missing)].sort(),
    execution: contexts.map(({ context: c }) => ({ metric_run_id: c.metric_run_id, input_snapshot_id: c.input_snapshot_id,
      definition_digest: c.definition_digest, rule_bundle_id: c.definition.rule_bundle_id,
      rule_bundle_version: c.definition.rule_bundle_version, rule_bundle_hash: c.definition.rule_bundle_hash,
      fx_policy_version: c.fx.policy_version, fx_digest: c.fx_digest })) };
  return { assurance, meaning: missing.length ? undefined : meaning };
}
