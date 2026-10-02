export type MetricRecalculationRequest = Readonly<{
  cost_import_run_id: string; date_from: string; date_to: string;
  watermark: string; metric_names?: readonly string[];
}>;

export function normalizeMetricRecalculationRequest(value: unknown): MetricRecalculationRequest {
  const fail = (): never => { throw new Error("metric_recalculation_request_invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["cost_import_run_id", "date_from", "date_to", "watermark", "metric_names"].includes(key))) return fail();
  const date = (value: unknown): value is string => typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
  if (typeof input.cost_import_run_id !== "string" || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.cost_import_run_id)
      || !date(input.date_from) || !date(input.date_to) || input.date_from > input.date_to
      || (Date.parse(input.date_to) - Date.parse(input.date_from)) / 86_400_000 >= 31
      || typeof input.watermark !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.watermark)
      || !Number.isFinite(Date.parse(input.watermark)) || new Date(input.watermark).toISOString() !== input.watermark) return fail();
  if (input.metric_names !== undefined && (!Array.isArray(input.metric_names) || input.metric_names.length < 1
      || input.metric_names.length > 100 || input.metric_names.some(name => typeof name !== "string" || !/^[a-z][a-z0-9_]{2,80}$/.test(name)))) return fail();
  return { cost_import_run_id: input.cost_import_run_id, date_from: input.date_from, date_to: input.date_to,
    watermark: input.watermark, ...(input.metric_names ? { metric_names: [...new Set(input.metric_names as string[])].sort() } : {}) };
}

/** Fixed fragments only; a revised input is not proof that the reported value is wrong. */
export const revisedMetricCostPredicate = `
  mr.comparison_context->'definition'->'definition'->>'calculation'='revenue_over_cost'
  AND mr.comparison_context->'definition'->'definition'->>'cost_basis'='cohort_acquisition_day_current_snapshot'
  AND mr.grouping->>'cohort_date' IS NOT NULL
  AND coalesce(mr.grouping->>'attribution_status','non_organic')='non_organic'
  AND cost.tenant_id=mr.tenant_id AND cost.app_id=mr.app_id
  AND cost.cost_date::text=mr.grouping->>'cohort_date'
  AND (mr.grouping->>'campaign_id' IS NULL OR cost.campaign_id=mr.grouping->>'campaign_id')
  AND (mr.grouping->>'network' IS NULL OR cost.network=mr.grouping->>'network')
  AND (mr.grouping->>'country' IS NULL OR cost.country=mr.grouping->>'country')
  AND control.canonical_timestamp_value(cost.as_of)>control.canonical_timestamp_value(mr.input_received_at_watermark)`;
