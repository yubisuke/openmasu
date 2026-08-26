import { resolve } from "node:path";
import { buildImportCompatibilityReport, type ImportCompatibilityReport } from "./compatibility.js";
import {
  analyzeManualCostImport,
  buildManualCostCompatibilityReport,
  type ManualCostCompatibilityReport,
  type ManualCostRejection,
} from "./cost-compatibility.js";
import { loadMapping } from "./mapping.js";
import { ImportLimitError } from "./source.js";
import { analyzeMmpImport, resolveMappingPath, type ImportPreviewSummary } from "./runner.js";

export type ImportCompatibilityOutput = {
  mode: "compatibility_report";
  persistence: "none";
  mapping_version: string;
  format: ImportPreviewSummary["format"];
  rows: ImportPreviewSummary["rows"];
  warnings: ImportPreviewSummary["warnings"];
  rejections: ImportPreviewSummary["rejections"];
  compatibility: ImportCompatibilityReport;
  limitations: string[];
};

export type ManualCostCompatibilityOutput = {
  mode: "compatibility_report";
  persistence: "none";
  mapping_version: string;
  format: ImportPreviewSummary["format"];
  rows: ImportPreviewSummary["rows"];
  warnings: [];
  rejections: ManualCostRejection[];
  compatibility: ManualCostCompatibilityReport;
  limitations: string[];
};

export function reportMmpImportCompatibility(options: Parameters<typeof analyzeMmpImport>[0]): ImportCompatibilityOutput {
  const analysis = analyzeMmpImport(options);
  const { preview } = analysis;
  return {
    mode: "compatibility_report",
    persistence: "none",
    mapping_version: preview.mapping_version,
    format: preview.format,
    rows: preview.rows,
    warnings: preview.warnings,
    rejections: preview.rejections,
    compatibility: buildImportCompatibilityReport({
      mapping: analysis.mapping,
      rows: preview.rows,
      warningCount: preview.warnings.length,
      eventIdNamespaceEvaluated: options.lintDirectory !== undefined,
      rejections: preview.rejections,
      observedFieldCounts: analysis.observedFieldCounts,
    }),
    limitations: [
      ...preview.limitations,
      ...(options.lintDirectory === undefined ? ["sibling_mapping_identity_conflicts_not_checked"] : []),
      ...(analysis.mapping.rules.find(({ target }) => target === "event_name")?.expression.const === undefined
        ? ["row_derived_event_schema_coverage_not_aggregated"] : []),
    ],
  };
}

export function reportManualCostCompatibility(options: {
  mappingPath: string;
  filePath: string;
  limits?: Parameters<typeof analyzeManualCostImport>[0]["limits"];
}): ManualCostCompatibilityOutput {
  const analysis = analyzeManualCostImport(options);
  return {
    mode: "compatibility_report",
    persistence: "none",
    mapping_version: analysis.mapping.version,
    format: analysis.mapping.format,
    rows: analysis.rows,
    warnings: [],
    rejections: analysis.rejections,
    compatibility: buildManualCostCompatibilityReport(analysis),
    limitations: [
      "database_dimension_conflicts_not_checked",
      "provider_connectivity_not_checked",
      "metric_equivalence_not_checked",
    ],
  };
}

export function reportImportCompatibility(options: Parameters<typeof analyzeMmpImport>[0]):
ImportCompatibilityOutput | ManualCostCompatibilityOutput {
  const mapping = loadMapping(options.mappingPath);
  return mapping.kind === "manual_cost"
    ? reportManualCostCompatibility(options)
    : reportMmpImportCompatibility(options);
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const source = argument("source");
  const file = argument("file");
  const lintDirectory = argument("lint-directory");
  if (!source || !file) {
    throw new Error("usage: npm run import:compatibility -- --source=<mapping-path> --file=<path>");
  }
  try {
    console.log(JSON.stringify(reportImportCompatibility({
      mappingPath: resolveMappingPath(source),
      filePath: resolve(file),
      lintDirectory,
    })));
  } catch (error) {
    if (error instanceof ImportLimitError) console.error(`Import compatibility refused: ${error.message}`);
    throw error;
  }
}
