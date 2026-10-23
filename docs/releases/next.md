# Post-rc.2 Scope

Updated: 2026-10-24. This is a living record of remaining work after rc.2,
not a new release note or a promise of a release date.

## Published baseline

`v0.3.0-rc.2` is the published source and SDK prerelease at
`d775cc950bdc06c0c929c9d17e2274ec4afbe9cf`. Its
[release notes](v0.3.0-rc.2.md) and
[synthetic integration record](../validation/v0.3.0-rc.2-synthetic-evidence.md)
remain frozen. The separate
[publication receipt](../validation/v0.3.0-rc.2-publication.md) records the
annotated tag, exact-commit full CI and eight verified public assets.
`v0.2.0` remains the latest stable source release.

## Remaining optional scope

Integrated candidate acceptance
([#252](https://github.com/yubisuke/openmasu/issues/252)) is complete within its
declared synthetic scope. The publication receipt records the downloaded Android
SDK/backend journey on JVM/Robolectric API 24 separately from the frozen release.
It does not establish physical-device or all-platform onboarding acceptance.
The [functional plan](https://github.com/yubisuke/openmasu/issues/218) has
24 of 35 child implementations complete, with 11 optional extensions remaining.
Select further work from the [roadmap](../roadmap.md#next-product-sequence) and
[acceptance crosswalk](../project-plan.md#next-product-slices) according to the
intended usage.

## Separate operator evidence

Live provider permissions/connections, device delivery, store approval, domain
association, production capacity, alert delivery and recovery objectives remain
private operator evidence. Synthetic completion and public prerelease
distribution do not establish provider equivalence or production readiness.
