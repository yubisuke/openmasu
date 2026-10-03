import { comparisonMeaning, comparisonMaturity } from "@openmasu/runtime/metric-comparison";
import { comparisonDigest, parseComparisonContext } from "../cohort-comparison.js";
import type { MetricReportRow } from "../reporting.js";

const maximumCells = 2_000;
type Meaning = NonNullable<ReturnType<typeof comparisonMeaning>>;
export type RetentionObservation = {
  row: MetricReportRow;
  maturity: "window_elapsed" | "conservative_end_not_reached" | "unknown";
  closesAt: string | null;
};
export type RetentionMatrix = {
  dimensions: Record<string, string>;
  meaning: Meaning;
  policyVersions: readonly string[];
  ruleBundle: string;
  ruleBundleHash: string;
  definitionVersion: string;
  watermark: string;
  days: number[];
  cohorts: { date: string; cells: { day: number; observations: RetentionObservation[] }[] }[];
};

function observation(row: MetricReportRow) {
  try {
    const context = parseComparisonContext(row.comparison_context);
    const d = context.definition, meaning = comparisonMeaning(context), date = row.grouping.cohort_date;
    if (!meaning || meaning.calculation !== "active_installations_over_cohort"
        || meaning.window.type !== "activity_day" || meaning.denominator !== "cohort_size"
        || d.value_type !== "ratio" || row.value_type !== "ratio" || row.ratio_scale !== d.ratio_scale
        || row.metric_run_id !== context.metric_run_id || row.input_snapshot_id !== context.input_snapshot_id
        || row.metric_name !== d.metric_name || row.metric_definition_version !== d.metric_definition_version
        || row.rule_bundle_id !== d.rule_bundle_id || row.rule_bundle_hash !== d.rule_bundle_hash
        || row.aggregation_time_zone !== d.aggregation_time_zone
        || !row.policy_versions.includes(`rule_bundle:${d.rule_bundle_version}`)
        || row.superseded || row.reproducibility_status !== "fully_reproducible"
        || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !Number.isFinite(Date.parse(date))
        || new Date(date).toISOString().slice(0, 10) !== date) return undefined;
    const dimensions = Object.fromEntries(Object.entries(row.grouping).filter(([key]) => key !== "cohort_date").sort());
    // Only cohort date and activity day vary. Names and digests identify a saved
    // run, not its meaning; every other meaning/policy field remains in the key.
    const key = comparisonDigest({ meaning: { ...meaning, window: { ...meaning.window, day: null } }, dimensions,
      definitionVersion: d.metric_definition_version, policies: [...row.policy_versions].sort(),
      ruleBundle: [d.rule_bundle_id, d.rule_bundle_version, d.rule_bundle_hash], freshness: row.data_freshness,
      watermark: row.input_received_at_watermark });
    const cutoffKnown = Number.isFinite(Date.parse(row.input_received_at_watermark));
    const maturity = comparisonMaturity(context, row.grouping, row.input_received_at_watermark);
    return { key, date, day: meaning.window.day, dimensions, meaning,
      value: { row, closesAt: cutoffKnown ? maturity.closes_at : null,
        maturity: !cutoffKnown || !maturity.closes_at ? "unknown" : maturity.state === "window_elapsed"
          ? "window_elapsed" : "conservative_end_not_reached" } as RetentionObservation };
  } catch {
    // Legacy or inconsistent saved context remains readable in the ordinary table.
    return undefined;
  }
}

/** Pure, bounded projection of one already-authorized report page. No fetching/calculation. */
export function buildRetentionMatrices(rows: readonly MetricReportRow[], partialPage: boolean) {
  const groups = new Map<string, NonNullable<ReturnType<typeof observation>>[]>();
  let omittedRows = 0;
  for (const row of rows) {
    const item = observation(row);
    if (!item) { omittedRows++; continue; }
    const group = groups.get(item.key) ?? []; group.push(item); groups.set(item.key, group);
  }
  const matrices: RetentionMatrix[] = [];
  let cellCount = 0;
  for (const [, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const days = [...new Set(group.map(item => item.day))].sort((a, b) => a - b);
    const dates = [...new Set(group.map(item => item.date))].sort();
    cellCount += days.length * dates.length;
    if (cellCount > maximumCells) return { matrices: [], omittedRows, partialPage, cellLimitReached: true, maximumCells };
    const first = group[0];
    matrices.push({ dimensions: first.dimensions, meaning: first.meaning,
      policyVersions: first.value.row.policy_versions, ruleBundle: first.value.row.rule_bundle_id,
      ruleBundleHash: first.value.row.rule_bundle_hash, definitionVersion: first.value.row.metric_definition_version,
      watermark: first.value.row.input_received_at_watermark, days,
      cohorts: dates.map(date => ({ date, cells: days.map(day => ({ day,
        observations: group.filter(item => item.date === date && item.day === day).map(item => item.value)
          .sort((a, b) => a.row.metric_run_id.localeCompare(b.row.metric_run_id)),
      })) })),
    });
  }
  return { matrices, omittedRows, partialPage, cellLimitReached: false, maximumCells };
}
