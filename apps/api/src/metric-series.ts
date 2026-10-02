/** Presentation categories, not proof of human activity or provider verification. */
export function metricSeries(metricName: string): "first_party_engagement" | "apple_aggregate" | "cohort_or_activity" {
  if (["engagement_custom_event_converters_24h", "engagement_ad_revenue_24h_usd"].includes(metricName)) return "first_party_engagement";
  if (["skan_attributed_installs", "skan_conversion_value_distribution", "aak_attributed_installs", "aak_attributed_reengagements"].includes(metricName)) return "apple_aggregate";
  return "cohort_or_activity";
}
