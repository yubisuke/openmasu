export type MeasurementHealth = {
  observed_at: string;
  scope: "retained_history";
  sdk: { active_keys: string; batches: string; pending: string; failed: string; latest_received_at: string | null; oldest_pending_at: string | null };
  imports: { runs: string; running: string; failed: string; latest_started_at: string | null; latest_completed_at: string | null };
  events: { logical_events: string; latest_received_at: string | null };
  rejections: { source: "event" | "mapping"; reason: string; count: string }[];
  metrics: { runs: string; active_schedules: string; pending_schedules: string; latest_computed_at: string | null; latest_watermark: string | null; latest_cohort_date: string | null };
};

export type MeasurementNotice = { state: string; message: string; next: string };

export function measurementNotices(health: MeasurementHealth): MeasurementNotice[] {
  const notices: MeasurementNotice[] = [];
  if (health.sdk.active_keys === "0") notices.push({ state: "sdk_not_configured", message: "No active SDK key is configured.", next: "An administrator can issue an SDK key in app settings; file imports do not require an SDK key." });
  if (health.sdk.batches === "0" && health.imports.runs === "0" && health.events.logical_events === "0") notices.push({ state: "no_observations", message: "No SDK batches, import runs, or logical events are recorded.", next: "Check the chosen ingestion method and submit a synthetic sample. Absence does not prove a service failure." });
  if (health.sdk.pending !== "0" || health.imports.running !== "0") notices.push({ state: "processing_wait", message: "Ingestion work is pending or an import is recorded as running.", next: "Check worker/job status and the oldest pending time. This observation alone does not prove a stalled worker." });
  if (health.sdk.failed !== "0" || health.imports.failed !== "0" || health.rejections.length > 0) notices.push({ state: "rejections_observed", message: "Failures or rejections exist in retained history.", next: "Review the safe reason counts and import validation result before retrying. Historical failures may already be resolved." });
  if (health.events.logical_events !== "0" && health.metrics.runs === "0") notices.push({ state: "not_computed", message: "Logical events exist but no metric run is recorded.", next: "Check metric definitions, cohort date and watermark; run metrics:run or configure a metric schedule." });
  if (health.metrics.pending_schedules !== "0") notices.push({ state: "calculation_wait", message: "A metric schedule has a pending target.", next: "Check scheduled worker progress; a pending target is not proof of a failed calculation." });
  if (health.metrics.runs !== "0") notices.push({ state: "results_observed", message: "Metric results are recorded.", next: "Open the cohort report and check its filters, definition and watermark. Results do not prove complete ingestion or live delivery." });
  return notices;
}
