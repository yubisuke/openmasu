import { sha256 } from "@openmasu/attribution-core/canonical";
import type { DailyAcquisitionCase } from "./synthetic-daily-acquisition-cases.js";
type Any = Record<string, any>;

// Kept as synthetic text, not a checked-in tabular export. Integration tests
// write it only into their disposable temporary directories.
export const syntheticCalendarCostCsv = "network,campaign_id,date,reporting_time_zone,as_of,cost_micros,currency\n"
  + "synthetic-network,synthetic-native-68,2026-08-06,America/New_York,2026-08-15T00:00:00.000Z,2000000,USD\n";

/** Hand-counted local-day membership. No evaluator, SQL, Intl, or ZoneInfo is used to derive expectations. */
export function calendarCohortValues(input: Any, revenue = { utc: [0,15,15,15], jst: [3,15,15,63], ny: [1,15,15,31] }): string[] {
  return input.metric_evaluations.flatMap((evaluation: Any) => evaluation.metric_names.map((name: string) => {
    const definition = input.metric_definitions.find((row: Any) => row.metric_name === name);
    const slug = definition.aggregation_time_zone === "UTC" ? "utc" : definition.aggregation_time_zone === "Asia/Tokyo" ? "jst" : "ny";
    const calculation = definition.definition.calculation, day = definition.definition.window.day;
    const amount = definition.calendar_cohort_policy ? revenue[slug][[0,1,3,7].indexOf(day)] : 127;
    const value = calculation === "cohort_size" ? "1" : calculation === "active_installations_over_cohort"
      ? day === 1 || slug !== "utc" || !definition.calendar_cohort_policy ? "1000000" : "0"
      : String(amount * 1_000_000 / (calculation === "revenue_over_cost" ? 2 : 1));
    return { id: `${evaluation.metric_run_id_prefix}:${name}`, value };
  })).sort((a: Any, b: Any) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((row: Any) => row.value);
}

export function syntheticCalendarCohortCases(source: Any): DailyAcquisitionCase[] {
  const make = (name: string, change: (input: Any) => void = () => {}, values?: string[]) => {
    const input = structuredClone(source); change(input);
    return { name, input, expected: values ?? calendarCohortValues(input) };
  };
  const cases = [make("calendar_three_zones_three_bases_cumulative_money_and_on_day_retention"),
    make("calendar_record_cost_definition_and_evaluation_order_is_irrelevant", input => {
      for (const key of ["records","cost_records","metric_definitions","metric_evaluations"]) input[key].reverse();
    })];
  for (const mode of ["missing","different"] as const) {
    const entry = make(`calendar_${mode}_cost_reporting_zone_is_not_allocated`, input => {
      for (const cost of input.cost_records) {
        if (mode === "missing") delete cost.reporting_time_zone;
        else cost.reporting_time_zone = "Asia/Tokyo"; // Select only UTC/NY evaluations below: every row is incompatible.
        cost.dimension_digest = sha256(Object.fromEntries(["network","campaign_id","reporting_time_zone"]
          .filter(key => cost[key] !== undefined).map(key => [key,cost[key]])));
      }
      input.metric_evaluations = input.metric_evaluations.filter((row: Any) => !row.metric_run_id_prefix.endsWith("legacy")
        && (mode === "missing" || !row.metric_run_id_prefix.endsWith("jst")));
    });
    const sorted = entry.input.metric_evaluations.flatMap((e: Any) => e.metric_names.map((name: string) => ({id:`${e.metric_run_id_prefix}:${name}`,name})))
      .sort((a: Any,b: Any)=>a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    entry.expected = entry.expected.map((value,index) => sorted[index].name.endsWith("_roas") ? "no_attributed_cost" : value);
    cases.push(entry);
  }
  const late = make("calendar_late_receipt_changes_money_only_at_a_new_watermark", input => {
    // Apply to all three independent sources so their manual expectations remain the same.
    for (const record of input.records) if (/^revenue-68-.*-1$/.test(record.record_id)) record.received_at = "2026-08-18T00:00:00.000Z";
  });
  late.expected = calendarCohortValues(late.input,{utc:[0,14,14,14],jst:[2,14,14,62],ny:[0,14,14,30]});
  // The historical elapsed LTV is 126, not the unchanged baseline's 127.
  const legacyIndex = late.input.metric_evaluations.flatMap((e: Any)=>e.metric_names.map((name: string)=>`${e.metric_run_id_prefix}:${name}`))
    .sort().findIndex((id: string)=>id === "calendar68-native-legacy:cohort_ltv_d7_usd");
  late.expected[legacyIndex] = "126000000"; cases.push(late);
  for (const period of ["spring","fall","month_end"] as const) {
    const zone = period === "month_end" ? "UTC" : "America/New_York", slug = period === "month_end" ? "utc" : "ny";
    const installAt = period === "spring" ? "2026-03-08T04:59:00.000Z" : period === "fall" ? "2026-11-01T03:59:00.000Z" : "2026-01-31T23:59:00.000Z";
    const day = period === "spring" ? "2026-03-07" : period === "fall" ? "2026-10-31" : "2026-01-31";
    const start = period === "spring" ? "2026-03-08T05:00:00.000Z" : period === "fall" ? "2026-11-01T04:00:00.000Z" : "2026-02-01T00:00:00.000Z";
    const end = period === "spring" ? "2026-03-09T04:00:00.000Z" : period === "fall" ? "2026-11-02T05:00:00.000Z" : "2026-02-02T00:00:00.000Z";
    const entry = make(`calendar_${period}_exclusive_midnight_and_distinct_local_day_activity`, input => {
      input.records = input.records.filter((row: Any) => row.record_id === "click-68" || row.record_id === "native-68"
        || /^revenue-68-native-[0-3]$/.test(row.record_id) || /^session-68-native-[0-1]$/.test(row.record_id));
      input.platform_acquisition_inputs = [];
      input.server_context.received_at = "2026-11-04T00:00:00.000Z";
      for (const record of input.records) record.received_at = input.server_context.received_at;
      const click = input.records.find((row: Any) => row.record_id === "click-68");
      click.occurred_at = new Date(Date.parse(installAt)-3_600_000).toISOString(); click.payload.redirector_click_at = click.occurred_at;
      const install = input.records.find((row: Any)=>row.record_id === "native-68");
      install.occurred_at = installAt; install.payload.install_begin_at_server = installAt;
      [new Date(Date.parse(installAt)-60_000).toISOString(),start,new Date(Date.parse(end)-1).toISOString(),end].forEach((time,index) => {
        const record = input.records.find((row: Any)=>row.record_id === `revenue-68-native-${index}`);
        record.occurred_at = time; record.payload.amount_unscaled = ["100000000","1000000","2000000","4000000"][index];
      });
      input.records.filter((row: Any)=>row.event_name === "session_start").forEach((row: Any,index: number)=>{
        row.occurred_at = period === "fall" ? index === 0 ? "2026-11-01T05:30:00.000Z" : "2026-11-01T06:30:00.000Z"
          : index === 0 ? start : new Date(Date.parse(end)-1).toISOString();
      });
      input.metric_definitions = input.metric_definitions.filter((row: Any)=>[`${slug === "utc" ? "calendar_utc" : "calendar_ny"}_cohort_ltv_d1_usd`,
        `calendar_${slug}_d1_roas`,`calendar_${slug}_retention_d1`].includes(row.metric_name));
      input.metric_evaluations = [{metric_run_id_prefix:`calendar68-${period}`,input_received_at_watermark:"2026-11-05T00:00:00.000Z",computed_at:"2026-11-05T00:00:00.000Z",
        data_freshness:"complete",privacy_state:"after",metric_names:input.metric_definitions.map((row: Any)=>row.metric_name),
        grouping:{cohort_date:day,campaign_id:"synthetic-native-68",network:"synthetic-network",attribution_status:"non_organic"}}];
      const cost = input.cost_records.find((row: Any)=>row.cost_record_id === `cost-68-native-${slug}`);
      cost.date = day; cost.as_of = "2026-01-01T00:00:00.000Z"; cost.reporting_time_zone = zone; input.cost_records = [cost];
    },["3000000","1500000","1000000"]);
    cases.push(entry);
  }
  return cases;
}
