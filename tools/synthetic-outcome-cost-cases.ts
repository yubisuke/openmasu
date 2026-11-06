import { sha256 } from "@openmasu/attribution-core/canonical";
type Any = Record<string, any>;
export function syntheticOutcomeCostCases(source: Any): { name: string; input: Any; expected: readonly string[] }[] {
  const cases: { name: string; input: Any; expected: readonly string[] }[] = [];
  const add = (name: string, expected: readonly string[], change: (input: Any) => void = () => {}) => {
    const input = structuredClone(source);
    input.metric_evaluations = [input.metric_evaluations[0]];
    change(input); cases.push({ name, input, expected });
  };
  add("outcome_cost_distinct_converters_and_verified_payers_not_event_counts", ["5000000", "10000000"]);
  add("outcome_cost_real_zero_is_present", ["0", "0"], input => { input.cost_records[0].amount_unscaled = "0"; });
  add("outcome_cost_missing_spend_is_not_zero", ["no_attributed_cost", "no_attributed_cost"], input => { input.cost_records = []; });
  add("outcome_cost_half_even_division", ["0", "1"], input => {
    input.cost_records[0].amount_unscaled = "1"; input.cost_records[0].amount_scale = 6;
  });
  add("outcome_cost_unknown_cost_FX_is_not_partial_money", ["missing_fx_rate", "missing_fx_rate"], input => { input.cost_records[0].currency = "EUR"; });
  add("outcome_cost_overlapping_parent_child_is_undefined", ["overlapping_cost_grains", "overlapping_cost_grains"], input => {
    delete input.metric_evaluations[0].grouping.country;
    const parent = { ...input.cost_records[0], cost_record_id: "synthetic-outcome-parent" };
    delete parent.country; parent.dimension_digest = sha256({ campaign_id: parent.campaign_id, network: parent.network });
    input.cost_records.push(parent);
  });
  add("outcome_cost_late_receipt_excludes_one_converter_until_replay", ["10000000", "10000000"], input => {
    input.batches[0].records.find((r: Any) => r.record_id === "outcome80-other-install").received_at = "2026-08-17T00:00:00.000Z";
  });
  add("outcome_cost_unverified_store_claim_cannot_create_a_payer", ["5000000", "no_paying_installations"], input => {
    input.batches[1].server_context.policy_digest = "synthetic-unverified";
  });
  add("outcome_cost_key_is_exact_and_missing_outcomes_are_undefined", ["no_converted_installations", "10000000"], input => {
    input.metric_definitions[0].conversion_event_key = "synthetic_never";
  });
  add("outcome_cost_observation_end_is_required", ["observation_window_not_elapsed", "observation_window_not_elapsed"], input => {
    input.metric_evaluations[0].input_received_at_watermark = "2026-08-14T23:59:59.999Z";
  });
  return cases;
}
