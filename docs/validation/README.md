# Validation Checklists

These checklists record evidence that cannot be established by public synthetic
CI alone. They are optional private operator work. They do not authorize access
to real credentials, exports, devices, campaigns, domains, or production
systems.

## Repository-controlled evidence

- [v0.2.0-rc.2 synthetic evidence](v0.2.0-rc.2-synthetic-evidence.md)
- [Synthetic load record](m5-load-results.md)
- [Pull request CI scope validation](ci-scope-routing.md)

These records apply to the exact commit or tag they name. They are not a claim
about later development branches or production behavior.

## Private deployment and provider checks

- [Shadow measurement comparison](real-data-checklist.md)
- [Android and provider devices](m2-device-checklist.md)
- [Dashboard operations](m3-operator-checklist.md)
- [iOS and Apple providers](m4-device-checklist.md)
- [Integrity services](m5-integrity-checklist.md)
- [Production operations](m5-operator-checklist.md)
- [Fraud operations](m6-fraud-checklist.md)
- [Deep-link devices and domains](deeplink-device-checklist.md)
- [Verified commerce](verified-commerce-operator-checklist.md)
- [Google Play one-time products](google-play-product-verification-checklist.md)
- [Google Play initial subscriptions](google-play-subscription-verification-checklist.md)
- [Google Play subscription renewals](google-play-rtdn-renewal-checklist.md)
- [Google Data Manager conversion delivery](google-data-manager-conversion-checklist.md)

## Evidence rules

For each private run, record the exact source commit, contract version,
deployment configuration version, synthetic preflight result, authorization,
time range, and residuals. Never commit real values or derived results to this
public repository.

A checked box proves only the named check. It does not imply provider-wide
support, production readiness, or equivalence with another MMP.
