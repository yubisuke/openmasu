import { jcs } from "@openmasu/attribution-core/canonical";
import { validateMetricDefinition } from "@openmasu/contracts/validation";
import { comparisonMeaning, comparisonMaturity, type MetricComparisonContext } from "@openmasu/runtime/metric-comparison";
import { groupingDimensionAllowlist, validateGrouping, type GroupingDimension } from "./report-query-model.js";
import { parseExternalDeclaration, externalDeclarationMeaning, capturedRoasMeaning, externalWindowMaturity, type ExternalCalculation } from "./external-calculation-declaration.js";
import { parseMetricFreshness } from "./metric-freshness.js";

import { comparisonDigest, canonicalComparisonCutoff, snapshotAssurance, fields, object, keys, text, date, scale,
  type Conditions, type Row, type Provenance, type ContextRow, type FreshnessRow, type MappingProvenance, type ComparisonAcquisition, type Snapshot, type Assurance } from "./comparison-model.js";
export { comparisonDigest, canonicalComparisonCutoff, snapshotAssurance } from "./comparison-model.js";
export type { ComparisonAcquisition } from "./comparison-model.js";

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
  object(input); keys(input, ["source", "conditions", "rows", ...("provenance" in input ? ["provenance"] : []), ...("comparison_contexts" in input ? ["comparison_contexts"] : []), ...("freshness_observations" in input ? ["freshness_observations"] : []), ...("acquisition" in input ? ["acquisition"] : []), ...("mapping_provenance" in input ? ["mapping_provenance"] : []), ...("external_calculation" in input ? ["external_calculation"] : [])]); text(input.source);
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
  let freshness: FreshnessRow[] | undefined;
  if ("freshness_observations" in input) {
    if (!provenance || !Array.isArray(input.freshness_observations) || input.freshness_observations.length > input.rows.length) throw Error("invalid_freshness_rows");
    const used = new Set<string>();
    freshness = input.freshness_observations.map(item => {
      object(item); keys(item, ["key", "observations"]); text(item.key);
      if (!seen.has(item.key) || used.has(item.key)) throw Error("freshness_binding_mismatch");
      used.add(item.key);
      return { key: item.key, observations: parseMetricFreshness(item.observations) };
    }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }
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
  let external: ExternalCalculation | undefined;
  if ("external_calculation" in input) {
    const e = input.external_calculation; object(e); keys(e, ["declaration", "declaration_sha256"]);
    const declaration = parseExternalDeclaration(e.declaration);
    if (provenance || contexts || acquisition) throw Error("external_cannot_claim_captured_execution");
    if (comparisonDigest(declaration) !== e.declaration_sha256) throw Error("external_declaration_digest_mismatch");
    if (declaration.time_zone !== c.time_zone || declaration.aggregation !== c.aggregation) throw Error("external_conditions_mismatch");
    for (const row of input.rows as Row[]) {
      if (row.currency !== "none" || row.scale !== declaration.ratio_scale) throw Error("external_units_mismatch");
      let group: unknown; try { group = JSON.parse(row.key); } catch { throw Error("external_grouping_invalid"); }
      object(group);
      if (jcs(group) !== row.key || typeof group.cohort_date !== "string"
          || group.cohort_date < c.date_from || group.cohort_date >= c.date_to
          || (group.attribution_status ?? "all") !== c.attribution_scope) throw Error("external_grouping_mismatch");
      for (const [key, value] of Object.entries(group)) {
        if (!declaration.grouping_dimensions.includes(key as GroupingDimension) || typeof value !== "string") throw Error("external_grouping_mismatch");
        validateGrouping(key as GroupingDimension, value);
      }
    }
    external = { declaration, declaration_sha256: e.declaration_sha256 as string };
  }
  return { source: input.source, conditions: { ...c }, rows: [...input.rows].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0), ...(provenance ? { provenance } : {}), ...(contexts ? { comparison_contexts: contexts } : {}), ...(freshness ? { freshness_observations: freshness } : {}), ...(acquisition ? { acquisition } : {}), ...(mappingProvenance ? { mapping_provenance: mappingProvenance } : {}), ...(external ? { external_calculation: external } : {}) } as Snapshot;
}
type ComparisonRow = { key: string; status: string; left: Row | null; right: Row | null; currency?: string; scale?: number; delta_right_minus_left?: string };
type ResultProvenance = { source: string; sha256: string; saved_report?: Provenance; freshness_observations?: FreshnessRow[]; mapping_provenance?: MappingProvenance; external_calculation?: ExternalCalculation };
export type ComparisonResult = { format: "cohort-comparison-v2"; provenance: { left: ResultProvenance; right: ResultProvenance };
  status: "compared" | "declared_comparison" | "external_declared_comparison" | "incomparable"; conditions: Conditions; mismatches: string[];
  assurance: { left: Assurance; right: Assurance }; rows: ComparisonRow[] };
export function compareSnapshots(left: unknown, right: unknown, options: { declaredOnly?: boolean; allowExternalDeclaration?: boolean } = {}): ComparisonResult {
  if (options.declaredOnly && options.allowExternalDeclaration) throw Error("conflicting_comparison_modes");
  const a = parseSnapshot(left), b = parseSnapshot(right);
  const la = snapshotAssurance(a), ra = snapshotAssurance(b);
  const external = Boolean(a.external_calculation || b.external_calculation);
  const declared = options.declaredOnly === true && !external && !a.comparison_contexts?.length && !b.comparison_contexts?.length;
  const comparedFields = declared ? fields : fields.filter(key => key !== "metric_definition");
  const mismatches: string[] = comparedFields.filter(k => (declared ? a.conditions[k] : la.assurance.conditions[k].value) !== (declared ? b.conditions[k] : ra.assurance.conditions[k].value));
  let externalComparable = false;
  if (external) {
    if (!options.allowExternalDeclaration) mismatches.push("external_declaration_opt_in_required");
    if (Boolean(a.external_calculation) === Boolean(b.external_calculation)) mismatches.push("requires_one_captured_and_one_external_input");
    else {
      const captured = a.external_calculation ? b : a, declaration = (a.external_calculation ?? b.external_calculation)!.declaration;
      const capturedAssurance = a.external_calculation ? ra : la, externalAssurance = a.external_calculation ? la : ra;
      const meaning = capturedAssurance.assurance.meaning === "definition_backed" && captured.comparison_contexts?.[0]
        ? capturedRoasMeaning(captured.comparison_contexts[0].context) : undefined;
      if (capturedAssurance.assurance.meaning !== "definition_backed" || !meaning) mismatches.push("supported_captured_ad_roas_required");
      if (externalAssurance.assurance.meaning !== "external_declared") mismatches.push("external_window_maturity_unknown");
      if (meaning) {
        const declaredMeaning = externalDeclarationMeaning(declaration);
        for (const key of Object.keys(meaning) as (keyof typeof meaning)[]) {
          if (jcs(meaning[key]) !== jcs(declaredMeaning[key])) mismatches.push(`meaning.${key}`);
        }
        // A declared dimension is a permitted axis, not proof that every row uses it.
        // Still refuse captured arbitrary/undeclared keys instead of silently missing matches.
        for (const row of captured.rows) {
          const group = JSON.parse(row.key);
          if (jcs(group) !== row.key || Object.keys(group).some(key => !meaning.grouping_dimensions.includes(key as GroupingDimension))) mismatches.push("captured_grouping_mismatch");
        }
      }
      externalComparable = Boolean(options.allowExternalDeclaration && meaning
        && capturedAssurance.assurance.meaning === "definition_backed" && externalAssurance.assurance.meaning === "external_declared");
    }
  } else if (!declared && la.meaning && ra.meaning) {
    for (const key of Object.keys(la.meaning) as (keyof typeof la.meaning)[]) {
      if (jcs(la.meaning[key]) !== jcs(ra.meaning[key])) mismatches.push(`meaning.${key}`);
    }
  }
  const provenance = (s: Snapshot): ResultProvenance => ({ source: s.source, sha256: comparisonDigest(s),
    ...(s.provenance ? { saved_report: s.provenance } : {}), ...(s.freshness_observations ? { freshness_observations: s.freshness_observations } : {}), ...(s.mapping_provenance ? { mapping_provenance: s.mapping_provenance } : {}),
    ...(s.external_calculation ? { external_calculation: s.external_calculation } : {}) });
  const result: ComparisonResult = { format: "cohort-comparison-v2", provenance: { left: provenance(a), right: provenance(b) },
    conditions: a.conditions, status: "incomparable", mismatches: [...new Set(mismatches)].sort(), assurance: { left: la.assurance, right: ra.assurance }, rows: [] };
  if (mismatches.length || (external ? !externalComparable : !declared && (!la.meaning || !ra.meaning))) return result;
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
  return { ...result, status: external ? "external_declared_comparison" : declared ? "declared_comparison" : "compared", rows };
}
