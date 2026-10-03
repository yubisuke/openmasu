export type MetricCorrectionPolicy = Readonly<{
  enabled: boolean; date_from: string; date_to: string; metric_names?: readonly string[];
  receipts_per_cycle: number; runs_per_page: number; maximum_runs_per_receipt: number;
}>;

/** Explicit finite cohort range, not an infinite backfill or completeness heuristic. */
export function normalizeMetricCorrectionPolicy(value: unknown): MetricCorrectionPolicy {
  const fail = (): never => { throw Error("metric_correction_policy_invalid"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["enabled","date_from","date_to","metric_names","receipts_per_cycle","runs_per_page","maximum_runs_per_receipt"].includes(k))) return fail();
  const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0,10) === v;
  if (typeof v.enabled !== "boolean" || !date(v.date_from) || !date(v.date_to) || v.date_to < v.date_from
      || Date.parse(v.date_to)-Date.parse(v.date_from) >= 31*86400000) return fail();
  const bounded = (v: unknown, fallback: number, maximum: number): number => {
    if (v === undefined) return fallback;
    if (!Number.isSafeInteger(v) || Number(v)<1 || Number(v)>maximum) return fail();
    return Number(v);
  };
  if (v.metric_names !== undefined && (!Array.isArray(v.metric_names) || !v.metric_names.length || v.metric_names.length>100
      || v.metric_names.some(name => typeof name!=="string" || !/^[a-z][a-z0-9_]{2,80}$/.test(name)))) return fail();
  return { enabled:v.enabled,date_from:v.date_from,date_to:v.date_to,
    receipts_per_cycle:bounded(v.receipts_per_cycle,5,20),runs_per_page:bounded(v.runs_per_page,20,100),
    maximum_runs_per_receipt:bounded(v.maximum_runs_per_receipt,200,1000),
    ...(v.metric_names ? {metric_names:[...new Set(v.metric_names as string[])].sort()} : {}) };
}

/** Cover a microsecond receipt; never truncate the source cutoff backwards. */
export function correctionCutoff(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) || !Number.isFinite(Date.parse(value))
      || new Date(value).toISOString().slice(0,19)!==value.slice(0,19)) throw Error("input_unavailable");
  const fraction = /\.(\d+)Z$/.exec(value)?.[1] ?? "";
  const delta = /[1-9]/.test(fraction.slice(3)) ? 1 : 0;
  return new Date(Date.parse(value)+delta).toISOString();
}
