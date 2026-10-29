import { basisAcquisitionKpiDefinitions } from "@openmasu/contracts/definitions";
import { acquisitionKpiExpected } from "./synthetic-acquisition-kpi-cases.js";
type Any = Record<string, any>;

// Input construction only: the expected eight-role vectors are hand arithmetic.
export function syntheticBasisAcquisitionKpiFixture(baseline: Any): Any {
  const input = structuredClone(baseline);
  const prototype = input.records.find((record: Any) => record.record_id === "revenue-paid-67");
  for (const [event_name, id, amount, occurred_at] of [
    ["purchase", "purchase-77", "8000000", "2026-08-06T13:00:00.000Z"],
    ["refund", "refund-77", "3000000", "2026-08-07T12:00:00.000Z"],
  ]) input.records.push({ ...structuredClone(prototype), event_name, record_id: id,
    event_id: `event:${id}`, delivery_id: `delivery:${id}`, occurred_at, processing_sequence: input.records.length,
    payload: { event_name, installation_id: "installation:paid-67", transaction_id: `transaction:${id}`,
      amount_unscaled: amount, amount_scale: 6, currency: "USD", financial_status: "settled",
      ...(event_name === "refund" ? { original_transaction_id: "transaction:purchase-77", correction_target_record_id: "purchase-77" } : {}) } });
  const imported = basisAcquisitionKpiDefinitions("selected_imported_provider", "synthetic-export");
  const platform = basisAcquisitionKpiDefinitions("selected_verified_platform");
  input.metric_definitions = [...imported, ...platform];
  const paid = baseline.metric_evaluations[0];
  input.metric_evaluations = [
    { ...structuredClone(paid), metric_run_id_prefix: "kpi77-paid" },
    { ...structuredClone(baseline.metric_evaluations[1]), metric_run_id_prefix: "kpi77-organic" },
    { ...structuredClone(baseline.metric_evaluations[2]), metric_run_id_prefix: "kpi77-unattributed" },
    { ...structuredClone(paid), metric_run_id_prefix: "kpi77-empty", grouping: { ...paid.grouping, campaign_id: "synthetic-empty-77" } },
  ].map(evaluation => ({ ...evaluation, metric_names: imported.map(definition => definition.metric_name) }));
  // A matching cost row is not evidence of a verified platform installation.
  input.metric_evaluations.push({ ...structuredClone(paid), metric_run_id_prefix: "kpi77-platform-empty",
    metric_names: platform.map(definition => definition.metric_name) });
  return input;
}

// installs, cost, CPI, ad revenue, purchase net, total net, ad ROAS, total ROAS.
export const basisAcquisitionKpiFixtureValues: Record<string, readonly string[]> = {
  "kpi77-paid": ["1", "4000000", "4000000", "2000000", "5000000", "7000000", "500000", "1750000"],
  "kpi77-organic": ["1", "no_attributed_cost", "no_attributed_cost", "3000000", "0", "3000000", "no_attributed_cost", "no_attributed_cost"],
  "kpi77-unattributed": ["1", "no_attributed_cost", "no_attributed_cost", "1000000", "0", "1000000", "no_attributed_cost", "no_attributed_cost"],
  "kpi77-empty": ["0", "no_attributed_cost", "empty_cohort", "0", "0", "0", "no_attributed_cost", "no_attributed_cost"],
  "kpi77-platform-empty": ["0", "4000000", "empty_cohort", "0", "0", "0", "0", "0"],
};

export function syntheticBasisAcquisitionKpiCases(source: Any, platformSource: Any) {
  const single = () => { const input = structuredClone(source); input.metric_evaluations = [input.metric_evaluations[0]]; return input; };
  const make = (name: string, input: Any, values = basisAcquisitionKpiFixtureValues) => ({ name, input,
    expected: acquisitionKpiExpected(input, values) as string[] });
  const otherProvider = single();
  for (const record of otherProvider.records.filter((record: Any) => ["purchase-77", "refund-77"].includes(record.record_id))) record.producer = "import:synthetic-second";
  const native = single();
  for (const record of native.records.filter((record: Any) => ["purchase-77", "refund-77"].includes(record.record_id))) record.producer = "sdk-android";
  const noPurchase = { "kpi77-paid": ["1", "4000000", "4000000", "2000000", "0", "2000000", "500000", "500000"] };
  const foreignRefund = single(); foreignRefund.records.find((record: Any) => record.record_id === "refund-77").producer = "import:synthetic-second";
  const missing = single(); missing.cost_records = [];
  const zero = single(); zero.cost_records[0].amount_unscaled = "0";
  const platform = structuredClone(platformSource);
  platform.metric_definitions = basisAcquisitionKpiDefinitions("selected_verified_platform");
  platform.metric_evaluations = [platformSource.metric_evaluations[0], platformSource.metric_evaluations[2]].map((evaluation: Any, index: number) => ({
    ...structuredClone(evaluation), metric_run_id_prefix: `kpi77-platform-${index ? "apple" : "meta"}`,
    input_received_at_watermark: "2026-10-07T00:00:00.000Z", computed_at: "2026-10-07T00:00:00.000Z",
    metric_names: platform.metric_definitions.map((definition: Any) => definition.metric_name),
  }));
  return [
    make("basis_kpis_preserve_imported_provider_and_empty_platform_sets", structuredClone(source)),
    make("basis_kpis_other_provider_commerce_cannot_claim_imported_installation", otherProvider, noPurchase),
    make("basis_kpis_native_commerce_cannot_claim_imported_installation", native, noPurchase),
    make("basis_kpis_foreign_refund_cannot_reduce_same_provider_purchase", foreignRefund,
      { "kpi77-paid": ["1", "4000000", "4000000", "2000000", "8000000", "10000000", "500000", "2500000"] }),
    make("basis_kpis_missing_cost_preserves_same_provider_net_revenue", missing,
      { "kpi77-paid": ["1", "no_attributed_cost", "no_attributed_cost", "2000000", "5000000", "7000000", "no_attributed_cost", "no_attributed_cost"] }),
    make("basis_kpis_explicit_zero_cost_is_not_missing", zero,
      { "kpi77-paid": ["1", "0", "0", "2000000", "5000000", "7000000", "no_attributed_cost", "no_attributed_cost"] }),
    make("basis_kpis_verified_platform_sources_share_all_eight_role_inputs", platform, {
      "kpi77-platform-meta": ["1", "1000000", "1000000", "2000000", "0", "2000000", "2000000", "2000000"],
      "kpi77-platform-apple": ["1", "10000000", "10000000", "5000000", "0", "5000000", "500000", "500000"],
    }),
  ];
}
