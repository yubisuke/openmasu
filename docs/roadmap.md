# Roadmap

This is the canonical milestone sequence. `docs/project-plan.md` is a phase summary; update both documents and this crosswalk in one change when ordering or exit gates change.

| Canonical roadmap milestone | Project-plan phase | Scope relationship |
| --- | --- | --- |
| M0.2 Contract v0.2 | Phase 0.2 | Contract, registries, fixtures, and evaluators |
| M1a Shadow ledger and import foundation | Phase 1a | Received-evidence ledger, three import paths, and runtime security foundation |
| M1b Cohort metrics and difference audit | Phase 1b | Recalculable decision metrics and neutral reconciliation |
| M1.5 Continuation decision gate | Phase 1.5 | Owner decision based on operator-run validation; no code deliverable |
| M2 Android, Unity, and redirector | Phase 2 | Native deterministic vertical slice and optional edge redirector |
| M3 Metrics dashboard | Phase 3 | Reporting surface over the same definitions |
| M4a iOS first-party measurement | Phase 4a | Swift SDK, revenue, and Apple Ads first-party evidence |
| M4b Apple aggregate attribution | Phase 4b | Separate SKAdNetwork and AdAttributionKit aggregate series |
| M5 Production and limited adapter boundary | Phase 5 | Production controls, fraud boundary, and deliberately limited adapters |

## M0.2 Contract v0.2

Contract v0.2 is complete and the full local contract validation suite passes. It retains the M0.1 hardening and adds imported provider-reported attribution, automatic neutral reconciliation, reporting dimensions, cost and cohort metrics, Apple aggregate envelopes, a minimal verified Meta envelope, and a closed processing-purpose catalog. The immutable v0.1 baseline is the `contract-v0.1` Git tag.

- Versioned event envelope and raw-record contract
- Attribution result, reason codes, state transitions, and reconciliation
- Retraction, redaction, privacy-request, and processing-purpose contracts
- D0, ROAS, retention, and cohort metric definitions
- Synthetic duplicate, conflict, late, missing, import, aggregate, and platform fixtures
- Public fraud-evidence schema and private live-policy boundary
- Independently implemented TypeScript and Python evaluators
- Apache-2.0 licensing is complete; name and trademark clearance remains a release prerequisite owned by the project maintainer before the first public release
- A public `SECURITY.md` and a maintainer-approved private reporting path are required before M1a accepts runtime code

Evidence gate: Independently implemented evaluators reproduce the same reviewed canonical outputs from the same synthetic fixtures and policy versions.

## M1a Shadow ledger and import foundation

M1a is implemented and locally validated with synthetic inputs. PostgreSQL runtime parity, import idempotency/restatement, MAX receipt, deletion, encryption/purge, rate limits, environment coverage, SBOM generation, and threat coverage are executable gates. External API account connectivity, operator real-data validation, production TLS, capacity, and deployment operations remain unverified by design.

- PostgreSQL append-only received-evidence ledger with lawful correction and redaction records
- Docker Compose, Node.js API and worker services, and automated migrations and tests
- Public Shadow Import Profile for existing MMP exports, a media-cost import, and an advertising-revenue import or postback path; provider mappings and certification remain deployment-private
- Normalized logical records, authenticated tenant scope, idempotent import, and protected payload envelope encryption
- Request payload and batch limits plus application-level rate limiting for every runtime ingestion and import endpoint
- Runtime replay of the reviewed synthetic contract fixtures through the real ingestion and import paths
- Private vulnerability reporting, TLS 1.2-or-later transport evidence, ledger-isolation tests, deletion recalculation tests, and an SBOM for every runtime artifact

Evidence gate: A clean Docker Compose startup ingests the synthetic fixtures through runtime paths and reproduces the reviewed contract artifacts without using real data or external credentials.

## M1b Cohort metrics and difference audit

M1b is implemented and locally validated with synthetic inputs. The SQL engine is JCS-byte-identical to the evaluator for the reviewed cohort fixture, supports immutable snapshot supersession and redaction recalculation, and exposes authenticated JSON/CSV metric and difference-audit reads. The 10-million-row synthetic arithmetic floor completed well below ten minutes on the recorded development environment. Exact 4-vCPU/8-GB cgroup validation, the contract vocabulary for a withheld `candidate_missing` case, and a contract grouping dimension that separates organic from unattributed cohorts remain explicit follow-up work.

- Recalculable D0, ROAS, retention, and cohort-LTV metric engine
- Cost and revenue snapshots with versioned FX, grouping, and watermarks
- Difference-audit API for candidates, exclusions, windows, joins, freshness, and neutral reason codes
- Operator-facing real-data validation checklist whose outputs remain outside the public repository

Evidence gate: `npm run test:metric-parity`, `npm run test:integration`, and the reduced CI benchmark pass; the manual third oracle and the recorded 10-million-row run remain reproducible without real data or credentials.

## M1.5 Continuation decision gate

This milestone has no code deliverable. The owner reviews the operator-run validation record, implementation and operating cost, unresolved platform limitations, and the evidence from M1a/M1b. The recorded decision is to continue as an audit layer, proceed toward a first-party measurement layer, or stop further expansion. Real exports, credentials, campaign values, and validation results remain outside this public repository.

Evidence gate: A dated owner decision identifies the selected path and the evidence used, without publishing protected or provider-confidential data.

## M2 Android, Unity, and redirector

- Unity C# SDK and Android Kotlin bridge
- Google Play Install Referrer client and deterministic first-party attribution
- Portable Node.js redirector; a Cloudflare Workers redirector may be offered as an optional adapter
- Meta Install Referrer decryption after primary-source field verification
- Offline queue, retry, batch delivery, SDK disablement, and identifier reset
- Advertising-revenue callback, sample application, and device and Play internal-testing procedure
- Complete Android SDK field inventory, Google Play Data safety mapping, consent-queue tests, and backup/restore exclusion for `installation_id`

Evidence gate: A Google Play first launch retrieves synthetic click evidence through the portable runtime and produces one non-conflicting install record; device validation remains separately labeled until performed.

## M3 Metrics dashboard

- App registration and measurement-link creation
- ROAS, retention, cohort, and attribution breakdowns
- CSV export
- Attribution method, policy version, grouping, and data-freshness display
- Authentication established before exposing any dashboard data

Evidence gate: Raw records, reporting API, and dashboard match under identical filters and definitions.

## M4a iOS first-party measurement

- Swift SDK and Unity iOS bridge
- First-party events, persistent delivery queue, consent controls, and advertising-revenue evidence
- Apple AdServices token collection and server lookup after current primary-source verification
- Apple Privacy Manifest and App Privacy Details mapping

Evidence gate: An iOS test application delivers synthetic install, event, and revenue evidence to the ledger; real-device and Apple Ads validation remain separately labeled until performed.

## M4b Apple aggregate attribution

- SKAdNetwork and AdAttributionKit developer postback-copy receipt
- Signature and transaction-ID verification and replay rejection
- Versioned conversion-tag and value policy
- Aggregate reporting that never mixes the aggregate series with deterministic installation-level attribution

Evidence gate: Apple test procedures produce verified, replay-resistant postbacks and aggregate results.

## M5 Production and limited adapter boundary

- Tenant isolation and RBAC
- Full production rate policy, backup and restore, and deletion-request end-to-end flow
- OpenTelemetry, load tests, SDK distribution, and compatibility policy
- Play Integrity and App Attest integration
- Rule-bundle versions, digests, and supersession history
- Signed, least-privilege adapters limited to first-party links, Meta, and Apple Ads, with primary-source revalidation and fixture certification before implementation
- Other media-network adapters are outside the current roadmap unless a later owner decision and primary-source evidence explicitly add them
- Final threat-model review, production SBOM, and tenant-isolation, replay, deletion, and backup/restore evidence

Evidence gate: A production pilot completes backup restoration, deletion, replay, failure, and shadow-reconciliation exercises with documented evidence.

## Immediate next step

Run the M1a CI and operator checklist, then implement M1b cohort metrics and neutral difference audit. Real provider connectivity, operator-run validation, device validation, platform approval, and production evidence remain separate states.
