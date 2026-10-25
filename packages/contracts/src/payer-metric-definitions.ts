import type { OpenMasuMetricDefinitionV04 as Definition } from "./generated/contract-types.js";
import { nonFraudBundleHash } from "./rule-bundle-provenance.js";
import { canonicalize } from "json-canonicalize";

export const PAYER_METRIC_BUNDLE = "metric-verified-payers";
export const PAYER_METRIC_VERSION = "0.4.26";
export const PAYER_METRIC_DEFINITIONS: readonly Definition[] = [
  { name: "cohort_purchase_count_d7", calculation: "purchase_count", numerator: "purchases", type: "count" },
  { name: "cohort_paying_installations_d7", calculation: "paying_installations", numerator: "paying_installations", type: "count" },
  { name: "cohort_payer_rate_d7", calculation: "paying_installations_over_cohort", numerator: "paying_installations", type: "ratio", denominator: "cohort_size" },
  { name: "cohort_arppu_d7_usd", calculation: "revenue_over_paying_installations", numerator: "purchase_net_revenue", type: "money", denominator: "paying_installations" },
].map(row => ({
  metric_name: row.name, metric_definition_version: PAYER_METRIC_VERSION,
  anchor_event: "install", aggregation_time_zone: "UTC", value_type: row.type,
  ...(row.type === "money" ? { currency: "USD", amount_scale: 6 } : {}),
  ...(row.type === "ratio" ? { ratio_scale: 6 } : {}),
  definition: { calculation: row.calculation, numerator: row.numerator,
    ...(row.denominator ? { denominator: row.denominator } : {}), window: { type: "elapsed", day: 7 } },
  acquisition_basis: "selected_first_party_click", fraud_policy: "gross",
  refund_reversal_policy: "cancel_target_refund_at_watermark",
  grouping_dimensions: ["campaign_id", "network", "country", "cohort_date", "attribution_status"],
  rule_bundle_id: PAYER_METRIC_BUNDLE, rule_bundle_version: PAYER_METRIC_VERSION,
  rule_bundle_hash: nonFraudBundleHash(PAYER_METRIC_BUNDLE),
}) as Definition);

export function payerMetricDefinitions(): Definition[] { return structuredClone([...PAYER_METRIC_DEFINITIONS]); }

export function isPayerMetricDefinition(value: unknown): value is Definition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const expected = PAYER_METRIC_DEFINITIONS.find(row => row.metric_name === (value as Record<string, unknown>).metric_name);
  if (!expected) return false;
  try { return canonicalize(value) === canonicalize(expected); } catch { return false; }
}

/** Admission routing, not independent proof that a store transaction was verified. */
export function isPayerMetric(value: { rule_bundle_id?: unknown; metric_name?: unknown; definition?: { calculation?: unknown; numerator?: unknown; denominator?: unknown } }): boolean {
  return value.rule_bundle_id === PAYER_METRIC_BUNDLE
    || PAYER_METRIC_DEFINITIONS.some(row => row.metric_name === value.metric_name
      || row.definition.calculation === value.definition?.calculation)
    || ["purchases", "paying_installations"].includes(String(value.definition?.numerator))
    || value.definition?.denominator === "paying_installations";
}

/** Only server-owned monetary projections qualify; client extensions are never authority. */
export function isVerifiedPurchaseProjection(producer: string, policyDigest: string): boolean {
  return producer.startsWith("adapter:")
    && ["google-play-product-verification-v1", "verified-commerce-v1"].includes(policyDigest);
}
