import type { MetricFreshness } from "../metric-freshness.js";

/** Shared labels for ordinary metrics and saved comparisons. No IO or calculation. */
export function metricFreshnessLabels(value: MetricFreshness) {
  const w = value.time_window_maturity, s = value.source_observation, i = value.import_completion, r = value.recalculation_state;
  return {
    time_window_maturity: w.state === "window_elapsed" ? `Time window elapsed at saved watermark${w.closes_at ? ` (conservative end ${w.closes_at})` : ""}.`
      : w.state === "window_not_elapsed" ? `Time window not elapsed at saved watermark${w.closes_at ? ` (conservative end ${w.closes_at})` : ""}.` : "Time-window maturity unknown.",
    source_observation: `${s.state === "known_empty" ? "Known-empty local receipt recorded; not a zero cohort."
      : s.state === "observed" ? "Nonempty local receipt recorded."
      : s.state === "not_observed" ? "No retained import acquisition observed." : "Local source observation unknown."} Saved input snapshot: ${s.input_snapshot}. Upstream freshness: unknown.`,
    import_completion: `${i.state === "completed" ? "Local import completed."
      : i.state === "in_progress" ? "Local import in progress; last receipt is not current completion."
      : i.state === "partial_failure" ? "Partial local import failure or rejected rows."
      : i.state === "failed" ? "Local import failed."
      : i.state === "not_observed" ? "No retained import completion observed." : "Import completion unknown."} App receipt counts: completed ${i.completed ?? "unknown"}, running ${i.running ?? "unknown"}, failed ${i.failed ?? "unknown"}, with rejected rows ${i.with_row_rejections ?? "unknown"}. These are not the report population.`,
    recalculation_state: `${r.state === "pending" ? "Recalculation pending; saved value remains unchanged."
      : r.state === "input_revised" ? "Cost input revised; no pending recalculation recorded."
      : r.state === "completed" ? "Recalculation completed; original history is preserved."
      : r.state === "unavailable" ? "Recalculation unavailable; inspect its safe reason."
      : r.state === "no_recorded_request" ? "No recalculation request recorded; not proof of complete arrival." : "Recalculation state unknown."} Cost: ${r.cost}; late inputs: ${r.late_inputs}; privacy: ${r.privacy}.`,
  };
}
