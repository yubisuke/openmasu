import { createHash } from "node:crypto";
import { jcs } from "@openmasu/attribution-core";
import { validateMetricDefinition } from "@openmasu/contracts";
import { comparisonMeaning, comparisonMaturity, type MetricComparisonContext } from "@openmasu/runtime";
import { groupingDimensionAllowlist, type GroupingDimension } from "./report-query.js";

const fields = ["date_from", "date_to", "time_zone", "maturity", "aggregation", "attribution_scope", "metric_definition", "source_cutoff"] as const;
type Conditions = Record<typeof fields[number], string>;
type Row = { key: string; currency: string; scale: number } & ({ state: "present"; value: string } | { state: "undefined"; reason: string });
type Provenance = { report_sha256: string; runs: { key: string; metric_run_id: string; input_snapshot_id: string }[] };
type ContextRow = { key: string; context: MetricComparisonContext };
type MappingProvenance = { version: 1; format: "csv"; interpretation: "operator_declared"; input_sha256: string; mapping_sha256: string; row_count: number };
export type ComparisonAcquisition = {
  version: 1; state: "complete"; method: "postgres_repeatable_read";
  scope: { tenant_id: string; app_id: string };
  filters: { metric_definition_version: string | null; grouping: Partial<Record<GroupingDimension, string>> };
  row_count: number; selection_sha256: string; query_sha256: string; upstream_completeness: "unknown";
};
type Snapshot = { source: string; conditions: Conditions; rows: Row[]; provenance?: Provenance; comparison_contexts?: ContextRow[]; acquisition?: ComparisonAcquisition; mapping_provenance?: MappingProvenance };
export const comparisonDigest = (value: unknown) => createHash("sha256").update(jcs(value)).digest("hex");
function object(v: unknown): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("expected_object");
}
function keys(v: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(v).length !== allowed.length || Object.keys(v).some(k => !allowed.includes(k))) throw Error("invalid_fields");
}
function text(v: unknown): asserts v is string {
  if (typeof v !== "string" || !v.trim() || v.length > 256 || /[\u0000-\u001f]/.test(v)) throw Error("invalid_text");
}
function date(v: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) throw Error("invalid_date");
}
/** Preserve contract microsecond precision while equating zero-fraction spellings. */
export function canonicalComparisonCutoff(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== match[1]) throw Error("invalid_cutoff");
  return `${match[1]}.${(match[2] ?? "").padEnd(6, "0")}Z`;
}
function scale(v: unknown): asserts v is number {
  if (!Number.isInteger(v) || Number(v) < 0 || Number(v) > 18) throw Error("invalid_scale");
}
export function parseComparisonContext(value: unknown): MetricComparisonContext {
  object(value); keys(value, ["version", "profile", "metric_run_id", "input_snapshot_id", "definition", "definition_digest", "fx", "fx_digest", "privacy_state"]);
  if (value.version !== 1 || value.profile !== "openmasu-sql-metric-v1" || !["before", "after"].includes(String(value.privacy_state))) throw Error("invalid_context");
  text(value.metric_run_id);
  if (typeof value.input_snapshot_id !== "string" || !/^[a-f0-9]{64}$/.test(value.input_snapshot_id)
      || !validateMetricDefinition(value.definition) || comparisonDigest(value.definition) !== value.definition_digest) throw Error("invalid_definition_context");
  object(value.fx); keys(value.fx, ["policy_version", "target_currency", "target_scale", "rounding_mode", "rates"]);
  text(value.fx.policy_version); scale(value.fx.target_scale);
  if (!/^[A-Z]{3}$/.test(String(value.fx.target_currency)) || value.fx.rounding_mode !== "half_even"
      || !Array.isArray(value.fx.rates) || value.fx.rates.length !== 1) throw Error("invalid_fx_context");
  for (const rate of value.fx.rates) {
    object(rate); keys(rate, ["currency", "rate_unscaled", "rate_scale", "as_of"]); scale(rate.rate_scale);
    if (!/^[A-Z]{3}$/.test(String(rate.currency)) || typeof rate.rate_unscaled !== "string"
        || !/^(?:0|[1-9]\d{0,99})$/.test(rate.rate_unscaled) || typeof rate.as_of !== "string"
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(rate.as_of)
        || !Number.isFinite(Date.parse(rate.as_of)) || new Date(rate.as_of).toISOString().slice(0, 19) !== rate.as_of.slice(0, 19)) throw Error("invalid_fx_context");
  }
  if (comparisonDigest(value.fx) !== value.fx_digest) throw Error("invalid_fx_digest");
  return structuredClone(value) as MetricComparisonContext;
}
export function parseSnapshot(input: unknown): Snapshot {
  object(input); keys(input, ["source", "conditions", "rows", ...("provenance" in input ? ["provenance"] : []), ...("comparison_contexts" in input ? ["comparison_contexts"] : []), ...("acquisition" in input ? ["acquisition"] : []), ...("mapping_provenance" in input ? ["mapping_provenance"] : [])]); text(input.source);
  object(input.conditions); keys(input.conditions, fields);
  for (const key of fields) text(input.conditions[key]);
  const c = { ...input.conditions } as Conditions;
  date(c.date_from); date(c.date_to);
  if (c.date_from >= c.date_to) throw Error("invalid_range");
  new Intl.DateTimeFormat("en", { timeZone: c.time_zone });
  if (!["cumulative", "on_day"].includes(c.aggregation)) throw Error("invalid_aggregation");
  c.source_cutoff = canonicalComparisonCutoff(c.source_cutoff);
  if (!Array.isArray(input.rows) || input.rows.length > 10000) throw Error("invalid_rows");
  const seen = new Set<string>();
  for (const r of input.rows) {
    object(r); keys(r, ["key", "currency", "scale", "state", r.state === "present" ? "value" : "reason"]);
    text(r.key); text(r.currency);
    if (!/^(?:[A-Z]{3}|none)$/.test(r.currency)) throw Error("invalid_currency");
    if (seen.has(r.key)) throw Error("duplicate_key"); seen.add(r.key);
    if (!Number.isInteger(r.scale) || Number(r.scale) < 0 || Number(r.scale) > 18) throw Error("invalid_scale");
    if (r.state === "present") {
      if (typeof r.value !== "string" || !/^(?:0|-?[1-9]\d{0,99})$/.test(r.value)) throw Error("invalid_integer");
    } else if (r.state === "undefined") text(r.reason);
    else throw Error("invalid_state");
  }
  let provenance: Provenance | undefined;
  if ("provenance" in input) {
    const p = input.provenance; object(p); keys(p, ["report_sha256", "runs"]);
    if (typeof p.report_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.report_sha256) || !Array.isArray(p.runs) || p.runs.length !== input.rows.length) throw Error("invalid_provenance");
    const refs = new Set<string>(), ids = new Set<string>();
    for (const r of p.runs) {
      object(r); keys(r, ["key", "metric_run_id", "input_snapshot_id"]);
      text(r.key); text(r.metric_run_id);
      if (!seen.has(r.key) || refs.has(r.key) || ids.has(r.metric_run_id) || typeof r.input_snapshot_id !== "string" || !/^[a-f0-9]{64}$/.test(r.input_snapshot_id)) throw Error("invalid_provenance");
      refs.add(r.key); ids.add(r.metric_run_id);
    }
    provenance = { report_sha256: p.report_sha256, runs: [...p.runs].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0) } as Provenance;
  }
  let contexts: ContextRow[] | undefined;
  if ("comparison_contexts" in input) {
    if (!provenance || !Array.isArray(input.comparison_contexts) || input.comparison_contexts.length > input.rows.length) throw Error("invalid_context_rows");
    const refs = new Map(provenance.runs.map(r => [r.key, r])), used = new Set<string>();
    contexts = input.comparison_contexts.map(item => {
      object(item); keys(item, ["key", "context"]); text(item.key);
      const context = parseComparisonContext(item.context), ref = refs.get(item.key);
      if (!ref || used.has(item.key) || context.metric_run_id !== ref.metric_run_id || context.input_snapshot_id !== ref.input_snapshot_id) throw Error("context_binding_mismatch");
      used.add(item.key);
      const d = context.definition, row = (input.rows as Row[]).find(r => r.key === item.key)!;
      if (`${d.metric_name}@${d.metric_definition_version}` !== c.metric_definition || d.aggregation_time_zone !== c.time_zone
          || row.currency !== (d.value_type === "money" ? d.currency : "none")
          || row.scale !== (d.value_type === "money" ? d.amount_scale : d.value_type === "ratio" ? d.ratio_scale : 0)) throw Error("context_units_or_definition_mismatch");
      return { key: item.key, context };
    }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }
  let acquisition: ComparisonAcquisition | undefined;
  if ("acquisition" in input) {
    const a = input.acquisition; object(a);
    keys(a, ["version", "state", "method", "scope", "filters", "row_count", "selection_sha256", "query_sha256", "upstream_completeness"]);
    if (!provenance || a.version !== 1 || a.state !== "complete" || a.method !== "postgres_repeatable_read"
        || a.upstream_completeness !== "unknown" || a.row_count !== input.rows.length) throw Error("invalid_acquisition");
    object(a.scope); keys(a.scope, ["tenant_id", "app_id"]);
    for (const v of Object.values(a.scope)) if (typeof v !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(v)) throw Error("invalid_acquisition_scope");
    object(a.filters); keys(a.filters, ["metric_definition_version", "grouping"]); object(a.filters.grouping);
    if (a.filters.metric_definition_version !== null) {
      text(a.filters.metric_definition_version);
      if (a.filters.metric_definition_version.length > 64) throw Error("invalid_acquisition_filter");
    }
    for (const [k, v] of Object.entries(a.filters.grouping)) {
      if (!Object.hasOwn(groupingDimensionAllowlist, k) || typeof v !== "string" || !v || v.length > 128) throw Error("invalid_acquisition_filter");
      for (const row of input.rows as Row[]) {
        let group: unknown; try { group = JSON.parse(row.key); } catch { throw Error("invalid_acquisition_grouping"); }
        object(group); if (group[k] !== v) throw Error("acquisition_grouping_mismatch");
      }
    }
    if (a.selection_sha256 !== comparisonDigest(provenance.runs)
        || a.query_sha256 !== comparisonDigest({ scope: a.scope, filters: a.filters, conditions: c })) throw Error("acquisition_digest_mismatch");
    acquisition = structuredClone(a) as ComparisonAcquisition;
  }
  let mappingProvenance: MappingProvenance | undefined;
  if ("mapping_provenance" in input) {
    const p = input.mapping_provenance; object(p);
    keys(p, ["version", "format", "interpretation", "input_sha256", "mapping_sha256", "row_count"]);
    if (p.version !== 1 || p.format !== "csv" || p.interpretation !== "operator_declared" || p.row_count !== input.rows.length
        || typeof p.input_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.input_sha256)
        || typeof p.mapping_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(p.mapping_sha256)
        || provenance || contexts || acquisition) throw Error("invalid_mapping_provenance");
    mappingProvenance = structuredClone(p) as MappingProvenance;
  }
  return { source: input.source, conditions: { ...c }, rows: [...input.rows].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0), ...(provenance ? { provenance } : {}), ...(contexts ? { comparison_contexts: contexts } : {}), ...(acquisition ? { acquisition } : {}), ...(mappingProvenance ? { mapping_provenance: mappingProvenance } : {}) } as Snapshot;
}
type Assurance = { acquisition: { state: "complete" | "not_recorded"; row_count: number; upstream_completeness: "unknown" }; conditions: Record<string, { state: "declared" | "definition_backed" | "unknown"; value: string | null }>;
  meaning: "definition_backed" | "unknown"; missing: string[]; execution: { definition_digest: string; rule_bundle_id: string; rule_bundle_version: string; rule_bundle_hash: string; fx_policy_version: string; fx_digest: string; metric_run_id: string; input_snapshot_id: string }[] };
export function snapshotAssurance(snapshot: Snapshot) {
  const contexts = snapshot.comparison_contexts ?? [];
  const conditions: Assurance["conditions"] = Object.fromEntries(fields.map(key => [key, { state: "declared", value: snapshot.conditions[key] }]));
  const missing: string[] = [];
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
type ComparisonRow = { key: string; status: string; left: Row | null; right: Row | null; currency?: string; scale?: number; delta_right_minus_left?: string };
export type ComparisonResult = { format: "cohort-comparison-v2"; provenance: { left: { source: string; sha256: string }; right: { source: string; sha256: string } };
  status: "compared" | "declared_comparison" | "incomparable"; conditions: Conditions; mismatches: string[];
  assurance: { left: Assurance; right: Assurance }; rows: ComparisonRow[] };
export function compareSnapshots(left: unknown, right: unknown, options: { declaredOnly?: boolean } = {}): ComparisonResult {
  const a = parseSnapshot(left), b = parseSnapshot(right);
  const la = snapshotAssurance(a), ra = snapshotAssurance(b);
  const declared = options.declaredOnly === true && !a.comparison_contexts?.length && !b.comparison_contexts?.length;
  const comparedFields = declared ? fields : fields.filter(key => key !== "metric_definition");
  const mismatches: string[] = comparedFields.filter(k => (declared ? a.conditions[k] : la.assurance.conditions[k].value) !== (declared ? b.conditions[k] : ra.assurance.conditions[k].value));
  if (!declared && la.meaning && ra.meaning) {
    for (const key of Object.keys(la.meaning) as (keyof typeof la.meaning)[]) {
      if (jcs(la.meaning[key]) !== jcs(ra.meaning[key])) mismatches.push(`meaning.${key}`);
    }
  }
  const result: ComparisonResult = { format: "cohort-comparison-v2", provenance: { left: { source: a.source, sha256: comparisonDigest(a) }, right: { source: b.source, sha256: comparisonDigest(b) } },
    conditions: a.conditions, status: "incomparable", mismatches: [...new Set(mismatches)].sort(), assurance: { left: la.assurance, right: ra.assurance }, rows: [] };
  if (mismatches.length || (!declared && (!la.meaning || !ra.meaning))) return result;
  const am = new Map(a.rows.map(r => [r.key, r])), bm = new Map(b.rows.map(r => [r.key, r]));
  const rows = [...new Set([...am.keys(), ...bm.keys()])].sort().map(key => {
    const l = am.get(key), r = bm.get(key);
    if (!l || !r) return { key, status: !l ? "missing_left" : "missing_right", left: l ?? null, right: r ?? null };
    if (l.currency !== r.currency) return { key, status: "currency_mismatch", left: l, right: r };
    if (l.state !== "present" || r.state !== "present") return { key, status: "undefined", left: l, right: r };
    const scale = Math.max(l.scale, r.scale);
    const delta = BigInt(r.value) * 10n ** BigInt(scale - r.scale) - BigInt(l.value) * 10n ** BigInt(scale - l.scale);
    return { key, status: delta === 0n ? "equal" : "different", currency: l.currency, scale, delta_right_minus_left: delta.toString(), left: l, right: r };
  });
  return { ...result, status: declared ? "declared_comparison" : "compared", rows };
}
