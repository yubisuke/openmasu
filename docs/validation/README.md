# Validation Checklists

These checklists record evidence that cannot be established by public synthetic
CI alone. They are optional private operator work. They do not authorize access
to real credentials, exports, devices, campaigns, domains, or production
systems.

## Current source verification

For the current checkout, use the disposable pilot and gates in
[Getting started](../getting-started.md) and [Development](../development.md).
Their result applies only to the exact source revision that ran them.

The `v0.3.0-rc.2` [frozen integration record](v0.3.0-rc.2-synthetic-evidence.md)
maps first-use, correction, upgrade and SDK paths to their existing test owners.
The separate [publication receipt](v0.3.0-rc.2-publication.md) records full CI
and eight verified public SDK assets at tagged commit `d775cc9` on 2026-10-24.
The release evidence does not apply to later source changes or production operation.
The receipt separately records the downloaded Android SDK journey through its
native Room queue/HMAC HTTP transport, durable backend processing, a daily
install value and saved analysis/CSV. Its later harness revision is distinct
from the frozen SDK source. This is JVM/Robolectric API 24 evidence, not physical-device
or all-platform onboarding; existing fixture-projected campaign/cost/revenue tests
remain separate.

The [v0.3.0-rc.1 publication receipt](v0.3.0-rc.1-publication.md) remains the
historical record for its tagged commit `90a0f5f`.
The v0.2.0 evidence manifest is the frozen public record for green commit
`68b8c48`, identified by the annotated tag and
[GitHub Release](https://github.com/yubisuke/openmasu/releases/tag/v0.2.0).
The rc.4 evidence manifest remains release evidence only for tagged commit
`2a2f6b5`; neither record applies to later `main` changes.

## Tagged and historical repository evidence

- [v0.3.0-rc.2 public SDK receipt](v0.3.0-rc.2-publication.md)
- [v0.3.0-rc.2 frozen integration record](v0.3.0-rc.2-synthetic-evidence.md)
- [v0.3.0-rc.1 public SDK receipt](v0.3.0-rc.1-publication.md)
- [v0.3.0-rc.1 frozen evidence requirements](v0.3.0-rc.1-synthetic-evidence.md)

- [v0.2.0 synthetic evidence](v0.2.0-synthetic-evidence.md)
- [v0.2.0-rc.4 synthetic evidence](v0.2.0-rc.4-synthetic-evidence.md)
- [v0.2.0-rc.3 synthetic evidence](v0.2.0-rc.3-synthetic-evidence.md)
- [Synthetic load record](m5-load-results.md)
- [Pull request CI scope validation](ci-scope-routing.md)

These records apply to the exact commit or tag they name. They are not evidence
for later development branches or production behavior, and their older fixture
counts must not be updated to match current `main`.

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
- [Operator event webhooks](operator-event-webhook-checklist.md)
- [Operator bulk event exports](operator-bulk-export-checklist.md)

## Evidence rules

For each private run, record the exact source commit, contract version,
deployment configuration version, synthetic preflight result, authorization,
time range, and residuals. Never commit real values or derived results to this
public repository.

A checked box proves only the named check. It does not imply provider-wide
support, production readiness, or equivalence with another MMP.
