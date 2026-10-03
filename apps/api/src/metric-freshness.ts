import { sha256 } from "@openmasu/attribution-core/canonical";
import { comparisonMaturity, type MetricComparisonContext } from "@openmasu/runtime/metric-comparison";

export const freshnessFields = ["time_window_maturity", "source_observation", "import_completion", "recalculation_state"] as const;
const receiptScope = "app_retained_import_receipts" as const;
export type MetricFreshness = {
  time_window_maturity: { state: "window_elapsed" | "window_not_elapsed" | "unknown"; closes_at: string | null; at_watermark: string | null };
  source_observation: {
    state: "observed" | "known_empty" | "not_observed" | "unknown";
    scope: typeof receiptScope; input_snapshot: "observed" | "empty" | "unknown";
    empty_receipts: string | null; latest_receipt_at: string | null; upstream_freshness: "unknown";
  };
  import_completion: {
    state: "completed" | "in_progress" | "partial_failure" | "failed" | "not_observed" | "unknown";
    scope: typeof receiptScope; receipts: string | null; completed: string | null;
    running: string | null; failed: string | null; with_row_rejections: string | null;
  };
  recalculation_state: {
    state: "pending" | "input_revised" | "completed" | "unavailable" | "no_recorded_request" | "unknown";
    cost: "recalculation_pending" | "input_revised" | "no_recorded_revision" | "unknown";
    late_inputs: "recalculation_pending" | "unavailable" | "completed" | "no_recorded_request" | "unknown";
    privacy: "not_affected" | "recalculation_pending" | "unavailable" | "completed" | "unknown";
  };
};

/** Counts only; source IDs, file values, protected references and credentials stay in SQL. */
export type ImportReceiptObservation = {
  receipts: string; completed: string; running: string; failed: string; with_row_rejections: string;
  empty_receipts: string; nonempty_receipts: string; latest_receipt_at: string | null;
};
type SavedRun = {
  metric_run_id?: string; input_snapshot_id?: string; input_received_at_watermark?: string;
  grouping?: Readonly<Record<string, string>>; comparison_context?: MetricComparisonContext | null;
  cost_update_state?: MetricFreshness["recalculation_state"]["cost"];
  late_input_update_state?: MetricFreshness["recalculation_state"]["late_inputs"];
  privacy_update_state?: MetricFreshness["recalculation_state"]["privacy"];
};
const timestamp = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
const positive = (value: string) => value !== "0";

/** Pure interpretation of saved definitions and observed local receipts, not a provider SLA. */
export function metricFreshness(run: SavedRun, receipts?: ImportReceiptObservation, inputEvidenceCount?: number): MetricFreshness {
  const window: MetricFreshness["time_window_maturity"] = { state: "unknown", closes_at: null,
    at_watermark: timestamp(run.input_received_at_watermark) ? run.input_received_at_watermark : null };
  try {
    const context = run.comparison_context;
    if (context && context.metric_run_id === run.metric_run_id && context.input_snapshot_id === run.input_snapshot_id
        && sha256(context.definition) === context.definition_digest && window.at_watermark) {
      const maturity = comparisonMaturity(context, { ...run.grouping }, window.at_watermark);
      window.state = !maturity.closes_at ? "unknown" : maturity.state === "window_elapsed" ? "window_elapsed" : "window_not_elapsed";
      window.closes_at = maturity.closes_at;
    }
  } catch { /* Legacy or unsupported evidence is unknown, never inferred from a name. */ }
  const observation: MetricFreshness["source_observation"] = {
    state: !receipts ? "unknown" : positive(receipts.nonempty_receipts) ? "observed"
      : positive(receipts.empty_receipts) ? "known_empty" : receipts.receipts === "0" ? "not_observed" : "unknown",
    scope: receiptScope, input_snapshot: inputEvidenceCount === undefined ? "unknown" : inputEvidenceCount === 0 ? "empty" : "observed",
    empty_receipts: receipts?.empty_receipts ?? null, latest_receipt_at: receipts?.latest_receipt_at ?? null,
    upstream_freshness: "unknown",
  };
  const completion: MetricFreshness["import_completion"] = {
    state: !receipts ? "unknown" : positive(receipts.running) ? "in_progress"
      : positive(receipts.with_row_rejections) || (positive(receipts.failed) && positive(receipts.completed)) ? "partial_failure"
      : positive(receipts.failed) ? "failed" : positive(receipts.completed) ? "completed"
      : receipts.receipts === "0" ? "not_observed" : "unknown",
    scope: receiptScope, receipts: receipts?.receipts ?? null, completed: receipts?.completed ?? null,
    running: receipts?.running ?? null, failed: receipts?.failed ?? null, with_row_rejections: receipts?.with_row_rejections ?? null,
  };
  const cost = run.cost_update_state ?? "unknown", late = run.late_input_update_state ?? "unknown", privacy = run.privacy_update_state ?? "unknown";
  const channels = [cost, late, privacy];
  const recalculation: MetricFreshness["recalculation_state"] = {
    state: channels.includes("recalculation_pending") ? "pending" : channels.includes("unavailable") ? "unavailable"
      : cost === "input_revised" ? "input_revised" : channels.includes("completed") ? "completed"
      : channels.includes("unknown") ? "unknown" : "no_recorded_request",
    cost, late_inputs: late, privacy,
  };
  return { time_window_maturity: window, source_observation: observation, import_completion: completion, recalculation_state: recalculation };
}

/** Missing report metadata is unknown; it never inherits an asserted `complete` label. */
export function freshnessOfReportRow(run: SavedRun & Partial<MetricFreshness>): MetricFreshness {
  const fallback = metricFreshness(run);
  return Object.fromEntries(freshnessFields.map(field => [field, run[field] ?? fallback[field]])) as MetricFreshness;
}

/** Closed aggregate metadata; old comparison files omit it and remain readable unchanged. */
export function parseMetricFreshness(value: unknown): MetricFreshness {
  const object = (item: unknown, fields: readonly string[]): Record<string, unknown> => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== fields.length
        || Object.keys(item).some(key => !fields.includes(key))) throw Error("invalid_metric_freshness");
    return item as Record<string, unknown>;
  };
  const enumeration = (v: unknown, values: readonly string[]) => { if (typeof v !== "string" || !values.includes(v)) throw Error("invalid_metric_freshness"); };
  const count = (v: unknown) => { if (v !== null && (typeof v !== "string" || !/^(0|[1-9]\d{0,29})$/.test(v))) throw Error("invalid_metric_freshness"); };
  const time = (v: unknown) => { if (v !== null && !timestamp(v)) throw Error("invalid_metric_freshness"); };
  const root = object(value, freshnessFields);
  const w = object(root.time_window_maturity, ["state", "closes_at", "at_watermark"]);
  enumeration(w.state, ["window_elapsed", "window_not_elapsed", "unknown"]); time(w.closes_at); time(w.at_watermark);
  const s = object(root.source_observation, ["state", "scope", "input_snapshot", "empty_receipts", "latest_receipt_at", "upstream_freshness"]);
  enumeration(s.state, ["observed", "known_empty", "not_observed", "unknown"]); enumeration(s.scope, [receiptScope]);
  enumeration(s.input_snapshot, ["observed", "empty", "unknown"]); count(s.empty_receipts); time(s.latest_receipt_at); enumeration(s.upstream_freshness, ["unknown"]);
  const i = object(root.import_completion, ["state", "scope", "receipts", "completed", "running", "failed", "with_row_rejections"]);
  enumeration(i.state, ["completed", "in_progress", "partial_failure", "failed", "not_observed", "unknown"]); enumeration(i.scope, [receiptScope]);
  for (const field of ["receipts", "completed", "running", "failed", "with_row_rejections"]) count(i[field]);
  const r = object(root.recalculation_state, ["state", "cost", "late_inputs", "privacy"]);
  enumeration(r.state, ["pending", "input_revised", "completed", "unavailable", "no_recorded_request", "unknown"]);
  enumeration(r.cost, ["recalculation_pending", "input_revised", "no_recorded_revision", "unknown"]);
  enumeration(r.late_inputs, ["recalculation_pending", "unavailable", "completed", "no_recorded_request", "unknown"]);
  enumeration(r.privacy, ["not_affected", "recalculation_pending", "unavailable", "completed", "unknown"]);
  return structuredClone(value) as MetricFreshness;
}
