import { jcs } from "@openmasu/attribution-core/canonical";
import { comparisonMeaning } from "./metric-comparison.js";
import type { Snapshot } from "./comparison-model.js";
import type { ComparisonResult, ComparisonRow } from "./cohort-comparison.js";

type ValueType = "money" | "count" | "ratio" | "unknown";
type Exclusion = "comparison_unavailable" | "meaning_unknown" | "ratio_not_additive" | "daily_unique_not_additive"
  | "calculation_not_additive" | "overlapping_or_unproven_grain" | "cost_overlap_unproven" | "mixed_currency"
  | "missing_or_undefined_operand";
type Source = { source_sha256: string; metric_run_id?: string; input_snapshot_id?: string; report_sha256?: string };
export type ComparisonSummary = {
  version: 1; top_limit: 10;
  counts: { equal: number; different: number; missing: number; missing_left: number; missing_right: number; undefined: number; currency_mismatch: number };
  partitions: { value_type: ValueType; currency: string; row_count: number;
    top_differences: { key: string; row_index: number; delta_right_minus_left: string; absolute_delta: string; scale: number; left: Source; right: Source }[];
    contribution: { state: "excluded"; reasons: Exclusion[] } | { state: "present"; scale: number;
      left: string; right: string; delta_right_minus_left: string; absolute_delta_sum: string };
  }[];
};
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const absolute = (value: bigint) => value < 0n ? -value : value;
const scaled = (value: string, scale: number, target: number) => BigInt(value) * 10n ** BigInt(target - scale);

/** Only validated snapshots reach this projection; no provider/population inference. */
export function summarizeComparison(a: Snapshot, b: Snapshot, result: Omit<ComparisonResult, "summary">): ComparisonSummary {
  const meaning = (snapshot: Snapshot) => snapshot.external_calculation?.declaration
    ?? (snapshot.comparison_contexts?.[0] && comparisonMeaning(snapshot.comparison_contexts[0].context));
  const leftMeaning = meaning(a), rightMeaning = meaning(b);
  const established = ["compared", "external_declared_comparison"].includes(result.status);
  const unit: ValueType = established && leftMeaning?.value_type === rightMeaning?.value_type
    && ["money", "count", "ratio"].includes(leftMeaning?.value_type ?? "") ? leftMeaning!.value_type as ValueType : "unknown";
  const reasons: Exclusion[] = [];
  if (result.status === "incomparable") reasons.push("comparison_unavailable");
  if (!established || !leftMeaning || !rightMeaning) reasons.push("meaning_unknown");
  else if (unit === "ratio") reasons.push("ratio_not_additive");
  else if (leftMeaning.calculation === "active_installations_count") reasons.push("daily_unique_not_additive");
  else if (!(unit === "money" && ["revenue_sum", "cost_sum"].includes(leftMeaning.calculation)
      || unit === "count" && ["cohort_size", "event_count"].includes(leftMeaning.calculation))
      || leftMeaning.denominator != null) reasons.push("calculation_not_additive");
  else {
    // Cohort-date populations and ordinary event-date partitions are exclusive.
    // Do not sum rollups together with detail rows, unknown axes or engagements.
    const anchor = leftMeaning.calculation === "event_count" ? "metric_date" : "cohort_date";
    const axes = new Set(leftMeaning.grouping_dimensions);
    const knownAxes = new Set([anchor, "campaign_id", "network", "country", "attribution_status", "ad_group_id", "creative_id", "acquisition_campaign_state"]);
    const grains = new Set<string>();
    let proven = leftMeaning.anchor_event === (anchor === "metric_date" ? "calendar_day" : "install");
    for (const row of result.rows) {
      try {
        const group = JSON.parse(row.key), keys = Object.keys(group).sort();
        if (jcs(group) !== row.key || !keys.includes(anchor) || keys.some(key => !axes.has(key) || !knownAxes.has(key))
            || Object.values(group).some(value => typeof value !== "string" || !value)) proven = false;
        grains.add(jcs(keys));
      } catch { proven = false; }
    }
    if (!proven || grains.size !== 1) reasons.push("overlapping_or_unproven_grain");
    if (leftMeaning.calculation === "cost_sum" && leftMeaning.cost_selection_policy !== "reject_overlapping_grains") reasons.push("cost_overlap_unproven");
  }
  const currencies = new Set(result.rows.flatMap(row => [row.left?.currency, row.right?.currency].filter(value => value !== undefined)));
  if (currencies.size > 1) reasons.push("mixed_currency");
  if (result.rows.some(row => !["equal", "different"].includes(row.status))) reasons.push("missing_or_undefined_operand");
  const counts: ComparisonSummary["counts"] = { equal: 0, different: 0, missing: 0, missing_left: 0, missing_right: 0, undefined: 0, currency_mismatch: 0 };
  const groups = new Map<string, { row: ComparisonRow; index: number }[]>();
  for (const [index, row] of result.rows.entries()) {
    if (row.status in counts) counts[row.status as keyof typeof counts]++;
    if (row.status === "missing_left" || row.status === "missing_right") counts.missing++;
    // A currency mismatch has no delta and belongs to neither ranking.
    if (row.status === "currency_mismatch") continue;
    const currency = row.left?.currency ?? row.right!.currency, entries = groups.get(currency) ?? [];
    entries.push({ row, index }); groups.set(currency, entries);
  }
  const refs = [a, b].map(snapshot => new Map(snapshot.provenance?.runs.map(run => [run.key, run]) ?? []));
  const source = (side: "left" | "right", key: string): Source => {
    const p = result.provenance[side], ref = refs[side === "left" ? 0 : 1].get(key);
    return { source_sha256: p.sha256, ...(p.saved_report ? { report_sha256: p.saved_report.report_sha256 } : {}),
      ...(ref ? { metric_run_id: ref.metric_run_id, input_snapshot_id: ref.input_snapshot_id } : {}) };
  };
  return { version: 1, top_limit: 10, counts, partitions: [...groups].sort(([x], [y]) => order(x, y)).map(([currency, entries]) => {
    const ranked = entries.filter(({ row }) => row.status === "different").sort((x, y) => {
      const scale = Math.max(x.row.scale!, y.row.scale!);
      const diff = absolute(scaled(y.row.delta_right_minus_left!, y.row.scale!, scale)) - absolute(scaled(x.row.delta_right_minus_left!, x.row.scale!, scale));
      return diff < 0n ? -1 : diff > 0n ? 1 : order(x.row.key, y.row.key);
    });
    const top = ranked.slice(0, 10).map(({ row, index }) => ({ key: row.key, row_index: index,
      delta_right_minus_left: row.delta_right_minus_left!, absolute_delta: absolute(BigInt(row.delta_right_minus_left!)).toString(), scale: row.scale!,
      left: source("left", row.key), right: source("right", row.key) }));
    let contribution: ComparisonSummary["partitions"][number]["contribution"] = { state: "excluded", reasons: [...reasons] };
    if (!reasons.length) {
      const scale = Math.max(...entries.map(({ row }) => row.scale!));
      let left = 0n, right = 0n, magnitude = 0n;
      for (const { row } of entries) {
        if (row.left?.state !== "present" || row.right?.state !== "present") continue;
        left += scaled(row.left.value, row.left.scale, scale); right += scaled(row.right.value, row.right.scale, scale);
        magnitude += absolute(scaled(row.delta_right_minus_left!, row.scale!, scale));
      }
      contribution = { state: "present", scale, left: left.toString(), right: right.toString(),
        delta_right_minus_left: (right - left).toString(), absolute_delta_sum: magnitude.toString() };
    }
    return { value_type: unit, currency, row_count: entries.length, top_differences: top, contribution };
  }) };
}
