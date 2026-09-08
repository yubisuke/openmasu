import type { MetricReportRow } from "../reporting.js";

/** A trend never combines dimensions, currencies, definitions or historical replacements. */
export function metricCharts(rows: readonly MetricReportRow[]) {
  const groups = new Map<string, MetricReportRow[]>();
  for (const row of rows) {
    const dateKey = row.grouping.metric_date ? "metric_date" : row.grouping.cohort_date ? "cohort_date" : undefined;
    const dimensions = Object.entries(row.grouping).filter(([key]) => key !== dateKey).sort();
    const key = JSON.stringify([row.metric_name, dimensions, dateKey, row.value_type, row.currency,
      row.amount_scale, row.ratio_scale, row.metric_definition_version, row.policy_versions,
      row.rule_bundle_id, row.rule_bundle_hash, row.aggregation_time_zone,
      row.data_freshness, row.reproducibility_status, row.input_received_at_watermark, row.superseded ? row.metric_run_id : null,
      dateKey ? null : row.metric_run_id]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) => {
    const date = (row: MetricReportRow) => row.grouping.metric_date ?? row.grouping.cohort_date ?? "";
    group.sort((a, b) => date(a).localeCompare(date(b)) || a.metric_run_id.localeCompare(b.metric_run_id));
    // Multiple snapshots at the same date have no unique time-series interpretation.
    const ambiguous = new Set(group.map(date)).size !== group.length;
    return (ambiguous ? group.map((row) => [row]) : [group]).map((seriesRows) => {
      const first = seriesRows[0];
      const series: (number | undefined)[] = [];
      let previous = "";
      for (const row of seriesRows) {
        if (previous && Date.parse(date(row)) - Date.parse(previous) > 86_400_000) series.push(undefined);
        const value = row.value_state === "present" && row.value_unscaled !== undefined ? Number(row.value_unscaled) : NaN;
        series.push(Number.isSafeInteger(value) ? value : undefined);
        previous = date(row);
      }
      return {
        metric_name: first.metric_name,
        label: `${first.metric_name}; ${JSON.stringify(first.grouping)}; ${first.currency ?? first.value_type}; definition ${first.metric_definition_version}; ${first.superseded ? "superseded" : "current"}; ${date(first)} to ${date(seriesRows.at(-1)!)} (equal observation spacing)`,
        series,
      };
    });
  });
}
