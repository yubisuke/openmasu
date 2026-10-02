import { jcs } from "@openmasu/attribution-core";
import { snapshotAssurance, type ComparisonResult } from "../cohort-comparison.js";
import type { ComparisonPair } from "../dashboard-comparison.js";
import { escapeHtml as escape } from "./render.js";
import { renderComparisonContent } from "./comparison-report.js";

export function renderComparisonWorkflow(appId: string, csrf: string, pair?: ComparisonPair, result?: ComparisonResult, allowExternalDeclaration = false): string {
  const path = `/dashboard/apps/${encodeURIComponent(appId)}/comparison`;
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${escape(value)}">`;
  const token = hidden("csrf_token", csrf);
  const start = `<p><a href="/dashboard/apps/${encodeURIComponent(appId)}">Back to app</a> · <a href="${path}">Choose new inputs</a></p>`;
  let content: string;
  if (!pair) {
    content = `<h1>Compare saved measurements</h1><p>Choose a saved OpenMasu comparison JSON, an external aggregate CSV and its explicit mapping JSON. Review the calculation conditions before comparing. Each input is limited to 4 MiB and 10,000 rows. Processing is limited to 30 seconds. Files and comparison history are not saved on the server.</p><form method="post" enctype="multipart/form-data" action="${path}">${token}<label>Saved comparison JSON <input type="file" name="saved_json" accept=".json,application/json" required></label><label>External aggregate CSV <input type="file" name="external_csv" accept=".csv,text/csv" required></label><label>CSV mapping JSON <input type="file" name="mapping_json" accept=".json,application/json" required></label><button type="submit" name="action" value="review">Review conditions</button></form><p>Use the explicit external calculation declaration for install-anchored elapsed ad-revenue ROAS. Unknown meaning will remain incomparable. Upload only files you are authorized to compare. Producer authenticity, completeness and causes are not inferred.</p>`;
  } else {
    const fields = token + hidden("left", jcs(pair.left)) + hidden("right", jcs(pair.right));
    if (result) {
      content = `${renderComparisonContent(result)}<form method="post" enctype="multipart/form-data" action="${path}">${fields}${allowExternalDeclaration ? hidden("external_opt_in", "yes") : ""}<button type="submit" name="action" value="json">Save comparison JSON</button><button type="submit" name="action" value="html">Save standalone HTML</button></form>`;
    } else {
      const basis = (["left", "right"] as const).map(side => {
        const snapshot = pair[side], { assurance } = snapshotAssurance(snapshot);
        const context = snapshot.external_calculation ?? snapshot.comparison_contexts ?? [];
        return `<section><h2>${side === "left" ? "Saved input" : "External input"}: ${escape(snapshot.source)}</h2><p>Meaning: ${escape(assurance.meaning)}. Rows: ${snapshot.rows.length}. Acquisition: ${escape(assurance.acquisition.state)}. Upstream completeness: unknown.</p><dl>${Object.entries(assurance.conditions).map(([key, value]) => `<dt>${escape(key)} (${escape(value.state)})</dt><dd>${escape(value.value ?? "unknown")}</dd>`).join("")}</dl>${assurance.missing.length ? `<p>Unresolved: ${escape(assurance.missing.join(", "))}</p>` : ""}<details><summary>Calculation conditions and provenance</summary><pre>${escape(jcs({ basis: context, report: snapshot.provenance ?? null, csv_mapping: snapshot.mapping_provenance ?? null }))}</pre></details></section>`;
      }).join("");
      content = `<h1>Review comparison conditions</h1><p>No numerical comparison has been performed. A saved definition and an external operator declaration have different evidence levels. An app-scoped receipt must match this app; receipt-less inputs are not certified as originating from it.</p>${basis}<form method="post" enctype="multipart/form-data" action="${path}">${fields}<label><input type="checkbox" name="external_opt_in" value="yes"> I explicitly accept comparison with the external operator declaration, not independent verification.</label><button type="submit" name="action" value="result">Compare</button></form><p>Only normalized aggregate snapshots are carried to the next form. Inputs are revalidated on every submission. Missing, undefined and zero stay distinct. Incompatible or unknown conditions produce no delta.</p>`;
    }
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>OpenMasu comparison</title><link rel="stylesheet" href="/dashboard/app.css"></head><body><main>${start}${content}</main></body></html>`;
}
