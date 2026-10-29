import { sha256 } from "@openmasu/attribution-core/canonical";
import { ACQUISITION_KPI_ROLES, BASIS_ACQUISITION_KPI_BUNDLE, acquisitionKpiRole } from "@openmasu/contracts/definitions";
import { validateMetricDefinition } from "@openmasu/contracts/validation";
import { acquisitionKpiSetKey } from "./acquisition-kpi-key.js";
import { captureMetricComparisonContext } from "./metric-comparison.js";
import type { MetricReportRow } from "./metric-report-read.js";

type RecalculationRange = Readonly<{
  date_from: string; date_to: string;
  watermark: string; metric_names?: readonly string[];
}>;
export type CostRecalculationRequest = RecalculationRange & Readonly<{ cost_import_run_id: string; trigger_kind?: never }>;
export type LateEventRecalculationRequest = RecalculationRange & Readonly<{ trigger_kind: "late_events" }> & (
  Readonly<{ source_record_ids: readonly string[]; source_received_from?: never; source_received_to?: never }>
  | Readonly<{ source_record_ids?: never; source_received_from: string; source_received_to: string }>
);
export type MetricRecalculationRequest = CostRecalculationRequest | LateEventRecalculationRequest;

export function normalizeMetricRecalculationRequest(value: unknown): MetricRecalculationRequest {
  const fail = (): never => { throw new Error("metric_recalculation_request_invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const input = value as Record<string, unknown>;
  const late = input.trigger_kind === "late_events";
  const sourceKeys = late ? ["trigger_kind", "source_record_ids", "source_received_from", "source_received_to"] : ["cost_import_run_id"];
  if (Object.keys(input).some(key => ![...sourceKeys, "date_from", "date_to", "watermark", "metric_names"].includes(key))) return fail();
  const date = (value: unknown): value is string => typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  const timestamp = (value: unknown): value is string => typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  if (late) {
    if (input.source_record_ids !== undefined) {
      if (!Array.isArray(input.source_record_ids) || input.source_record_ids.length < 1 || input.source_record_ids.length > 100
        || input.source_record_ids.some(id => typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(id))
        || input.source_received_from !== undefined || input.source_received_to !== undefined) return fail();
    } else if (!timestamp(input.source_received_from) || !timestamp(input.source_received_to)
      || input.source_received_from >= input.source_received_to
      || Date.parse(input.source_received_to) - Date.parse(input.source_received_from) > 86_400_000
      || !timestamp(input.watermark) || input.source_received_to > input.watermark) return fail();
  } else if (typeof input.cost_import_run_id !== "string"
    || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.cost_import_run_id)) return fail();
  if (!date(input.date_from) || !date(input.date_to) || input.date_from > input.date_to
      || (Date.parse(input.date_to) - Date.parse(input.date_from)) / 86_400_000 >= 31
      || typeof input.watermark !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.watermark)
      || !Number.isFinite(Date.parse(input.watermark)) || new Date(input.watermark).toISOString() !== input.watermark) return fail();
  if (input.metric_names !== undefined && (!Array.isArray(input.metric_names) || input.metric_names.length < 1
      || input.metric_names.length > 100 || input.metric_names.some(name => typeof name !== "string" || !/^[a-z][a-z0-9_]{2,80}$/.test(name)))) return fail();
  const range = { date_from: input.date_from, date_to: input.date_to, watermark: input.watermark,
    ...(input.metric_names ? { metric_names: [...new Set(input.metric_names as string[])].sort() } : {}) };
  return late ? { ...range, trigger_kind: "late_events", ...(input.source_record_ids
    ? { source_record_ids: [...new Set(input.source_record_ids as string[])].sort() }
    : { source_received_from: input.source_received_from as string, source_received_to: input.source_received_to as string }) }
    : { cost_import_run_id: input.cost_import_run_id as string, ...range };
}

/** Fixed fragments only; a revised input is not proof that the reported value is wrong. */
export const metricCostScopePredicate = `
  ((mr.comparison_context->'definition'->'definition'->>'calculation'='revenue_over_cost'
    AND mr.comparison_context->'definition'->'definition'->>'cost_basis'='cohort_acquisition_day_current_snapshot')
    OR mr.comparison_context->'definition'->>'rule_bundle_id'='${BASIS_ACQUISITION_KPI_BUNDLE}')
  AND mr.grouping->>'cohort_date' IS NOT NULL
  AND coalesce(mr.grouping->>'attribution_status','non_organic')='non_organic'
  AND cost.tenant_id=mr.tenant_id AND cost.app_id=mr.app_id
  AND cost.cost_date::text=mr.grouping->>'cohort_date'
  AND (mr.comparison_context->'definition'->>'calendar_cohort_policy' IS NULL OR
    cost.artifact->>'reporting_time_zone'=mr.comparison_context->'definition'->>'aggregation_time_zone')
  AND (mr.grouping->>'campaign_id' IS NULL OR cost.campaign_id=mr.grouping->>'campaign_id')
  AND (mr.grouping->>'ad_group_id' IS NULL OR cost.ad_group_id=mr.grouping->>'ad_group_id')
  AND (mr.grouping->>'creative_id' IS NULL OR cost.artifact->>'creative_id'=mr.grouping->>'creative_id')
  AND (NOT (cost.artifact ? 'creative_id') OR
    mr.comparison_context->'definition'->>'acquisition_dimension_policy'='selected_link_ad_group_creative')
  AND (mr.grouping->>'network' IS NULL OR cost.network=mr.grouping->>'network')
  AND (mr.grouping->>'country' IS NULL OR cost.country=mr.grouping->>'country')`;
export const revisedMetricCostPredicate = `${metricCostScopePredicate}
  AND control.canonical_timestamp_value(cost.as_of)>control.canonical_timestamp_value(mr.input_received_at_watermark)`;

type Any = Record<string, any>;
export type CorrectionCandidate = { metric_run_id: string; replay: Any | null; artifact?: Any;
  comparison_context?: Any | null; grouping_digest?: string; pending?: boolean; evidence_unavailable?: boolean };
type CorrectionSelection = { metric_run_id: string; replay: Any | null; safe_reason: string | null };

/** Explicit new-profile selections include their fixed companions, not unrelated metrics. */
export function correctionMetricNames(names?: readonly string[]): string[] | undefined {
  if (!names) return undefined;
  const expanded = new Set(names);
  for (const name of names) if (/^(platform_|imported_)acquisition_d7_/.test(name) && acquisitionKpiRole(name)) {
    const prefix = name.startsWith("platform_") ? "platform_" : "imported_";
    for (const role of ACQUISITION_KPI_ROLES) expanded.add(`${prefix}acquisition_d7_${role}`);
  }
  return [...expanded].sort();
}

export function isBasisAcquisitionReplay(replay: Any | null): boolean {
  return !!replay?.metric_definition && replay.metric_definition.rule_bundle_id === BASIS_ACQUISITION_KPI_BUNDLE
    && validateMetricDefinition(replay.metric_definition);
}

function companionKey(row: CorrectionCandidate, scope: { tenantId: string; appId: string }): string | null {
  const artifact = row.artifact;
  if (!artifact || row.comparison_context?.definition?.rule_bundle_id !== BASIS_ACQUISITION_KPI_BUNDLE) return null;
  // Reuse the report's set identity; do not infer companions from campaign or metric names alone.
  return acquisitionKpiSetKey({ ...artifact, grouping: artifact.grouping?.dimensions ?? {},
    grouping_digest: row.grouping_digest, comparison_context: row.comparison_context,
    policy_versions: [`rule_bundle:${artifact.rule_bundle_version}`,
      ...(artifact.fx_policy_version || artifact.fx_conversion_snapshot?.policy?.policy_version
        ? [`fx:${artifact.fx_policy_version ?? artifact.fx_conversion_snapshot.policy.policy_version}`] : [])],
    currency: artifact.currency ?? null, amount_scale: artifact.amount_scale ?? null,
    ratio_scale: artifact.ratio_scale ?? null, value_state: artifact.value_state ?? "present",
  } as unknown as MetricReportRow, scope);
}

/** Work only within the caller's bounded, captured candidates (including automatic pages).
 * Incomplete/ambiguous sets remain unavailable, never partly recalculated or globally discovered. */
export function expandAcquisitionCompanions(scope: { tenantId: string; appId: string },
  candidates: readonly CorrectionCandidate[], selected: readonly CorrectionSelection[]): CorrectionSelection[] {
  if (candidates.length > 100) throw new Error("metric_recalculation_selection_limit");
  const keys = new Map(candidates.map(row => [row.metric_run_id, companionKey(row, scope)]));
  const output = new Map(selected.map(row => [row.metric_run_id, row]));
  for (const seed of selected) {
    const candidate = candidates.find(row => row.metric_run_id === seed.metric_run_id);
    if (candidate?.comparison_context?.definition?.rule_bundle_id !== BASIS_ACQUISITION_KPI_BUNDLE) continue;
    const key = keys.get(seed.metric_run_id);
    const companions = key ? candidates.filter(row => keys.get(row.metric_run_id) === key) : [candidate];
    const roles = new Set(companions.map(row => acquisitionKpiRole(row.artifact?.metric_name ?? "")));
    let reason = !key || companions.length !== 8 || roles.size !== 8 || roles.has(undefined) ? "unsupported_definition" : null;
    for (const row of companions) {
      const replay = row.replay;
      if (!reason && (replay?.version !== 1 || !replay.evaluation || !replay.fx_policy)) reason = "replay_unavailable";
      if (!reason) {
        try {
          if (!isBasisAcquisitionReplay(replay) || replay!.source_metric_run_id !== row.metric_run_id
            || sha256(replay!.evaluation.grouping ?? {}) !== row.grouping_digest
            || replay!.evaluation.input_received_at_watermark !== row.artifact!.input_received_at_watermark
            || sha256(captureMetricComparisonContext(row.artifact as { metric_run_id: string; input_snapshot_id: string },
              replay!.metric_definition, replay!.fx_policy, replay!.evaluation.privacy_state ?? "after", sha256)) !== sha256(row.comparison_context)) {
            reason = "unsupported_definition";
          }
        } catch { reason = "unsupported_definition"; }
      }
      if (!reason && row.evidence_unavailable) reason = "input_unavailable";
      if (!reason && row.pending) reason = "already_pending";
      if (!reason && output.get(row.metric_run_id)?.safe_reason) reason = output.get(row.metric_run_id)!.safe_reason;
    }
    for (const row of companions) output.set(row.metric_run_id, { metric_run_id: row.metric_run_id,
      replay: row.replay, safe_reason: reason });
  }
  return [...output.values()].sort((a, b) => a.metric_run_id < b.metric_run_id ? -1 : a.metric_run_id > b.metric_run_id ? 1 : 0);
}
