import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

export type NonFraudRuleBundleId =
  | "attribution-default"
  | "apple-postback-default"
  | "metric-default"
  | "metric-stage-b"
  | "metric-selected-acquisition"
  | "metric-verified-platform-acquisition"
  | "metric-imported-provider-acquisition"
  | "metric-calendar-acquisition"
  | "metric-selected-daily-acquisition"
  | "metric-acquisition-kpis"
  | "metric-standard-retention"
  | "metric-disjoint-cost"
  | "metric-selected-commerce"
  | "metric-refund-reversal"
  | "metric-acquisition-detail"
  | "metric-first-party-engagement"
  | "metric-custom-conversion"
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
  "metric-standard-retention": {
    id: "metric-standard-retention", version: "0.4.24", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["opt-in-d3-d14-d30-elapsed-activity-day", "distinct-active-eligible-installations",
      "same-selected-native-platform-or-imported-cohort", "same-provider-outcomes-only",
      "half-open-install-relative-session-window", "complete-cohort-date-window-before-value",
      "immature-is-undefined-not-zero", "received-evidence-as-of-watermark",
      "preserve-current-privacy-and-gross-net", "historical-d1-d7-unchanged"],
  },
  "metric-acquisition-kpis": {
    id: "metric-acquisition-kpis", version: "0.4.23", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["saved-first-party-d7-cohort-set", "selected-first-party-click-dimensions",
      "same-input-cost-and-attribution-snapshot", "cohort-acquisition-day-current-snapshot",
      "reject-overlapping-cost-grains", "cost-sum-and-half-even-cost-over-cohort",
      "missing-cost-and-empty-cohort-are-not-zero-cpi", "separate-ad-purchase-net-and-total-net",
      "captured-fx-and-watermark", "preserve-current-privacy-and-fraud"],
  },
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
  "metric-selected-acquisition": {
    id: "metric-selected-acquisition", version: "0.4.11", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["cohort-roas", "cohort-retention", "cohort-ltv", "cohort-install-count",
      "selected-first-party-click-dimensions", "attribution-and-evidence-as-of-watermark"],
  },
  "metric-verified-platform-acquisition": {
    id: "metric-verified-platform-acquisition", version: "0.4.19", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["installation-cohort-install-retention-ad-revenue-ltv-roas",
      "selected-verified-platform-revision", "server-verified-context-only",
      "context-and-attribution-as-of-watermark", "protected-context-lifecycle",
      "platform-source-namespaced-campaign-ad-group", "never-fall-back-to-device-or-click-dimensions",
      "explicit-dated-cost-revision-key", "reject-overlapping-cost-grains",
      "never-allocate-parent-cost-to-ad-group", "preserve-current-privacy-and-fraud"],
  },
  "metric-imported-provider-acquisition": {
    id: "metric-imported-provider-acquisition", version: "0.4.20", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["installation-cohort-install-retention-ad-revenue-ltv-roas",
      "explicit-import-provider-and-installation-binding", "provider-revision-as-of-watermark",
      "canonical-import-context-dimensions", "same-provider-same-tenant-app-outcomes-only",
      "freeze-import-context-and-attribution-snapshot", "never-infer-subject-from-external-id",
      "separate-native-platform-and-imported-series", "explicit-dated-cost-revision-key",
      "reject-overlapping-cost-grains", "never-allocate-parent-cost-to-ad-group",
      "preserve-current-privacy-and-fraud"],
  },
  "metric-calendar-acquisition": {
    id: "metric-calendar-acquisition", version: "0.4.21", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["explicit-qualified-iana-cohort-date", "utc-tokyo-new-york-boundaries",
      "cumulative-install-to-local-day-end-ad-revenue", "on-local-day-distinct-active-installations",
      "calendar-arithmetic-not-fixed-24-hour-offsets", "half-open-no-pre-install-outcomes",
      "reuse-explicit-native-platform-imported-acquisition", "same-zone-dated-cost-only",
      "unknown-or-mismatched-cost-zone-is-not-allocated", "reject-overlapping-cost-grains",
      "preserve-current-privacy-and-fraud", "saved-calendar-meaning-and-local-maturity"],
  },
  "metric-selected-daily-acquisition": {
    id: "metric-selected-daily-acquisition", version: "0.4.18", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["daily-native-install-occurrence-day-utc", "selected-first-party-click-dimensions",
      "attribution-and-evidence-as-of-watermark", "reuse-cohort-attribution-revision-selection",
      "unknown-campaign-is-distinct-from-all-campaigns", "current-privacy-evidence",
      "no-imported-or-apple-aggregate-events", "gross-and-net-install-populations"],
  },
  "metric-disjoint-cost": {
    id: "metric-disjoint-cost", version: "0.4.12", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["explicit-dated-cost-revision-key", "reject-overlapping-cost-grains",
      "cost-and-evidence-as-of-watermark", "cohort-ad-or-total-net-roas",
      "optional-selected-first-party-click-dimensions"],
  },
  "metric-selected-commerce": {
    id: "metric-selected-commerce", version: "0.4.13", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["selected-first-party-click-dimensions", "attribution-and-evidence-as-of-watermark",
      "settled-purchase-minus-capped-refund", "purchase-plus-ad-net-revenue",
      "total-net-roas-and-ltv", "explicit-dated-cost-revision-key", "reject-overlapping-cost-grains"],
  },
  "metric-custom-conversion": {
    id: "metric-custom-conversion", version: "0.4.14", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["selected-first-party-click-dimensions", "attribution-and-evidence-as-of-watermark",
      "explicit-single-custom-event-key", "distinct-converted-installations",
      "d7-elapsed-half-open-cumulative-window", "same-eligible-cohort-numerator-and-denominator",
      "empty-cohort-is-undefined", "nonempty-cohort-without-conversion-is-zero"],
  },
  "metric-refund-reversal": {
    id: "metric-refund-reversal", version: "0.4.15", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["selected-first-party-click-dimensions", "attribution-and-evidence-as-of-watermark",
      "settled-purchase-minus-capped-refund", "explicit-exact-refund-reversal-target",
      "cancel-target-refund-at-watermark-once", "reuse-target-refund-window-and-rounded-value",
      "purchase-plus-ad-net-revenue", "total-net-roas-and-ltv",
      "explicit-dated-cost-revision-key", "reject-overlapping-cost-grains"],
  },
  "metric-acquisition-detail": {
    id: "metric-acquisition-detail", version: "0.4.16", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["selected-first-party-click-dimensions", "attribution-and-evidence-as-of-watermark",
      "selected-link-ad-group-and-creative", "unknown-detail-remains-unknown",
      "no-parent-cost-allocation", "explicit-dated-creative-cost-revision-key",
      "reject-overlapping-cost-grains", "cohort-install-ad-and-commerce-values",
      "cancel-target-refund-at-watermark-once", "reuse-target-refund-window-and-rounded-value"],
  },
  "metric-first-party-engagement": {
    id: "metric-first-party-engagement", version: "0.4.17", kind: "metric",
    implementation: "reference-metric-v0.4",
    rules: ["server-resolved-non-organic-engagement-with-campaign", "device-reported-forgeable-open",
      "latest-eligible-open-before-outcome", "open-time-tie-record-id-ascending",
      "select-credit-before-campaign-and-anchor-date-filter", "24h-half-open-elapsed-window",
      "single-event-key-distinct-converted-installations", "per-event-ad-revenue-half-even-fx",
      "received-and-attribution-as-of-watermark", "removed-anchor-never-falls-back",
      "empty-engagement-population-is-undefined", "nonempty-population-without-outcome-is-zero",
      "no-cost-or-purchase-join", "never-rewrite-install-attribution"],
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
