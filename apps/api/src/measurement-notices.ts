import type { MeasurementClasses } from "@openmasu/runtime";

export type ReceiptCounts = { accepted: string; rejected: string; duplicate: string; late: string;
  metadata_not_recorded: string; latest_received_at: string | null };
export type RecentMeasurementHealth = {
  scope: "server_receipt_windows";
  window_hours: 1 | 24 | 168;
  received_from: string; received_to: string; previous_from: string;
  unit: "delivery_attempts";
  groups: (MeasurementClasses & { current: ReceiptCounts; previous: ReceiptCounts })[];
  pending_unit: "submitted_events";
  pending_groups: (MeasurementClasses & { pending: string; post_processing_pending: string; oldest_received_at: string })[];
  client_diagnostics: "on_device_only_not_received";
};

export type MeasurementHealth = {
  observed_at: string;
  scope: "retained_history";
  sdk: { active_keys: string; batches: string; pending: string; failed: string; latest_received_at: string | null; oldest_pending_at: string | null };
  imports: { runs: string; running: string; failed: string; latest_started_at: string | null; latest_completed_at: string | null };
  events: { logical_events: string; latest_received_at: string | null };
  rejections: { source: "event" | "mapping"; reason: string; count: string }[];
  metrics: { runs: string; active_schedules: string; pending_schedules: string; latest_computed_at: string | null; latest_watermark: string | null; latest_cohort_date: string | null };
  recent?: RecentMeasurementHealth;
};

export type MeasurementNotice = { state: string; message: string; next: string };

export function recentMeasurementNotices(recent: RecentMeasurementHealth): MeasurementNotice[] {
  const notices: MeasurementNotice[] = [];
  const total = (counts: ReceiptCounts) => BigInt(counts.accepted) + BigInt(counts.rejected) + BigInt(counts.duplicate);
  if (!recent.groups.some(group => total(group.current) > 0n)) notices.push({ state: "no_recent_receipts",
    message: "No delivery attempts were recorded in this receipt window.",
    next: "Choose a wider window and compare local SDK queue diagnostics. Low traffic and missing traffic do not establish an outage." });
  for (const group of recent.groups) {
    const label = `${group.producer} / ${group.producer_version} / ${group.event_name}`;
    if (total(group.current) === 0n && total(group.previous) > 0n) notices.push({ state: "group_no_recent_receipts",
      message: `${label}: receipts exist in the preceding window but not this one.`, next: "Check expected traffic and the local queue; this is not proof that a device or SDK stopped." });
    if (BigInt(group.current.rejected) > BigInt(group.previous.rejected)) notices.push({ state: "group_rejections_increased",
      message: `${label}: more rejected attempts than in the preceding window.`, next: "Compare the displayed counts, not an inferred failure rate or production SLA." });
    if (total(group.current) > 0n && total(group.current) < 5n) notices.push({ state: "low_observed_volume",
      message: `${label}: fewer than five attempts are observed.`, next: "Use counts and a wider window; do not diagnose an outage from this small sample." });
  }
  if (recent.pending_groups.length) notices.push({ state: "recent_pending_work", message: "Submitted events in this window have unfinished processing.",
    next: "Read the oldest pending receipt and worker status. Post-processing may remain pending after event admission." });
  return notices;
}

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
