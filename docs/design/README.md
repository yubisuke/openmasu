# Current Design Documents

These documents describe the implemented source tree and its residual
boundaries. Their status phrase "implemented and synthetically verified" uses
the evidence vocabulary in [Project status](../STATUS.md); it never means live
provider, real-device, operator, or production verification.

| Subsystem | Current design |
| --- | --- |
| Ledger, imports, deterministic metrics, and reconciliation | [Ledger, Import, and Metric Design](m1-baseline.md) |
| Android, Unity, measurement links, and redirector | [Android, Unity, and Redirector Design](m2-baseline.md) |
| API, exports, dashboard, and reader isolation | [Dashboard and Reporting Design](m3-baseline.md) |
| iOS, AdServices, SKAdNetwork, and AdAttributionKit | [iOS and Apple Measurement Design](m4-baseline.md) |
| Public deterministic fraud rules and integrity evidence | [Deterministic Fraud Design](fraud-baseline.md) |
| Direct links, Android deferred links, and device-reported engagement | [Deep Link and Re-engagement Design](deeplink-baseline.md) |
| Google Play and App Store verified-commerce lifecycle | [Verified Commerce Lifecycle Design](verified-commerce-lifecycle.md) |
| Data-subject access, privacy lifecycle, and rule provenance | [Audit, Privacy, and Rule Provenance Design](audit-privacy-provenance.md) |

The normative Contract v0.4 behavior remains in the
[contract specification](../../spec/event-metric-contract-v0.4.md), schemas,
registries, and reviewed fixtures. Historical proposals and review decisions
under `docs/review/` do not override these current designs.
