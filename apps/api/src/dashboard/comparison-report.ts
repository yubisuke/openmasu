import type { compareSnapshots } from "../cohort-comparison.js";
import { jcs } from "@openmasu/attribution-core/canonical";
import { metricFreshnessLabels } from "./metric-freshness.js";

type Comparison = ReturnType<typeof compareSnapshots>;
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Display exact decimal strings without converting to floating point. */
export function decimal(value: string, scale: number): string {
  const negative = value.startsWith("-");
  const digits = (negative ? value.slice(1) : value).padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}

export function renderComparisonContent(result: Comparison): string {
  // Saved canonical JSON and in-process results must render the same bytes.
  result = JSON.parse(jcs(result)) as Comparison;
  const cell = (value: unknown) => `<td>${escape(value)}</td>`;
  const rows = result.rows.map(row => {
    const display = (side: typeof row.left) => !side ? "Missing row" : side.state === "undefined" ? `Undefined: ${side.reason}` : `${decimal(side.value, side.scale)} ${side.currency}`;
    const delta = row.delta_right_minus_left === undefined ? "Not calculated" : `${decimal(row.delta_right_minus_left, row.scale!)} ${row.currency}`;
    return `<tr><th scope="row">${escape(row.key)}</th>${cell(row.status)}${cell(display(row.left))}${cell(display(row.right))}${cell(delta)}</tr>`;
  }).join("\n");
  const conditions = result.conditions ? Object.entries(result.conditions).map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join("") : "";
  const mismatches = result.mismatches.map(key => `<li>${escape(key)}</li>`).join("");
  const provenanceDetails = (["left", "right"] as const).map(side => {
    const p = result.provenance[side];
    const observations = p.freshness_observations?.length
      ? `<table><caption>${side} saved operational observations</caption><thead><tr><th scope="col">Key</th><th scope="col">Time window</th><th scope="col">Source observation</th><th scope="col">Import completion</th><th scope="col">Recalculation</th></tr></thead><tbody>${p.freshness_observations.map(row => `<tr><th scope="row">${escape(row.key)}</th>${Object.entries(metricFreshnessLabels(row.observations)).map(([field, label]) => `<td data-freshness-field="${field}">${escape(label)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
      : "<p>No saved operational receipt metadata. Source observation, import completion and recalculation are unknown; temporal maturity is shown separately in the comparison basis.</p>";
    return `<h3>${side} evidence references</h3>${p.saved_report ? `<p>Saved report: ${escape(JSON.stringify(p.saved_report))}</p>` : ""}${observations}${p.mapping_provenance ? `<p>Operator-declared CSV mapping: ${escape(JSON.stringify(p.mapping_provenance))}</p>` : ""}${p.external_calculation ? `<p>EXTERNAL DECLARATION: not captured execution, provider authentication, or independent verification.</p><p>Declaration SHA-256: ${escape(p.external_calculation.declaration_sha256)}</p><p>${escape(JSON.stringify(p.external_calculation.declaration))}</p>` : ""}`;
  }).join("");
  const assurance = (["left", "right"] as const).map(side => {
    const a = result.assurance[side];
    return `<h3>${escape(side)}: ${escape(a.meaning)}</h3><p>Query acquisition: ${escape(a.acquisition.state)}; ${a.acquisition.row_count} rows. Upstream completeness: unknown. Missing dates are not zero.</p><dl>${Object.entries(a.conditions).map(([key, value]) => `<dt>${escape(key)} (${escape(value.state)})</dt><dd>${escape(value.value ?? "Unknown")}</dd>`).join("")}</dl>${a.missing.length ? `<p>Unknown: ${escape(a.missing.join(", "))}</p>` : ""}<p>Internal execution references (not semantic equality keys): ${escape(JSON.stringify(a.execution))}</p>`;
  }).join("");
  return `<h1>OpenMasu cohort comparison</h1>
<p>Status: ${escape(result.status)}</p>
<p>Differences are right minus left. A numerical difference does not establish its cause.</p>
${result.status === "external_declared_comparison" ? "<p>EXTERNAL DECLARED COMPARISON: the saved calculation matches the operator's explicit claim. The external implementation and completeness remain unverified.</p>" : ""}
${result.status === "incomparable" ? `<h2>Incompatible or unknown conditions</h2><p>No numerical comparison was performed.</p><ul>${mismatches}</ul>` : `<h2>Selected conditions</h2><dl>${conditions}</dl>${result.status === "declared_comparison" ? "<p>DECLARED ONLY: equivalence of calculation meaning has not been established.</p>" : ""}<h2>Results</h2><p>${result.rows.length} rows. Missing and undefined values are not zero.</p><table><caption>Exact aggregate comparison</caption><thead><tr><th scope="col">Key</th><th scope="col">Status</th><th scope="col">Left</th><th scope="col">Right</th><th scope="col">Difference</th></tr></thead><tbody>${rows}</tbody></table>`}
<h2>Comparison basis</h2>${assurance}
<h2>Input provenance</h2>
<dl><dt>Left source</dt><dd>${escape(result.provenance.left.source)}</dd><dt>Left normalized SHA-256</dt><dd>${escape(result.provenance.left.sha256)}</dd>
<dt>Right source</dt><dd>${escape(result.provenance.right.source)}</dd><dt>Right normalized SHA-256</dt><dd>${escape(result.provenance.right.sha256)}</dd></dl>
${provenanceDetails}
<p>Retain the input snapshots to reproduce this report. Local receipt observations describe retained app import history at capture, not the selected metric population or a provider SLA. They do not change comparison meaning or authenticate a supplied file. Definition-backed means agreement under the saved implementation profile, not authentication of the producer or independent verification of completeness. Declared conditions are not independently verified. This file contains aggregate input values; share it only with intended recipients.</p>
`;
}

export function renderComparison(result: Comparison): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenMasu cohort comparison</title></head><body>
${renderComparisonContent(result)}</body></html>\n`;
}
