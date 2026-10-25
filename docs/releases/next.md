# Work After rc.3

Updated: 2026-10-26. This is the living follow-up list, not a release promise.

## Published baseline

[v0.3.0-rc.3](https://github.com/yubisuke/openmasu/releases/tag/v0.3.0-rc.3)
is the published source and SDK prerelease at
`2d689dc63546e5a2121fd0026d83f04aa8cc3f7d`. Its
[publication receipt](../validation/v0.3.0-rc.3-publication.md) records exact-source
full CI, eight verified public assets and downloaded Android SDK onboarding.
The [frozen notes](v0.3.0-rc.3.md) describe the included functionality.
All 35 child implementations in the
[functional plan](https://github.com/yubisuke/openmasu/issues/218) are included.
This documentation update adds no functionality or SDK bytes.

## Concrete next work

- [#315](https://github.com/yubisuke/openmasu/issues/315): add a safe upgrade
  from the published rc.2. The current preflight deliberately rejects that source
  with `upgrade_source_unsupported`. Extend the existing backup/upgrade path;
  never relabel an old backup, bypass preflight or reset a ledger to work around it.
- [PR #290](https://github.com/yubisuke/openmasu/pull/290): qualify the timezone
  data update separately against calendar boundaries. rc.3 retains the qualified
  version; it is not a missing release gate.

The first-use dependency findings in
[#316](https://github.com/yubisuke/openmasu/issues/316) were fixed before rc.3
publication. Do not reopen completed scope as speculative feature work.

## Evidence boundary

Use rc.3 in a new disposable synthetic instance. Live provider permissions,
physical-device delivery, store approval, domain association, production
capacity, alerts and recovery objectives remain separate operator evidence.
No real credentials, devices or data are required for the follow-up development
above. Synthetic completion is not provider equivalence or production readiness.

See [project status](../STATUS.md), [roadmap](../roadmap.md#next-product-sequence)
and the [acceptance crosswalk](../project-plan.md#next-product-slices).
