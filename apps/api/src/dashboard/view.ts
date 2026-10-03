import { compareMetricRows, presentDashboardView, type DashboardView } from "./presenter.js";
import { buildRetentionMatrices } from "./retention-matrix.js";
export type {
  DashboardApp, DashboardChart, DashboardTrackingLink, DashboardSdkKey, DashboardServerKey,
  DashboardOperatorWebhook, DashboardOperatorBulkExport, DashboardView,
} from "./presenter.js";

/** Application adapter: validate saved contexts before the IO-free presenter. */
export function buildDashboardView(input: Parameters<typeof presentDashboardView>[0]): DashboardView {
  const rows = [...(input.metrics?.data ?? [])].sort(compareMetricRows);
  const retention = buildRetentionMatrices(rows, Boolean(input.metrics?.next_cursor || input.query?.after));
  return presentDashboardView(input, { rows, retention });
}
