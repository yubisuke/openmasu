import { acquisitionKpiObservation, type AcquisitionKpiScope, type AcquisitionKpiBasis } from "@openmasu/runtime/acquisition-kpi-key";
export { acquisitionKpiSetKey, type AcquisitionKpiScope } from "@openmasu/runtime/acquisition-kpi-key";
import { ACQUISITION_KPI_ROLES,
  acquisitionKpiRole, type AcquisitionKpiRole } from "@openmasu/contracts/definitions";
import type { MetricReportRow } from "./reporting.js";

export type AcquisitionKpiSet = {
  key: string;
  horizon: 0 | 7 | 30;
  basis: AcquisitionKpiBasis;
  importProvider: string | null;
  grouping: Readonly<Record<string, string>>;
  watermark: string;
  closesAt: string;
  inputSnapshotId: string;
  fxDigest: string;
  state: "ready" | "blocked";
  reason: "window_not_elapsed" | "recalculation_pending" | "historical_or_unavailable" | null;
  rows: Record<AcquisitionKpiRole, MetricReportRow>;
  operands: Record<"cpi" | "ad_roas" | "total_roas", { numerator: string; denominator: string }>;
};

/** Pure projection of authorized saved rows. No division, fetching or recomputation. */
export function buildAcquisitionKpiSets(rows: readonly MetricReportRow[], partialPage: boolean, scope: AcquisitionKpiScope) {
  const groups = new Map<string, NonNullable<ReturnType<typeof acquisitionKpiObservation>>[]>();
  let omittedRows = 0;
  for (const row of rows) {
    if (!acquisitionKpiRole(row.metric_name)) continue;
    const item = acquisitionKpiObservation(row, scope);
    if (!item) { omittedRows++; continue; }
    const group = groups.get(item.key) ?? []; group.push(item); groups.set(item.key, group);
  }
  const sets: AcquisitionKpiSet[] = [];
  for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (partialPage || ACQUISITION_KPI_ROLES.some(role => group.filter(item => item.role === role).length !== 1)) {
      omittedRows += group.length; continue;
    }
    const first = group[0];
    const setRows = Object.fromEntries(group.map(item => [item.role, item.row])) as Record<AcquisitionKpiRole, MetricReportRow>;
    const unavailable = group.some(({ row }) => row.superseded || row.reproducibility_status !== "fully_reproducible"
      || row.value_state === "unavailable" || row.unavailable_reason || [row.privacy_update_state,
        row.late_input_update_state, row.attribution_update_state].includes("unavailable"));
    const pending = group.some(({ row }) => [row.cost_update_state, row.late_input_update_state,
      row.attribution_update_state, row.privacy_update_state].includes("recalculation_pending") || row.cost_update_state === "input_revised");
    const reason = unavailable ? "historical_or_unavailable" : pending ? "recalculation_pending"
      : Date.parse(first.row.input_received_at_watermark) < Date.parse(first.closesAt) ? "window_not_elapsed" : null;
    sets.push({ key, horizon: first.horizon, basis: first.basis, importProvider: first.provider, grouping: first.row.grouping, watermark: first.row.input_received_at_watermark,
      closesAt: first.closesAt, inputSnapshotId: first.row.input_snapshot_id, fxDigest: first.fxDigest,
      state: reason ? "blocked" : "ready", reason, rows: setRows,
      operands: { cpi: { numerator: setRows.cost.metric_run_id, denominator: setRows.installs.metric_run_id },
        ad_roas: { numerator: setRows.ad_revenue.metric_run_id, denominator: setRows.cost.metric_run_id },
        total_roas: { numerator: setRows.total_net.metric_run_id, denominator: setRows.cost.metric_run_id } } });
  }
  return { sets, omittedRows, partialPage };
}
