import { roundHalfEven } from "@openmasu/attribution-core";
import { ACQUISITION_KPI_ROLES, acquisitionKpiRole, type AcquisitionKpiRole } from "@openmasu/contracts/definitions";
import { comparisonMeaning } from "@openmasu/runtime/metric-comparison";
import { buildAcquisitionKpiSets, type AcquisitionKpiScope } from "./acquisition-kpis.js";
import { comparisonDigest, parseComparisonContext } from "./cohort-comparison.js";
import { exactDecimal } from "./dashboard/metric-value.js";
import type { MetricReportRow } from "./reporting.js";

const additiveRoles = ["installs", "cost", "ad_revenue", "purchase_net", "total_net"] as const;
export type AcquisitionPeriodValue = {
  state: "present" | "undefined"; value_unscaled: string | null; reason: string | null;
  value_type: "count" | "money" | "ratio"; currency: string | null; scale: number; label: string;
};
export type AcquisitionPeriodSide = {
  date_from: string; date_to: string; expected_days: number; observed_days: number;
  state: "ready" | "blocked"; reason: string | null; selection_digest: string; meaning_digest: string | null;
  values: Record<AcquisitionKpiRole, AcquisitionPeriodValue> | null;
  sources: { date: string; set_keys: string[]; runs: {
    role: AcquisitionKpiRole; run_id: string; snapshot_id: string; watermark: string; grouping_digest: string;
  }[] }[];
};
type Comparison = { status: "compared" | "incomparable"; reason: string | null; delta_current_minus_previous: string | null };
export type AcquisitionPeriodSummary = {
  dimensions: Record<string, string>; current: AcquisitionPeriodSide; previous: AcquisitionPeriodSide;
  comparisons: Record<AcquisitionKpiRole, Comparison>;
};

const dimensionsOf = (row: MetricReportRow) => Object.fromEntries(Object.entries(row.grouping)
  .filter(([key]) => key !== "cohort_date" && key !== "metric_date").sort());

/** Only complete, compatible native D7 sets can supply period operands. */
function side(scope: AcquisitionKpiScope, from: string, to: string, rows: readonly MetricReportRow[]): AcquisitionPeriodSide {
  const expectedDays = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  const days = Array.from({ length: expectedDays }, (_, i) => new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10));
  const { sets, omittedRows } = buildAcquisitionKpiSets(rows, false, scope);
  const byDay = new Map<string, MetricReportRow[]>();
  for (const row of rows) {
    const date = row.grouping.cohort_date;
    const group = byDay.get(date) ?? []; group.push(row); byDay.set(date, group);
  }
  const result: AcquisitionPeriodSide = {
    date_from: from, date_to: to, expected_days: expectedDays, observed_days: byDay.size,
    state: "blocked", reason: null, selection_digest: comparisonDigest({ from, to, rows }), meaning_digest: null, values: null,
    sources: [...byDay].sort(([a], [b]) => a.localeCompare(b, "en")).map(([date, daily]) => ({ date,
      set_keys: sets.filter(set => set.grouping.cohort_date === date).map(set => set.key),
      runs: daily.map(row => ({ role: acquisitionKpiRole(row.metric_name)!, run_id: row.metric_run_id,
        snapshot_id: row.input_snapshot_id, watermark: row.input_received_at_watermark, grouping_digest: row.grouping_digest })) })),
  };
  const block = (reason: string) => { result.reason = reason; return result; };
  if (days.some(date => !byDay.has(date))) return block("missing_day");
  if ([...byDay.keys()].some(date => !days.includes(date)) || rows.some(row => row.grouping.metric_date !== undefined)) {
    return block("invalid_cohort_date_grain");
  }
  if ([...byDay.values()].some(daily => ACQUISITION_KPI_ROLES.some(role => daily.filter(row => acquisitionKpiRole(row.metric_name) === role).length > 1))) {
    return block("multiple_daily_sets");
  }
  if (omittedRows || sets.length !== expectedDays || days.some(date => sets.filter(set => set.grouping.cohort_date === date).length !== 1)) {
    return block("acquisition_set_incomplete_or_incompatible");
  }
  const blocked = sets.find(set => set.reason);
  if (blocked) return block(blocked.reason!);

  // Compare each role with itself, not with the other seven definitions. The
  // context projection excludes run/snapshot/date/cutoff but retains FX and all
  // semantic dimensions, including fraud/privacy/window/grain and policy.
  const meanings = sets.map(set => Object.fromEntries(ACQUISITION_KPI_ROLES.map(role => {
    const row = set.rows[role], context = parseComparisonContext(row.comparison_context), d = context.definition;
    return [role, { meaning: comparisonMeaning(context), definitionVersion: d.metric_definition_version,
      bundle: [d.rule_bundle_id, d.rule_bundle_version, d.rule_bundle_hash], policies: [...row.policy_versions].sort() }];
  })));
  const meaningDigest = comparisonDigest(meanings[0]);
  if (meanings.some(meaning => comparisonDigest(meaning) !== meaningDigest)) return block("meaning_fx_or_basis_mismatch");
  result.meaning_digest = meaningDigest;
  const unavailableOperand = sets.flatMap(set => additiveRoles.map(role => set.rows[role])).find(row => row.value_state !== "present");
  if (unavailableOperand) return block(unavailableOperand.unavailable_reason ?? unavailableOperand.undefined_reason ?? "operand_unavailable");
  const first = sets[0].rows;
  if (first.ad_roas.ratio_scale !== 6 || first.total_roas.ratio_scale !== 6) return block("unsupported_ratio_scale");
  const sums = Object.fromEntries(additiveRoles.map(role => [role,
    sets.reduce((total, set) => total + BigInt(set.rows[role].value_unscaled!), 0n)])) as Record<typeof additiveRoles[number], bigint>;
  if (sums.installs < 0n || sums.cost < 0n) return block("invalid_denominator");
  const integers: Record<AcquisitionKpiRole, bigint | null> = { ...sums,
    cpi: sums.installs === 0n ? null : roundHalfEven(sums.cost, sums.installs),
    ad_roas: sums.cost === 0n ? null : roundHalfEven(sums.ad_revenue * 1_000_000n, sums.cost),
    total_roas: sums.cost === 0n ? null : roundHalfEven(sums.total_net * 1_000_000n, sums.cost),
  };
  result.values = Object.fromEntries(ACQUISITION_KPI_ROLES.map(role => {
    const d = parseComparisonContext(first[role].comparison_context).definition;
    const integer = integers[role], reason = integer === null ? role === "cpi" ? "empty_cohort" : "no_attributed_cost" : null;
    const currency = d.currency ?? null, scale = d.value_type === "count" ? 0 : d.amount_scale ?? d.ratio_scale!;
    const value = integer?.toString() ?? null;
    const label = value === null ? `— (${reason})` : d.value_type === "money" ? `${currency} ${exactDecimal(value, scale)}`
      : d.value_type === "ratio" ? `${exactDecimal(value, scale)} ×` : `${value} installations`;
    return [role, { state: value === null ? "undefined" : "present", value_unscaled: value, reason,
      value_type: d.value_type, currency, scale, label }];
  })) as Record<AcquisitionKpiRole, AcquisitionPeriodValue>;
  result.state = "ready";
  return result;
}

/** A read-time summary, not a new saved metric run or an unweighted ratio mean. */
export function buildAcquisitionPeriods(scope: AcquisitionKpiScope, currentRange: readonly [string, string], previousRange: readonly [string, string],
  current: readonly MetricReportRow[], previous: readonly MetricReportRow[]): AcquisitionPeriodSummary[] {
  const groups = new Map<string, { dimensions: Record<string, string>; current: MetricReportRow[]; previous: MetricReportRow[] }>();
  for (const [which, rows] of [["current", current], ["previous", previous]] as const) {
    for (const row of rows) {
      if (!acquisitionKpiRole(row.metric_name)) continue;
      const dimensions = dimensionsOf(row), key = JSON.stringify(dimensions);
      const group = groups.get(key) ?? { dimensions, current: [], previous: [] };
      group[which].push(row); groups.set(key, group);
    }
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b, "en")).map(([, group]) => {
    const a = side(scope, ...currentRange, group.current), b = side(scope, ...previousRange, group.previous);
    const reason = a.reason ?? b.reason ?? (a.meaning_digest !== b.meaning_digest ? "meaning_fx_or_basis_mismatch" : null);
    const comparisons = Object.fromEntries(ACQUISITION_KPI_ROLES.map(role => {
      const av = a.values?.[role], bv = b.values?.[role], why = reason ?? av?.reason ?? bv?.reason ?? null;
      return [role, { status: why ? "incomparable" : "compared", reason: why,
        delta_current_minus_previous: why ? null : (BigInt(av!.value_unscaled!) - BigInt(bv!.value_unscaled!)).toString() }];
    })) as Record<AcquisitionKpiRole, Comparison>;
    return { dimensions: group.dimensions, current: a, previous: b, comparisons };
  });
}

/** Both presentation adapters consume the same calculated values and reasons. */
export function acquisitionPeriodRows(summaries: readonly AcquisitionPeriodSummary[], display: "all" | "exceptions") {
  return summaries.flatMap(summary => ACQUISITION_KPI_ROLES.map(role => ({ summary, role,
    metric_name: `acquisition_d7_${role}`, current: summary.current.values?.[role] ?? null,
    previous: summary.previous.values?.[role] ?? null, ...summary.comparisons[role],
  }))).filter(row => display === "all" || row.status !== "compared");
}
