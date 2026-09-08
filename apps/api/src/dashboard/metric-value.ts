import type { MetricReportRow } from "../reporting.js";

/** Decimal placement only: no floating-point conversion and no display rounding. */
export function exactDecimal(integer: string, scale: number): string {
  if (!/^-?(0|[1-9][0-9]*)$/.test(integer) || !Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new Error("invalid_metric_decimal");
  }
  const negative = integer.startsWith("-");
  const digits = (negative ? integer.slice(1) : integer).padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
  return `${negative && /[1-9]/.test(digits) ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Units come from the stored type/scales, never from a metric-name heuristic. */
export function metricValueLabel(row: MetricReportRow): string {
  if (row.value_state === "undefined") return `— (${row.undefined_reason ?? "reason unavailable"})`;
  if (row.value_unscaled === undefined) return "Value unavailable";
  if (row.value_type === "money" && row.amount_scale !== null && row.currency) {
    return `${row.currency} ${exactDecimal(row.value_unscaled, row.amount_scale)}`;
  }
  if (row.value_type === "ratio" && row.ratio_scale !== null) {
    return `${exactDecimal(row.value_unscaled, row.ratio_scale)} ×`;
  }
  if (row.value_type === "count") return `${exactDecimal(row.value_unscaled, 0)} count`;
  return `${row.value_unscaled} (unscaled; unit unavailable)`;
}
