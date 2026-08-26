# Project Status

Checked on 2026-08-26 for the `v0.2.0-rc.2` release candidate. “Implemented” below means source and synthetic automated
evidence are present. It does not mean a production deployment, real provider
connection, device validation, platform approval, or operator acceptance.

| Milestone | State | Implemented evidence | Residual boundary |
| --- | --- | --- | --- |
| M0.4 Contract v0.4 (definitions through v0.4.9) | Implemented | 28 schemas, 8 registries, 56 reviewed synthetic fixtures, independent TypeScript/Python evaluators, RFC 8785 parity, optional integrity/deep-link evidence, canonical settled purchase/refund net revenue, D30/D90 total-net ROAS and cohort LTV, runtime schema-rejection evidence, identity-only OpenMasu migration proof | No real data, live store/private-provider purchase verification, provider token, device identifier, or live fraud rule is validated |
| M1a Shadow ledger/import | Implemented | PostgreSQL append-only/RLS ledger, encrypted payload port, three synthetic import paths, executable append-only MAX aggregate-revenue snapshots with restatement/current-view semantics, runtime-to-golden parity, SBOM | Real exports, provider credentials and response reconciliation, production TLS, external KMS, and deployment operations are unverified |
| M1b Metrics/difference audit | Implemented | SQL/evaluator parity, fixed snapshots, supersession/redaction recalculation, authenticated JSON/CSV audit, synthetic performance floor | A real shadow pilot and exact 4-vCPU/8-GB capacity remain unverified |
| M2 Android/Unity/redirector | Implemented | HMAC durable ingestion, deterministic referrer path, Kotlin SDK, Unity bridge, synthetic Google Play purchase verification, authenticated RTDN lifecycle ingestion, exact Orders refund correction, emulator CI, Android SBOM | Real Play Billing/Pub/Sub credentials, tokens, notifications, orders, entitlement/acknowledgement, complete missed-renewal history, Play/Meta/MAX campaigns, devices, backup transfer, and Unity export remain operator checks |
| M3 Dashboard | Implemented | Forced-RLS reader, opaque sessions, zero-JavaScript server rendering, fixed-watermark four-way consistency, CSV parity | Production TLS, real-cardinality usability, shared login throttling, and operator observation remain open |
| M4a iOS first-party | Implemented | Swift SDK, protected excluded queue, AdServices handoff, MAX revenue mapping, Unity iOS source bridge, simulator/build/SBOM gates | Real Apple Ads, App Store review, device backup/transfer, live MAX, and Unity Xcode export remain open |
| M4b Apple aggregate | Implemented | Synthetic SKAdNetwork/AdAttributionKit signature verification, replay resistance, protected postbacks, separate aggregate series | Live developer-copy delivery, Apple latency, and production conversion policy remain open |
| M5 Production controls | Implemented in code/CI | Minimum RBAC, authenticated Prometheus metrics with durable fixed-label operator-job completion counts/timestamps, closed structured logs, privacy-safe restore job, deletion/recalculation/export E2E, rule-bundle history, [synthetic HTTP load record](validation/m5-load-results.md), release runbooks and SBOM connection | Production hosting, TLS, scheduler and notification routing, alert thresholds/ownership, backup operations, real load, live integrity projects, incident response, GitHub controls, and formal trademark clearance remain operator-owned |
| M6 Fraud controls | Implemented in code/CI | Server-time and source-day rules, bounded click-edge evidence, registered-definition bundle binding across every fraud path, negative-CTIT clock diagnostics, gross/net metrics, quarantine resolution, aggregate audit output, protected Play Integrity/App Attest adapter boundary, synthetic outage and replay gates | Threshold calibration, real traffic, real-device farms, reset fraud, live provider projects/tokens/quotas/key rotation, false-positive rates, and cross-advertiser intelligence remain operator checks |
| M7 Deep links and re-engagement | Implemented in code/CI | Tenant-owned link hosts, deterministic association files, destination grammar and referrer budget, typed Android/iOS/Unity direct opens, Android deferred delivery, engagement-scope attribution, and separated daily metrics | Real domains, store tracks, devices, propagation, reinstall behavior, Unity exports, and four-week re-engagement observation remain operator checks; iOS deferred deep linking is not offered, and device-reported opens remain forgeable evidence |
| Post-M7 verified conversion delivery | Implemented in code/CI | Play-verified settled purchases, source-qualified Google Ads clicks, encrypted durable requests, stable transaction IDs, bounded Data Manager ingest and diagnostics state machine, deletion-before-dispatch purge, and fixed operational health metrics | Live Google authorization, destination acceptance, quota, diagnostics latency, provider retention, and post-dispatch provider retraction remain operator checks |
| Post-M7 SDK integration and local distribution | Implemented in code/CI | Unity Android selects the Play reader by default and configured Meta reader with fail-closed optional-module behavior; CI creates deterministic Maven AAR/POM, UPM, and Swift source artifacts with Android/iOS/Unity CycloneDX SBOMs and SHA-256 coverage | Public registry publication, artifact signing, real provider reads, real devices, Unity exports, and consumer-project acceptance remain operator or separately approved release work |
| Post-M7 verified commerce lifecycle | Implemented in code/CI | Google OIDC-authenticated lifecycle signals and exact Orders refunds; App Store Notifications V2 outer/nested JWS verification; encrypted durable read-back with revision cursors; provider-neutral safe facts, privacy purge, and retry/idempotency evidence | Live store credentials, notification delivery, quota/root rotation, complete missed Google renewal reconstruction, Apple installation/revenue binding, entitlements, tax, payout, and production operations remain unverified |
| Post-M7 audit, privacy, and provenance | Implemented in code/CI | Installation-scoped SDK-authenticated access/portability responses; digest-only DSAR and deep-link claim audits; canonical registered/default attribution, metric, and Apple postback rule-bundle provenance across TypeScript, Python, runtime, and stored artifacts | An SDK installation credential proves control of that installation only, direct deep-link opens remain forgeable device claims, and custom non-fraud rule semantics require a separately reviewed contract evolution |

## Supported adapter boundary

The supported attribution evidence is first-party measurement, Meta Install
Referrer, and Apple Ads/Apple aggregate evidence. AppLovin MAX is revenue
evidence. TikTok, AppLovin, Unity Ads, and Mintegral user-level attribution is
not supported where the required evidence depends on partner-MMP status or a
non-public provider interface.

## Next evidence step

Keep the host preflight and disposable synthetic Runtime workflow green at each
release commit. Provider, device, deployment, capacity, and operator evidence is
outside this release's code gate, but is required before a production or
primary-source decision and requires a separately authorized isolated
environment. Real exports, credentials, campaign values, device identifiers,
provider tokens, and private validation records must remain outside this public
repository.
