import { createHash } from "node:crypto";
import { jcs } from "@openmasu/attribution-core";
import { parseSnapshot, parseComparisonContext, snapshotAssurance, canonicalComparisonCutoff } from "./cohort-comparison.js";
import type { MetricComparisonContext } from "@openmasu/runtime";

function object(v: unknown): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error("invalid_report");
}
export function reportToSnapshot(report: unknown, template: unknown) {
  const base = parseSnapshot(template);
  if (base.rows.length || base.provenance || base.comparison_contexts) throw Error("template_must_be_empty");
  object(report);
  if (Object.keys(report).some(k => k !== "data") || !Array.isArray(report.data) || report.data.length > 10000) throw Error("incomplete_or_invalid_report");
  const runs: { key: string; metric_run_id: string; input_snapshot_id: string }[] = [];
  const contexts: { key: string; context: MetricComparisonContext }[] = [];
  const ids = new Set<string>();
  let valueType: unknown;
  const rows = report.data.map(r => {
    object(r);
    if (typeof r.metric_run_id !== "string" || ids.has(r.metric_run_id)) throw Error("duplicate_or_invalid_run");
    ids.add(r.metric_run_id);
    if (typeof r.metric_name !== "string" || typeof r.metric_definition_version !== "string" || `${r.metric_name}@${r.metric_definition_version}` !== base.conditions.metric_definition) throw Error("definition_mismatch");
    if (typeof r.input_received_at_watermark !== "string" || canonicalComparisonCutoff(r.input_received_at_watermark) !== base.conditions.source_cutoff || r.aggregation_time_zone !== base.conditions.time_zone) throw Error("time_boundary_mismatch");
    if (r.superseded !== false || r.reproducibility_status !== "fully_reproducible") throw Error("historical_or_affected_run");
    const context = r.comparison_context == null ? undefined : parseComparisonContext(r.comparison_context);
    object(r.grouping);
    const allowed = ["cohort_date", "metric_date", "campaign_id", "network", "country", "attribution_status", "apple_conversion_bucket"];
    if (Object.entries(r.grouping).some(([k, v]) => !allowed.includes(k) || typeof v !== "string" || !v)) throw Error("invalid_grouping");
    const day = r.grouping.cohort_date ?? r.grouping.metric_date;
    if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day || day < base.conditions.date_from || day >= base.conditions.date_to) throw Error("cohort_outside_range");
    if ((r.grouping.attribution_status ?? "all") !== base.conditions.attribution_scope) throw Error("attribution_scope_mismatch");
    if (!["money", "ratio", "count"].includes(String(r.value_type)) || (valueType !== undefined && valueType !== r.value_type)) throw Error("value_type_mismatch");
    valueType = r.value_type;
    let scale: unknown, currency: unknown;
    if (r.value_type === "money") {
      scale = r.amount_scale ?? (r.value_state === "undefined" ? context?.definition.amount_scale : undefined);
      currency = r.currency ?? (r.value_state === "undefined" ? context?.definition.currency : undefined);
      if (r.ratio_scale != null) throw Error("invalid_scale");
    } else {
      if (r.currency != null || r.amount_scale != null) throw Error("invalid_units");
      scale = r.value_type === "ratio" ? r.ratio_scale : 0; currency = "none";
      if (r.value_type === "count" && r.ratio_scale != null) throw Error("invalid_scale");
    }
    const key = jcs(r.grouping);
    if (context) {
      const d = context.definition;
      if (context.metric_run_id !== r.metric_run_id || context.input_snapshot_id !== r.input_snapshot_id
          || d.metric_name !== r.metric_name || d.metric_definition_version !== r.metric_definition_version
          || d.value_type !== r.value_type
          || d.rule_bundle_id !== r.rule_bundle_id || d.rule_bundle_hash !== r.rule_bundle_hash
          || !Array.isArray(r.policy_versions) || !r.policy_versions.includes(`rule_bundle:${d.rule_bundle_version}`)
          || r.policy_versions.filter((policy: unknown) => typeof policy === "string" && policy.startsWith("rule_bundle:")).length !== 1
          || r.policy_versions.filter((policy: unknown) => typeof policy === "string" && policy.startsWith("fx:")).length > 1
          || r.policy_versions.some((policy: unknown) => typeof policy !== "string" || (!policy.startsWith("rule_bundle:") && !policy.startsWith("fx:")))
          || r.policy_versions.some((policy: string) => policy.startsWith("fx:") && policy !== `fx:${context.fx.policy_version}`)) throw Error("execution_policy_mismatch");
      contexts.push({ key, context });
    }
    if (typeof r.input_snapshot_id !== "string") throw Error("invalid_snapshot_id");
    runs.push({ key, metric_run_id: r.metric_run_id, input_snapshot_id: r.input_snapshot_id });
    if (r.value_state === "undefined") {
      if ("value_unscaled" in r) throw Error("undefined_with_value");
      return { key, currency, scale, state: "undefined", reason: r.undefined_reason };
    }
    if (r.value_state !== "present" || r.undefined_reason != null) throw Error("invalid_value_state");
    return { key, currency, scale, state: "present", value: r.value_unscaled };
  });
  const sorted = [...report.data].sort((a, b) => a.metric_run_id < b.metric_run_id ? -1 : a.metric_run_id > b.metric_run_id ? 1 : 0);
  const output = parseSnapshot({ ...base, rows, provenance: { report_sha256: createHash("sha256").update(jcs({ data: sorted })).digest("hex"), runs }, ...(contexts.length ? { comparison_contexts: contexts } : {}) });
  const { assurance } = snapshotAssurance(output);
  if (contexts.length === rows.length && rows.length) {
    for (const field of ["aggregation", "maturity"] as const) {
      if (assurance.conditions[field].state === "definition_backed") output.conditions[field] = assurance.conditions[field].value!;
    }
  }
  return output;
}
