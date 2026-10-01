import type { compareSnapshots } from "../cohort-comparison.js";

type Comparison = ReturnType<typeof compareSnapshots>;
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Display exact decimal strings without converting to floating point. */
export function decimal(value: string, scale: number): string {
  const negative = value.startsWith("-");
  const digits = (negative ? value.slice(1) : value).padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}

export function renderComparison(result: Comparison): string {
  const cell = (value: unknown) => `<td>${escape(value)}</td>`;
  const rows = result.rows.map(row => {
    const display = (side: typeof row.left) => !side ? "Missing row" : side.state === "undefined" ? `Undefined: ${side.reason}` : `${decimal(side.value, side.scale)} ${side.currency}`;
    const delta = row.delta_right_minus_left === undefined ? "Not calculated" : `${decimal(row.delta_right_minus_left, row.scale!)} ${row.currency}`;
    return `<tr><th scope="row">${escape(row.key)}</th>${cell(row.status)}${cell(display(row.left))}${cell(display(row.right))}${cell(delta)}</tr>`;
  }).join("\n");
  const conditions = result.conditions ? Object.entries(result.conditions).map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join("") : "";
  const mismatches = result.mismatches.map(key => `<li>${escape(key)}</li>`).join("");
  const assurance = (["left", "right"] as const).map(side => {
    const a = result.assurance[side];
    return `<h3>${escape(side)}: ${escape(a.meaning)}</h3><dl>${Object.entries(a.conditions).map(([key, value]) => `<dt>${escape(key)} (${escape(value.state)})</dt><dd>${escape(value.value ?? "Unknown")}</dd>`).join("")}</dl>${a.missing.length ? `<p>Unknown: ${escape(a.missing.join(", "))}</p>` : ""}<p>Internal execution references (not semantic equality keys): ${escape(JSON.stringify(a.execution))}</p>`;
  }).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenMasu cohort comparison</title></head><body>
<h1>OpenMasu cohort comparison</h1>
<p>Status: ${escape(result.status)}</p>
<p>Differences are right minus left. A numerical difference does not establish its cause.</p>
${result.status === "incomparable" ? `<h2>Incompatible or unknown conditions</h2><p>No numerical comparison was performed.</p><ul>${mismatches}</ul>` : `<h2>Selected conditions</h2><dl>${conditions}</dl>${result.status === "declared_comparison" ? "<p>DECLARED ONLY: equivalence of calculation meaning has not been established.</p>" : ""}<h2>Results</h2><p>${result.rows.length} rows. Missing and undefined values are not zero.</p><table><caption>Exact aggregate comparison</caption><thead><tr><th scope="col">Key</th><th scope="col">Status</th><th scope="col">Left</th><th scope="col">Right</th><th scope="col">Difference</th></tr></thead><tbody>${rows}</tbody></table>`}
<h2>Comparison basis</h2>${assurance}
<h2>Input provenance</h2>
<dl><dt>Left source</dt><dd>${escape(result.provenance.left.source)}</dd><dt>Left normalized SHA-256</dt><dd>${escape(result.provenance.left.sha256)}</dd>
<dt>Right source</dt><dd>${escape(result.provenance.right.source)}</dd><dt>Right normalized SHA-256</dt><dd>${escape(result.provenance.right.sha256)}</dd></dl>
<p>Retain the input snapshots to reproduce this report. Definition-backed means agreement under the saved implementation profile, not authentication of the producer or independent verification of completeness. Declared conditions are not independently verified. This file contains aggregate input values; share it only with intended recipients.</p>
</body></html>\n`;
}
