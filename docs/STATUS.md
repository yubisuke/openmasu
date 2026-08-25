# Project Status

Checked on 2026-08-20. “Implemented” below means source and synthetic automated
evidence are present. It does not mean a production deployment, real provider
connection, device validation, platform approval, or operator acceptance.

| Milestone | State | Implemented evidence | Residual boundary |
| --- | --- | --- | --- |
| M0.4 Contract v0.4.0 | Implemented | 27 schemas, 8 registries, 47 reviewed synthetic fixtures, independent TypeScript/Python evaluators, RFC 8785 parity, optional integrity evidence, runtime schema-rejection evidence, identity-only OpenMasu migration proof | No real data, provider token, device identifier, or live fraud rule is validated |
| M1a Shadow ledger/import | Implemented | PostgreSQL append-only/RLS ledger, encrypted payload port, three synthetic import paths, runtime-to-golden parity, SBOM | Real exports, provider credentials, production TLS, external KMS, and deployment operations are unverified |
| M1b Metrics/difference audit | Implemented | SQL/evaluator parity, fixed snapshots, supersession/redaction recalculation, authenticated JSON/CSV audit, synthetic performance floor | A real shadow pilot and exact 4-vCPU/8-GB capacity remain unverified |
| M2 Android/Unity/redirector | Implemented | HMAC durable ingestion, deterministic referrer path, Kotlin SDK, Unity bridge, emulator CI, Android SBOM | Real Play/Meta/MAX campaigns, devices, backup transfer, and Unity export remain operator checks |
| M3 Dashboard | Implemented | Forced-RLS reader, opaque sessions, zero-JavaScript server rendering, fixed-watermark four-way consistency, CSV parity | Production TLS, real-cardinality usability, shared login throttling, and operator observation remain open |
| M4a iOS first-party | Implemented | Swift SDK, protected excluded queue, AdServices handoff, MAX revenue mapping, Unity iOS source bridge, simulator/build/SBOM gates | Real Apple Ads, App Store review, device backup/transfer, live MAX, and Unity Xcode export remain open |
| M4b Apple aggregate | Implemented | Synthetic SKAdNetwork/AdAttributionKit signature verification, replay resistance, protected postbacks, separate aggregate series | Live developer-copy delivery, Apple latency, and production conversion policy remain open |
| M5 Production controls | Implemented in code/CI | Minimum RBAC, authenticated Prometheus metrics, closed structured logs, privacy-safe restore job, deletion/recalculation/export E2E, rule-bundle history, [synthetic HTTP load record](validation/m5-load-results.md), release runbooks and SBOM connection | Production hosting, TLS, backup operations, real load, live integrity projects, incident response, GitHub controls, and formal trademark clearance remain operator-owned |

## Supported adapter boundary

The supported attribution evidence is first-party measurement, Meta Install
Referrer, and Apple Ads/Apple aggregate evidence. AppLovin MAX is revenue
evidence. TikTok, AppLovin, Unity Ads, and Mintegral user-level attribution is
not supported where the required evidence depends on partner-MMP status or a
non-public provider interface.

## Next evidence step

Run the operator checklists in an authorized isolated environment, then conduct
a bounded shadow pilot without treating OpenMasu as the primary source. Keep
real exports, credentials, campaign values, device identifiers, provider
tokens, and validation records outside this public repository.
