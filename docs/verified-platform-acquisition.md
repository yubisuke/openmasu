# Verified platform acquisition

This opt-in profile connects server-verified installation attribution to cohort
install counts, retention, advertising revenue, LTV and ROAS. It is independent
of recorded-dimension and selected first-party-click profiles: old definitions
and saved runs keep their meaning. Platform-assigned attribution is not
cross-network deterministic attribution or proof of an organic install.

Only the selected installation-level revision at the received-at watermark can
supply dimensions. AdServices uses the stored server lookup result; Meta Install
Referrer uses the server-decrypted canonical install. Device-provided campaign
fields, first-party click dimensions, imports and Apple aggregate postbacks are
not substitutes. The `network` dimension is the source namespace
(`apple_adservices` or `meta_install_referrer`); equal campaign IDs across sources
must not be combined.

The calculation snapshot binds the selected attribution and protected-context
digest. A response after the cutoff does not rewrite an earlier run. Current
privacy fences and protected-reference purges remove eligibility; an unavailable
selected context never falls back to an older campaign. Fraud gross/net rules
remain those of the existing cohort engine. Ad-group ROAS requires explicit
ad-group cost; parent campaign cost is never allocated.

`platform_acquisition_inputs` is the normalized, trusted server projection used
by reference fixtures. Production calculations resolve it from stored lookup
results and canonical events, not from a request body or replay manifest. SDK
and S2S callers cannot supply verified attribution or decryption markers.

## Use the profile

Supply the complete `VERIFIED_PLATFORM_METRIC_DEFINITIONS` from
`@openmasu/contracts/definitions` to a manual calculation or schedule. They have
independent `platform_*` names and version `0.4.19`; changing only an old
definition's basis is rejected. Use an explicit source namespace when filtering
campaign/ad-group IDs. For example, the synthetic Apple grouping is
`{"network":"apple_adservices","campaign_id":"2066","cohort_date":"2026-09-28"}`.
All-source totals do not establish cross-network deduplication.

The existing [daily schedule workflow](scheduled-metrics.md) accepts these
definitions. Its bounded campaign discovery reads verified source dimensions
and matching source-namespaced cost, including separate unattributed negative
outcomes; unrelated network cost is not a platform target. It does not discover
ad groups or blend this basis with first-party definitions in one discovery
evaluation. Use an explicit, namespaced ad-group grouping for that narrower grain.

The existing [automatic correction policy](automatic-metric-corrections.md) is
still off by default. When enabled for retained cohorts, a committed late
platform revision can replace count/retention/revenue runs, and later revenue
or cost can replace contributing money runs. Each replacement retains the
original definition, source namespace, fixed new cutoff and explicit lineage.
Original artifacts stay unchanged. Saved API/CSV/HTML and schedule views label
this as **Verified platform acquisition**, not first-party deterministic credit.

## External evidence boundary

All acceptance evidence is synthetic. Live Apple responses, real Meta keys,
partner-only network access and real-device verification remain unverified.
The existing Meta `is_ct`, `actual_timestamp` and key-rotation boundaries remain
unverified; this profile does not add a claim about those fields.

Primary sources checked on 2026-10-03:

- [Apple attribution token](https://developer.apple.com/documentation/adservices/aaattribution/attributiontoken())
- [Apple Ads attribution](https://ads.apple.com/app-store/help/attribution/0028-measuring-ad-performance)
- [AdServices API v3](https://ads.apple.com/adsdam/us/en_us/documents/help/0028-apple-ads-attribution-api/2025-03-25/AdServices-API-v3.pdf)
