import { DISJOINT_COST_METRIC_DEFINITIONS, SELECTED_ACQUISITION_METRIC_DEFINITIONS,
  SELECTED_COMMERCE_METRIC_DEFINITIONS } from "@openmasu/contracts/definitions";
import { sha256 } from "@openmasu/attribution-core/canonical";

type Any = Record<string, any>;
export type SyntheticFxCase = { name: string; input: Any; expected: string[] };

/** Synthetic input construction only. Expected arithmetic never calls an evaluator. */
export function syntheticDatedFxFixture(baseline: Any): Any {
  const value = structuredClone(baseline);
  const click = value.records.find((r: Any) => r.event_name === "click");
  const install = value.records.find((r: Any) => r.event_name === "install");
  const revenue = value.records.find((r: Any) => r.event_name === "ad_revenue");
  const identify = (row: Any, id: string) => Object.assign(row, { record_id: id, delivery_id: `delivery:${id}`, event_id: `event:${id}` });
  identify(click, "fx69-click"); identify(install, "fx69-install");
  Object.assign(click.payload, { campaign_id: "fx69-campaign", tracking_link_id: "fx69-link", click_id: "click-fx69_0000000000000000" });
  Object.assign(install.payload, { installation_id: "installation:fx69", click_id: click.payload.click_id,
    protected_referrer_evidence_ref: "protected:referrer:fx69-install" });
  const revenueRows = [
    ["jpy-even", "JPY", "1", "2026-08-06T01:00:00.000Z"],
    ["jpy-odd", "JPY", "3", "2026-08-06T02:00:00.000Z"],
    ["eur", "EUR", "1", "2026-08-06T03:00:00.000Z"],
    ["usd", "USD", "1", "2026-08-06T04:00:00.000Z"],
    ["jpy-next", "JPY", "2", "2026-08-07T01:00:00.000Z"],
    ["eur-next", "EUR", "1", "2026-08-07T02:00:00.000Z"],
  ].map(([id, currency, amount, occurred_at], index) => {
    const row = structuredClone(revenue); identify(row, `fx69-revenue-${id}`);
    Object.assign(row, { occurred_at, processing_sequence: index + 2 });
    Object.assign(row.payload, { currency, amount_unscaled: amount, amount_scale: 0, installation_id: install.payload.installation_id });
    return row;
  });
  const session = structuredClone(install); identify(session, "fx69-session");
  Object.assign(session, { event_name: "session_start", occurred_at: "2026-08-07T04:00:00.000Z", processing_sequence: 8,
    payload: { event_name: "session_start", installation_id: install.payload.installation_id, session_id: "fx69-session" } });
  value.records = [click, install, ...revenueRows, session];
  value.fx_policy = { policy_version: "0.4.22", rate_selection: "utc_event_date_and_cost_date",
    target_currency: "USD", target_scale: 6, rounding_mode: "half_even", rates: [
      ["EUR", "2026-08-06", "12", 1, "2026-08-12T00:00:00.000Z"],
      ["EUR", "2026-08-07", "15", 1, "2026-08-13T00:00:00.000Z"],
      ["JPY", "2026-08-06", "5", 7, "2026-08-12T00:00:00.000Z"],
      ["JPY", "2026-08-07", "75", 8, "2026-08-12T00:00:00.000Z"],
      ["USD", "2026-08-06", "1", 0, "2026-08-12T00:00:00.000Z"],
    ].map(([currency,effective_date,rate_unscaled,rate_scale,as_of]) => ({
      currency,effective_date,rate_unscaled,rate_scale,as_of,source:"synthetic-fx-snapshot-69",
    })) };
  value.metric_definitions = structuredClone([
    ...DISJOINT_COST_METRIC_DEFINITIONS.filter(d => ["d0_roas","d7_roas"].includes(d.metric_name)),
    ...SELECTED_ACQUISITION_METRIC_DEFINITIONS.filter(d => ["cohort_ltv_d1_usd","retention_d1","cohort_install_count"].includes(d.metric_name)),
  ]);
  value.metric_evaluations = ["early","late"].map((label,index) => ({
    metric_run_id_prefix:`fx69-${label}`, input_received_at_watermark:`2026-08-${12+index}T00:00:00.000Z`,
    computed_at:`2026-08-${12+index}T00:00:00.000Z`, data_freshness:index ? "recalculated" : "complete", privacy_state:"before",
    metric_names:["d0_roas","d7_roas","cohort_ltv_d1_usd","retention_d1","cohort_install_count"],
    grouping:{campaign_id:"fx69-campaign",network:"synthetic-network",cohort_date:"2026-08-06"},
  }));
  value.cost_records = [["JPY","JP","2"],["EUR","FR","1"],["USD","US","1"]].map(([currency,country,amount]) => {
    const dimensions = {network:"synthetic-network",campaign_id:"fx69-campaign",country};
    return { contract_version:"0.4.0",cost_record_id:`fx69-cost-${currency.toLowerCase()}`,tenant_id:"tenant-a",app_id:"app-a",
      ...dimensions,date:"2026-08-06",amount_unscaled:amount,amount_scale:0,currency,source:"imported_reported",
      as_of:"2026-08-12T00:00:00.000Z",dimension_digest:sha256(dimensions),report_snapshot_digest:sha256({synthetic_cost:currency,country,amount}) };
  });
  return value;
}

export const datedFxFixtureValues = ["1","missing_fx_rate","1000000","missing_fx_rate","1000000",
  "1","3700004","1000000","1681819","1000000"];

export function syntheticFxCases(source: Any): SyntheticFxCase[] {
  const late = (name: string) => {
    const input = structuredClone(source); input.metric_evaluations = [input.metric_evaluations[1]];
    input.metric_evaluations[0].metric_run_id_prefix = name;
    return input;
  };
  const missingRevenue = late("fx-missing-revenue");
  missingRevenue.fx_policy.rates = missingRevenue.fx_policy.rates.filter((r: Any) => !(r.currency === "EUR" && r.effective_date === "2026-08-06"));
  const missingCost = late("fx-missing-cost"); missingCost.cost_records[0].currency = "GBP";
  const missingDay = late("fx-missing-day");
  missingDay.fx_policy.rates = missingDay.fx_policy.rates.filter((r: Any) => !(r.currency === "JPY" && r.effective_date === "2026-08-07"));
  const big = late("fx-huge-integer");
  big.records = big.records.filter((r: Any) => r.event_name !== "ad_revenue" || r.payload.currency === "USD");
  Object.assign(big.records.find((r: Any) => r.event_name === "ad_revenue").payload, {amount_unscaled:"9007199254740993",amount_scale:6});
  big.metric_evaluations[0].metric_names = ["cohort_ltv_d1_usd"];
  const identity = structuredClone(big); identity.metric_evaluations[0].metric_run_id_prefix = "fx-explicit-identity";
  identity.records.find((r: Any) => r.event_name === "ad_revenue").payload.amount_unscaled = "1000001";
  const absentIdentity = structuredClone(identity); absentIdentity.metric_evaluations[0].metric_run_id_prefix = "fx-no-inferred-identity";
  absentIdentity.fx_policy.rates = absentIdentity.fx_policy.rates.filter((r: Any) => r.currency !== "USD");
  const overlap = late("fx-overlap");
  const parent = structuredClone(overlap.cost_records[0]); delete parent.country;
  parent.cost_record_id = "fx69-cost-overlap"; parent.dimension_digest = sha256({network:parent.network,campaign_id:parent.campaign_id});
  overlap.cost_records.push(parent);
  const costTies = late("fx-cost-ties"); costTies.cost_records[0].amount_unscaled = "1";
  const secondTie = structuredClone(costTies.cost_records[0]);
  Object.assign(secondTie,{cost_record_id:"fx69-cost-second-tie",country:"GB",dimension_digest:sha256({network:"synthetic-network",campaign_id:"fx69-campaign",country:"GB"})});
  costTies.cost_records.push(secondTie);
  const permuted = structuredClone(source); permuted.fx_policy.rates.reverse(); permuted.records.reverse(); permuted.cost_records.reverse();
  const commerce = late("fx-commerce-dates");
  commerce.records = commerce.records.filter((r: Any) => r.event_name !== "ad_revenue");
  const template = commerce.records.find((r: Any) => r.event_name === "install");
  commerce.records.push(...["purchase","refund"].map((event_name,index) => ({ ...structuredClone(template),
    record_id:`fx69-${event_name}`,delivery_id:`delivery:fx69-${event_name}`,event_id:`event:fx69-${event_name}`,
    event_name,processing_sequence:9+index,occurred_at:`2026-08-0${6+index}T05:00:00.000Z`,
    payload:{event_name,installation_id:"installation:fx69",transaction_id:`fx69-${event_name}-transaction`,
      ...(index ? {original_transaction_id:"fx69-purchase-transaction",correction_target_record_id:"fx69-purchase"} : {}),
      amount_unscaled:index ? "1" : "3",amount_scale:6,currency:"JPY",financial_status:"settled"},
  })));
  for (const r of commerce.fx_policy.rates) if (r.currency === "JPY") r.rate_scale = r.effective_date.endsWith("06") ? 1 : 2;
  commerce.metric_definitions = structuredClone(SELECTED_COMMERCE_METRIC_DEFINITIONS.filter(d => d.metric_name === "cohort_purchase_net_revenue_d7_usd"));
  commerce.metric_evaluations[0].metric_names = ["cohort_purchase_net_revenue_d7_usd"];
  const total = structuredClone(commerce); total.metric_evaluations[0].metric_run_id_prefix = "fx-total-net";
  const ad = structuredClone(source.records.find((r: Any) => r.event_name === "ad_revenue" && r.payload.currency === "USD"));
  Object.assign(ad.payload,{amount_unscaled:"5",amount_scale:6}); total.records.push(ad);
  total.metric_definitions = structuredClone(SELECTED_COMMERCE_METRIC_DEFINITIONS.filter(d =>
    ["d30_total_net_roas","cohort_total_net_revenue_d30_usd"].includes(d.metric_name)));
  total.metric_evaluations[0].metric_names = ["d30_total_net_roas","cohort_total_net_revenue_d30_usd"];
  const totalMissingCost = structuredClone(total); totalMissingCost.metric_evaluations[0].metric_run_id_prefix = "fx-total-net-missing-cost";
  totalMissingCost.fx_policy.rates = totalMissingCost.fx_policy.rates.filter((r: Any) => r.currency !== "EUR");
  return [
    {name:"fx_dated_JPY_USD_EUR_half_even_and_watermark_snapshot",input:structuredClone(source),expected:datedFxFixtureValues},
    {name:"fx_missing_revenue_rate_never_publishes_partial_money_or_poisoned_counts",input:missingRevenue,expected:["1","missing_fx_rate","missing_fx_rate","missing_fx_rate","1000000"]},
    {name:"fx_missing_cost_rate_only_invalidates_ROAS",input:missingCost,expected:["1","3700004","missing_fx_rate","missing_fx_rate","1000000"]},
    {name:"fx_missing_effective_day_never_uses_neighboring_rate",input:missingDay,expected:["1","missing_fx_rate","1000000","missing_fx_rate","1000000"]},
    {name:"fx_huge_integer_never_becomes_a_floating_point_amount",input:big,expected:["9007199254740993"]},
    {name:"fx_same_currency_uses_captured_identity_rate",input:identity,expected:["1000001"]},
    {name:"fx_same_currency_has_no_inferred_identity",input:absentIdentity,expected:["missing_fx_rate"]},
    {name:"fx_cost_conversion_does_not_allocate_overlapping_grains",input:overlap,expected:["1","3700004","overlapping_cost_grains","overlapping_cost_grains","1000000"]},
    {name:"fx_cost_rows_round_individually_before_the_denominator_sum",input:costTies,expected:["1","3700004","1000001","1681820","1000000"]},
    {name:"fx_snapshot_and_artifacts_are_input_order_independent",input:permuted,expected:datedFxFixtureValues},
    {name:"fx_purchase_and_refund_convert_on_their_own_UTC_dates",input:commerce,expected:["1"]},
    {name:"fx_total_net_ROAS_converts_commerce_and_cost_without_floating_point",input:total,expected:["6","2"]},
    {name:"fx_total_net_money_is_independent_of_missing_cost_rate",input:totalMissingCost,expected:["6","missing_fx_rate"]},
  ];
}

export function syntheticEngagementFxCases(source: Any): SyntheticFxCase[] {
  const input = structuredClone(source);
  for (const batch of input.batches) for (const row of batch.records) {
    if (row.event_name !== "ad_revenue") continue;
    row.payload.currency = "EUR";
    if (row.record_id === "revenue64-b") {
      row.occurred_at = "2026-08-22T10:00:00.000Z";
      row.received_at = "2026-08-22T10:00:01.000Z";
      batch.server_context.received_at = row.received_at;
    }
  }
  input.fx_policy = {policy_version:"0.4.22",rate_selection:"utc_event_date_and_cost_date",target_currency:"USD",target_scale:6,
    rounding_mode:"half_even",rates:[21,22].map((day,index) => ({currency:"EUR",effective_date:`2026-08-${day}`,
      rate_unscaled:index ? "15" : "12",rate_scale:1,source:"synthetic-engagement-fx",as_of:"2026-08-20T00:00:00.000Z"}))};
  const missing = structuredClone(input); missing.fx_policy.rates.pop();
  return [
    {name:"fx_engagement_uses_outcome_UTC_date_not_open_date",input,expected:["2400000","1","6900000","1","4500000","1","0","0","empty_cohort","empty_cohort"]},
    {name:"fx_engagement_missing_outcome_rate_keeps_converter_counts",input:missing,expected:["2400000","1","missing_fx_rate","1","missing_fx_rate","1","0","0","empty_cohort","empty_cohort"]},
  ];
}
