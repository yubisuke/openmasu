import { ACQUISITION_KPI_ROLES, type AcquisitionKpiRole } from "@openmasu/contracts/definitions";
import type { DashboardView } from "./presenter.js";
import { escapeHtml } from "./html.js";
import { metricValueLabel } from "./metric-value.js";

const labels: Record<AcquisitionKpiRole, string> = { installs: "Installs", cost: "Cost (USD)", cpi: "CPI (USD/install)",
  ad_revenue: "D7 ad revenue (USD)", purchase_net: "D7 purchase net (USD)", total_net: "D7 total net (USD)",
  ad_roas: "D7 ad ROAS (×)", total_roas: "D7 total net ROAS (×)" };

/** Render saved observations and operand links, never divide table cells. */
export function renderAcquisitionKpis(view: DashboardView): string {
  const result = view.acquisition;
  if (!result.sets.length && !result.omittedRows && !result.partialPage) return "";
  const ready = result.sets.filter(set => set.state === "ready"), blocked = result.sets.filter(set => set.state === "blocked");
  const detail = (id: string, text: string) => view.selectedAppId
    ? `<a href="/dashboard/apps/${encodeURIComponent(view.selectedAppId)}/metrics/${encodeURIComponent(id)}/explanation">${escapeHtml(text)}</a>` : escapeHtml(text);
  return `<section aria-label="Acquisition KPIs"><h3>Saved acquisition KPIs</h3>
  <p>First-party click acquisition only; install cohorts, elapsed D7, UTC. Ad revenue, settled purchase net and their total remain separate. CPI is saved cost/install count; ROAS is saved revenue/cost. No cross-run calculation occurs here. Window closure does not prove upstream completeness.</p>
  ${result.partialPage ? "<p>Partial report selection: no KPI set is assembled. Select a complete page containing all eight saved metrics.</p>" : ""}
  ${result.omittedRows ? `<p>${result.omittedRows} KPI observations lack a complete, unique, matching calculation set; they remain in the ordinary report.</p>` : ""}
  ${blocked.map(set => `<p>Set ${escapeHtml(set.key)} is not decision-ready: ${escapeHtml(set.reason)}; D7 conservative end ${escapeHtml(set.closesAt)}; watermark ${escapeHtml(set.watermark)}.</p>`).join("")}
  ${!ready.length ? "" : `<table><caption>Same-set acquisition KPIs, exact saved units</caption><thead><tr><th scope="col">Cohort / campaign</th>${ACQUISITION_KPI_ROLES.map(role => `<th scope="col">${labels[role]}</th>`).join("")}<th scope="col">Calculation set</th></tr></thead><tbody>${ready.map(set => `<tr data-acquisition-kpi-set-key="${set.key}"><th scope="row">${escapeHtml(Object.entries(set.grouping).sort().map(([key, value]) => `${key}=${value}`).join(", "))}</th>${ACQUISITION_KPI_ROLES.map(role => {
    const row = set.rows[role], operands = role in set.operands ? set.operands[role as keyof typeof set.operands] : undefined;
    return `<td data-acquisition-kpi-role="${role}" data-acquisition-run-id="${escapeHtml(row.metric_run_id)}"${row.value_state === "present" ? ` data-acquisition-value-unscaled="${escapeHtml(row.value_unscaled)}"` : ""}>${escapeHtml(metricValueLabel(row))}<small>${detail(row.metric_run_id, "Saved run")}</small>${operands ? `<small>${detail(operands.numerator, "Numerator")} / ${detail(operands.denominator, "Denominator")}</small>` : ""}${role === "total_net" ? `<small>${detail(set.rows.ad_revenue.metric_run_id, "Ad summand")} + ${detail(set.rows.purchase_net.metric_run_id, "Purchase-net summand")}</small>` : ""}</td>`;
  }).join("")}<td><small>Key: ${set.key}</small><small>Input snapshot: ${set.inputSnapshotId}</small><small>FX snapshot: ${set.fxDigest}</small><small>Watermark: ${escapeHtml(set.watermark)}</small></td></tr>`).join("")}</tbody></table>`}</section>`;
}
