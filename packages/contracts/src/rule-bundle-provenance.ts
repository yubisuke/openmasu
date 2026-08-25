import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

export type NonFraudRuleBundleId =
  | "attribution-default"
  | "apple-postback-default"
  | "metric-default"
  | "metric-stage-b"
  | "metric-stage-m3"
  | "metric-purchase-net"
  | "metric-total-net";

export type NonFraudRuleBundleKey = NonFraudRuleBundleId | "metric-purchase-net-v0.4.9";

export type NonFraudRuleBundleDefinition = {
  readonly id: NonFraudRuleBundleId;
  readonly version: string;
  readonly kind: "attribution" | "apple_postback" | "metric";
  readonly implementation: string;
  readonly rules: readonly string[];
};

export const NON_FRAUD_RULE_BUNDLES: Readonly<Record<NonFraudRuleBundleKey, NonFraudRuleBundleDefinition>> = {
  "attribution-default": {
    id: "attribution-default", version: "0.3.0", kind: "attribution",
    implementation: "reference-evaluator-v0.4",
    rules: [
      "imported-provider-evidence", "meta-install-referrer", "apple-adservices",
      "install-referrer-authoritative-time", "deep-link-engagement-only",
    ],
  },
  "apple-postback-default": {
    id: "apple-postback-default", version: "0.3.0", kind: "apple_postback",
    implementation: "reference-evaluator-v0.4",
    rules: ["signature-verification", "winner-check", "crowd-anonymity", "conversion-value-presence"],
  },
  "metric-default": {
    id: "metric-default", version: "0.3.0", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["d0-elapsed-ad-revenue", "d0-utc-calendar-ad-revenue", "d0-jst-calendar-ad-revenue"],
  },
  "metric-stage-b": {
    id: "metric-stage-b", version: "0.3.0", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["cohort-roas", "cohort-retention", "cohort-ltv", "cohort-install-count"],
  },
  "metric-stage-m3": {
    id: "metric-stage-m3", version: "0.3.1", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["daily-click-count", "daily-install-count", "daily-deep-link-count"],
  },
  "metric-purchase-net": {
    id: "metric-purchase-net", version: "0.4.8", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["settled-purchase-minus-refund-d0", "d1", "d3", "d7"],
  },
  "metric-purchase-net-v0.4.9": {
    id: "metric-purchase-net", version: "0.4.9", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["settled-purchase-minus-refund-d30", "d90"],
  },
  "metric-total-net": {
    id: "metric-total-net", version: "0.4.9", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["purchase-plus-ad-net-revenue-d30", "d90", "total-net-roas", "total-net-ltv"],
  },
};

export function nonFraudBundleHash(id: NonFraudRuleBundleKey): string {
  return createHash("sha256").update(canonicalize(NON_FRAUD_RULE_BUNDLES[id]), "utf8").digest("hex");
}

export function validateNonFraudBundleDefinition(value: unknown): NonFraudRuleBundleDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("rule_bundle_definition_invalid");
  const candidate = value as Record<string, unknown>;
  const expected = Object.values(NON_FRAUD_RULE_BUNDLES).find((definition) =>
    canonicalize(candidate) === canonicalize(definition));
  if (!expected) {
    throw new Error("non_fraud_rule_bundle_definition_unsupported");
  }
  return expected;
}
