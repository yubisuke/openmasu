import { ACQUISITION_KPI_METRIC_DEFINITIONS, horizonAcquisitionKpiDefinitions } from "@openmasu/contracts/definitions";
import { acquisitionKpiExpected } from "./synthetic-acquisition-kpi-cases.js";
type Any = Record<string, any>;

/** Input construction only; expected values below are independent hand arithmetic. */
export function syntheticAcquisitionHorizonFixture(baseline: Any): Any {
  const input = structuredClone(baseline);
  for (const [event_name, id, amount, occurred_at] of [
    ["ad_revenue", "kpi78-later-ad", "4", "2026-08-20T12:00:00.000Z"],
    ["purchase", "kpi78-later-purchase", "6", "2026-08-20T13:00:00.000Z"],
    ["refund", "kpi78-later-refund", "3", "2026-08-21T12:00:00.000Z"],
  ]) {
    const record = structuredClone(input.records.find((row: Any) => row.record_id === `kpi70-${event_name === "ad_revenue" ? "ad" : event_name}-a`));
    Object.assign(record, { record_id: id, event_id: `event:${id}`, delivery_id: `delivery:${id}`,
      occurred_at, received_at: "2026-09-08T00:00:00.000Z", processing_sequence: input.records.length + 1 });
    record.payload.amount_unscaled = amount;
    if (event_name !== "ad_revenue") record.payload.transaction_id = id;
    if (event_name === "refund") {
      record.payload.original_transaction_id = "kpi78-later-purchase";
      record.payload.correction_target_record_id = "kpi78-later-purchase";
    }
    input.records.push(record);
  }
  input.fx_policy.rates.push(...["2026-08-20", "2026-08-21"].map(effective_date => ({
    currency: "USD", rate_unscaled: "1", rate_scale: 0, effective_date,
    as_of: "2026-09-08T00:00:00.000Z", source: "synthetic-identity-snapshot-78",
  })));
  input.metric_definitions = [...horizonAcquisitionKpiDefinitions(0), ...structuredClone(ACQUISITION_KPI_METRIC_DEFINITIONS),
    ...horizonAcquisitionKpiDefinitions(30)];
  const paid = baseline.metric_evaluations[0];
  input.metric_evaluations = [0, 7, 30].map(day => ({ ...structuredClone(paid), metric_run_id_prefix: `kpi78-d${day}`,
    metric_names: input.metric_definitions.filter((definition: Any) => definition.metric_name.startsWith(`acquisition_d${day}_`)).map((definition: Any) => definition.metric_name),
    input_received_at_watermark: "2026-09-09T00:00:00.000Z", computed_at: "2026-09-09T00:00:00.000Z",
  }));
  input.metric_evaluations.push({ ...structuredClone(input.metric_evaluations[2]), metric_run_id_prefix: "kpi78-d30-immature",
    input_received_at_watermark: "2026-09-06T23:59:59.999Z", computed_at: "2026-09-06T23:59:59.999Z" });
  return input;
}

// installs, cost, CPI, ad revenue, purchase net, total net, ad ROAS, total ROAS.
const immature = Array<string>(8).fill("observation_window_not_elapsed");
export const acquisitionHorizonFixtureValues: Record<string, readonly string[]> = {
  "kpi78-d0": ["3", "10000000", "3333333", "6000000", "8000000", "14000000", "600000", "1400000"],
  "kpi78-d7": ["3", "10000000", "3333333", "6000000", "6000000", "12000000", "600000", "1200000"],
  "kpi78-d30": ["3", "10000000", "3333333", "10000000", "9000000", "19000000", "1000000", "1900000"],
  "kpi78-d30-immature": immature,
};

export function syntheticAcquisitionHorizonCases(source: Any) {
  const make = (name: string, input: Any, values = acquisitionHorizonFixtureValues) => ({ name, input,
    expected: acquisitionKpiExpected(input, values) as string[] });
  const maturity = structuredClone(source);
  maturity.server_context.received_at = "2026-08-07T13:00:00.000Z";
  for (const record of maturity.records.slice(0, 16)) record.received_at = maturity.server_context.received_at;
  for (const cost of maturity.cost_records) cost.as_of = maturity.server_context.received_at;
  for (const rate of maturity.fx_policy.rates.slice(0, 2)) rate.as_of = maturity.server_context.received_at;
  const d0 = maturity.metric_evaluations[0], d30 = maturity.metric_evaluations[2];
  maturity.metric_evaluations = [
    { ...structuredClone(d0), metric_run_id_prefix: "kpi78-d0-before", input_received_at_watermark: "2026-08-07T23:59:59.999Z", computed_at: "2026-08-07T23:59:59.999Z" },
    { ...structuredClone(d0), input_received_at_watermark: "2026-08-08T00:00:00.000Z", computed_at: "2026-08-08T00:00:00.000Z" },
    { ...structuredClone(d30), input_received_at_watermark: "2026-09-07T00:00:00.000Z", computed_at: "2026-09-07T00:00:00.000Z" },
  ];
  const boundaries = structuredClone(source);
  for (const [suffix, amount, occurred_at] of [
    ["d0-before", "1", "2026-08-06T23:59:59.999Z"], ["d0-exact", "2", "2026-08-07T00:00:00.000Z"],
    ["d30-before", "3", "2026-09-05T23:59:59.999Z"], ["d30-exact", "4", "2026-09-06T00:00:00.000Z"],
  ]) {
    const record = structuredClone(boundaries.records.find((row: Any) => row.record_id === "kpi78-later-ad"));
    const id = `kpi78-${suffix}`;
    Object.assign(record, { record_id: id, event_id: `event:${id}`, delivery_id: `delivery:${id}`, occurred_at,
      processing_sequence: boundaries.records.length + 1 });
    record.payload.amount_unscaled = amount; boundaries.records.push(record);
  }
  boundaries.fx_policy.rates.push(...["2026-09-05", "2026-09-06"].map(effective_date => ({
    currency: "USD", rate_unscaled: "1", rate_scale: 0, effective_date,
    as_of: "2026-09-08T00:00:00.000Z", source: "synthetic-boundary-rates-78",
  })));
  const missingCost = structuredClone(source); missingCost.cost_records = [];
  const noCost = Object.fromEntries(Object.entries(acquisitionHorizonFixtureValues).map(([prefix, vector]) => [prefix,
    prefix.endsWith("immature") ? vector : vector.map((value, index) => [1, 2, 6, 7].includes(index) ? "no_attributed_cost" : value)]));
  return [
    make("acquisition_horizons_keep_native_D0_D7_D30_separate_and_immature_undefined", structuredClone(source)),
    make("acquisition_horizons_close_at_exact_conservative_maturity_and_exclude_later_receipts", maturity, {
      "kpi78-d0-before": immature, "kpi78-d0": acquisitionHorizonFixtureValues["kpi78-d0"],
      "kpi78-d30": acquisitionHorizonFixtureValues["kpi78-d7"],
    }),
    make("acquisition_horizons_use_half_open_D0_and_D30_revenue_boundaries", boundaries, {
      "kpi78-d0": ["3", "10000000", "3333333", "7000000", "8000000", "15000000", "700000", "1500000"],
      "kpi78-d7": ["3", "10000000", "3333333", "9000000", "6000000", "15000000", "900000", "1500000"],
      "kpi78-d30": ["3", "10000000", "3333333", "16000000", "9000000", "25000000", "1600000", "2500000"],
      "kpi78-d30-immature": immature,
    }),
    make("acquisition_horizons_missing_cost_keeps_each_revenue_window_and_maturity", missingCost, noCost),
  ];
}
