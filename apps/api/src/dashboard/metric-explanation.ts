import type { MetricExplanation } from "../metric-explanation.js";
import { exactDecimal } from "./metric-value.js";
import { escapeHtml } from "./html.js";

export function renderMetricExplanation(appId: string, value: MetricExplanation): string {
  const run = value.run;
  const result = run.value_state === "present" && run.value_unscaled !== undefined
    ? run.ratio_scale !== undefined ? `${exactDecimal(run.value_unscaled, run.ratio_scale)} ×`
      : run.currency && run.amount_scale !== undefined ? `${run.currency} ${exactDecimal(run.value_unscaled, run.amount_scale)}` : run.value_unscaled
    : `— (${run.unavailable_reason ?? run.undefined_reason ?? "value unavailable"})`;
  const item = (label: string, text: unknown) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(text)}</dd>`;
  const evidence = value.calculation;
  const components = evidence && evidence.version !== 1 ? [
    item("Advertising revenue", `${evidence.target_currency} ${exactDecimal(evidence.operands.ad_revenue_unscaled, evidence.target_scale)}`),
    item("Settled purchase revenue", `${evidence.target_currency} ${exactDecimal(evidence.operands.purchase_revenue_unscaled, evidence.target_scale)}`),
    item("Settled refund deduction", `${evidence.target_currency} ${exactDecimal(evidence.operands.refund_deduction_unscaled, evidence.target_scale)}`),
    item("Accepted settled purchases", evidence.operands.purchase_event_count),
    item("Accepted settled refunds", evidence.operands.refund_event_count),
    ...(evidence.version === 3 ? [
      item("Explicit refund cancellation", `${evidence.target_currency} ${exactDecimal(evidence.operands.refund_reversal_unscaled, evidence.target_scale)}`),
      item("Cancelled settled refunds", evidence.operands.refund_reversal_event_count),
    ] : []),
    item("Numerator composition", `${evidence.operands.ad_revenue_unscaled} + ${evidence.operands.purchase_revenue_unscaled} - ${evidence.operands.refund_deduction_unscaled}${evidence.version === 3 ? ` + ${evidence.operands.refund_reversal_unscaled}` : ""} = ${evidence.operands.revenue_unscaled} target units`),
  ] : [];
  const detail = evidence ? `<h2>Recorded calculation</h2><dl>${[
    item("Evidence version", evidence.version), ...components,
    item(evidence.version !== 1 ? "Numerator: total net revenue" : "Numerator: accepted ad revenue", `${evidence.target_currency} ${exactDecimal(evidence.operands.revenue_unscaled, evidence.target_scale)}`),
    item("Denominator: selected acquisition cost", `${evidence.target_currency} ${exactDecimal(evidence.operands.cost_unscaled, evidence.target_scale)}`),
    item("Accepted ad revenue events", evidence.operands.revenue_event_count), item("Selected cost rows", evidence.operands.cost_row_count),
    item("Cohort installations", evidence.operands.cohort_size),
    item("Definition digest", evidence.definition_digest), item("Anchor", evidence.anchor_event),
    item("Revenue window", evidence.calendar_cohort_policy
      ? `[install time, local midnight after cohort day ${evidence.window.day})`
      : `[install time, install time + ${evidence.window.day + 1} days)`),
    ...(evidence.calendar_cohort_policy ? [item("Calendar policy", "Cumulative revenue through the named local cohort day; activity on that local day only"),
      item("Cost reporting time zone", "Must explicitly match the aggregation time zone; unknown or different zones are not allocated")] : []),
    item("Aggregation time zone", evidence.aggregation_time_zone), item("Window state at run watermark", value.window_state),
    item("Last cohort window end", evidence.operands.last_window_end ?? "unknown"),
    item("Fraud policy", evidence.fraud_policy), item("Cost basis", evidence.cost_basis),
    item("Cost selection digest", evidence.cost_selection_digest),
    item("FX policy", evidence.fx_policy_version), item("FX snapshot", evidence.fx_snapshot_id),
    item("Target currency / scale", `${evidence.target_currency} / ${evidence.target_scale}`),
    item("Conversion rates", evidence.rates.map((rate) => `${rate.currency}: ${exactDecimal(rate.rate_unscaled, rate.rate_scale)}${rate.effective_date ? ` on ${rate.effective_date}, ${rate.source}, as of ${rate.as_of}` : ""}`).join("; ")),
    item("Rounding", evidence.fx_conversion_snapshot ? "half-even per revenue event and per selected cost row before summation; half-even after division"
      : "half-even per revenue event before summation; half-even per cost row when scaling down; half-even after division"),
    ...(evidence.version !== 1 ? [item("Commerce policy", "Settled purchases minus settled refunds; each is independently converted and half-even rounded in its own occurrence-time window")] : []),
    ...(evidence.version === 3 ? [item("Refund cancellation policy", "Explicit targets cancel their original refund contribution once as of the watermark, using the refund's window and rounded amount, not a new purchase")] : []),
    item("Formula", evidence.operands.cost_unscaled === "0" ? "undefined: no_attributed_cost"
      : `half_even(${evidence.operands.revenue_unscaled} × 10^${evidence.ratio_scale} / ${evidence.operands.cost_unscaled})`),
  ].join("")}</dl><p>A closed occurrence-time window does not prove all delayed inputs have arrived. Revenue uses accepted installation-level events in the recorded window. Cost uses one latest row per acquisition-day cost key at the watermark. Exclusion reasons were not recorded individually and are unavailable.</p>`
    : `<h2>Calculation evidence unavailable</h2><p>${escapeHtml(value.evidence_state)}. Only saved run provenance is shown. Missing operands are not zero.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Metric explanation — OpenMasu</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main><h1>${escapeHtml(run.metric_name)}</h1><p>${escapeHtml(result)}</p><p><a href="/dashboard/apps/${encodeURIComponent(appId)}">Return to app metrics</a></p><h2>Saved run</h2><dl>${[
    item("Run", run.metric_run_id), item("Definition version", run.metric_definition_version),
    item("Grouping", JSON.stringify(run.grouping)), item("Input snapshot", run.input_snapshot_id),
    item("Watermark", run.watermark), item("Computed at", run.computed_at), item("Freshness", run.data_freshness),
    item("Revision", run.superseded ? "superseded" : "current"), item("Replaces", run.supersedes_metric_run_id ?? "none"),
    item("Rule bundle", `${run.rule_bundle_id} / ${run.rule_bundle_version} / ${run.rule_bundle_hash}`),
    item("Unscaled result", run.value_unscaled ?? "undefined"), item("Ratio scale", run.ratio_scale ?? "unavailable"),
    ...(run.fx_conversion_snapshot ? [item("FX snapshot", run.fx_conversion_snapshot.snapshot_id),
      item("FX date selection", "UTC occurrence date for revenue; declared reporting date for cost; only captured rates known at the watermark"),
      item("Target currency / scale", `${run.fx_conversion_snapshot.policy.target_currency} / ${run.fx_conversion_snapshot.policy.target_scale}`),
      item("Captured rates", run.fx_conversion_snapshot.policy.rates.map(rate =>
        `${rate.currency} on ${rate.effective_date}: ${exactDecimal(rate.rate_unscaled,rate.rate_scale)}; ${rate.source}; as of ${rate.as_of}`).join("; "))] : []),
  ].join("")}</dl>${detail}</main></body></html>`;
}
