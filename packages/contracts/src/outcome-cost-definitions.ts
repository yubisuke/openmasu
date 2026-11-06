import type { OpenMasuMetricDefinitionV04 as Definition } from "./generated/contract-types.js";
import { canonicalize } from "json-canonicalize";
import { nonFraudBundleHash } from "./rule-bundle-provenance.js";

export const OUTCOME_COST_BUNDLE = "metric-outcome-acquisition-cost";
export const OUTCOME_COST_VERSION = "0.4.33";

/** Money per scoped installation, never money per event or person. */
export function outcomeAcquisitionCostDefinitions(eventKey: string): Definition[] {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(eventKey)) throw new Error("conversion_event_key_invalid");
  return [false, true].map(payer => ({
    metric_name: payer ? "acquisition_d7_payer_cost" : `acquisition_d7_cpa_${eventKey}`,
    metric_definition_version: OUTCOME_COST_VERSION, anchor_event: "install",
    aggregation_time_zone: "UTC", acquisition_basis: "selected_first_party_click", fraud_policy: "gross",
    value_type: "money", currency: "USD", amount_scale: 6,
    ...(!payer ? { conversion_event_key: eventKey } : {}),
    definition: { calculation: "cost_over_outcome", numerator: "cost",
      denominator: payer ? "paying_installations" : "converted_installations",
      window: { type: "elapsed", day: 7 }, cost_basis: "cohort_acquisition_day_current_snapshot" },
    grouping_dimensions: ["campaign_id", "network", "country", "cohort_date", "attribution_status"],
    cost_selection_policy: "reject_overlapping_grains", rule_bundle_id: OUTCOME_COST_BUNDLE,
    rule_bundle_version: OUTCOME_COST_VERSION, rule_bundle_hash: nonFraudBundleHash(OUTCOME_COST_BUNDLE),
  }));
}

export function isOutcomeCostMetric(value: { rule_bundle_id?: unknown; metric_name?: unknown; definition?: { calculation?: unknown } }): boolean {
  return value.rule_bundle_id === OUTCOME_COST_BUNDLE || value.definition?.calculation === "cost_over_outcome"
    || /^acquisition_d7_(cpa_|payer_cost$)/.test(String(value.metric_name));
}

export function isOutcomeCostMetricDefinition(value: unknown): value is Definition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Definition;
  try {
    const expected = outcomeAcquisitionCostDefinitions(candidate.conversion_event_key ?? "synthetic_unused")
      [candidate.definition.denominator === "paying_installations" ? 1 : 0];
    if (candidate.definition.denominator === "converted_installations") {
      if (!/^acquisition_d7_cpa_[a-z][a-z0-9_]{0,63}$/.test(candidate.metric_name)) return false;
      expected.metric_name = candidate.metric_name;
    }
    return canonicalize(value) === canonicalize(expected);
  } catch { return false; }
}

export function outcomeCostClosesAt(definition: Pick<Definition, "rule_bundle_id">, cohortDate?: string): string | undefined {
  if (definition.rule_bundle_id !== OUTCOME_COST_BUNDLE) return undefined;
  if (!cohortDate || !/^\d{4}-\d{2}-\d{2}$/.test(cohortDate) || !Number.isFinite(Date.parse(cohortDate))
      || new Date(cohortDate).toISOString().slice(0, 10) !== cohortDate) throw new Error("outcome_cost_cohort_date_required");
  return new Date(Date.parse(cohortDate) + 9 * 86400000).toISOString();
}
