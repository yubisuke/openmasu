# Post-rc.2 Scope

Updated: 2026-10-25. This is a living record of remaining work after rc.2,
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

Current source now adds [daily recorded activity](../calendar-activity.md):
three UTC metrics, schedules and saved CSV with explicit installation units.
This post-rc.2 addition is not part of the published rc.2 assets or evidence.
It also adds [verified payer metrics](../payer-metrics.md): D7 transactions,
paying installations, payer rate and purchase-net ARPPU. Full refunds retain
historical payers; zero-payer ARPPU is undefined. No SDK release is implied.

[Scheduled comparisons](../recurring-comparisons.md) add private aggregate-only
storage, immutable revisions, fixed-cutoff worker results and explicit retention,
deletion and privacy suppression. Inputs are operator deposited, not live fetched.

[Google detail costs](../cost-refresh.md#explicit-google-ad-group-and-ad-costs)
add explicit ad-group/ad selection and creative binding. Additive contract patch
0.4.27 records matching-detail-only coverage without changing wire identity or
earlier goldens. Selected spend cannot be allocated to parents or siblings.
Live provider permissions, mapping correctness and completeness remain unverified.

[Recorded-detail discovery](../scheduled-metrics.md#discover-selected-ad-groups-or-creatives)
reuses frozen daily target receipts for ad-group/creative tuples. Missing detail
and parent-only cost are explicit partial observations, not fabricated targets;
restarts retain the frozen set and later dates may adopt newly recorded detail.

Integrated candidate acceptance
([#252](https://github.com/yubisuke/openmasu/issues/252)) is complete within its
declared synthetic scope. The publication receipt records the downloaded Android
SDK/backend journey on JVM/Robolectric API 24 separately from the frozen release.
It does not establish physical-device or all-platform onboarding acceptance.
The [functional plan](https://github.com/yubisuke/openmasu/issues/218) has
33 of 35 child implementations complete, with 2 optional extensions remaining.
Select further work from the [roadmap](../roadmap.md#next-product-sequence) and
[acceptance crosswalk](../project-plan.md#next-product-slices) according to the
intended usage.

[Optional app-scoped access](../operations/access.md) narrows existing role
capabilities consistently across API and dashboard workflows. Existing keys keep
tenant-wide access; scoped keys cannot use global controls. This source feature
does not change the published SDKs or the event contract.

[Explicit retention](../operations/retention.md) adds default-off operator
preview/apply with immutable bounded targets, crash-safe retry and current
retention-affected report provenance. It does not purge ledger/privacy history,
credentials, all object classes or backups and does not choose a legal duration.

The optional [Unity LevelPlay ILR sample](../../sdk/unity/README.md#optional-levelplay-impression-revenue)
adds per-ad background callbacks, explicit consent and stable impression identity
through existing Android/iOS queues. Synthetic provider-shim/native/backend
evidence is not actual provider or device execution. It is not in rc.2 assets.

[Explicit engagement policy](../engagement-outcomes.md#explicit-outcome-window-and-recorded-inactivity)
adds independent 1–30-day outcomes, recorded SDK inactivity with an explicit
unknown state, and verified purchase/partial-refund net. Historical 24h outputs
and acquisition/Apple series stay unchanged. Contract patch 0.4.28 retains wire
identity and earlier goldens; it adds no new SDK release or live qualification.

## Separate operator evidence

Live provider permissions/connections, device delivery, store approval, domain
association, production capacity, alert delivery and recovery objectives remain
private operator evidence. Synthetic completion and public prerelease
distribution do not establish provider equivalence or production readiness.
