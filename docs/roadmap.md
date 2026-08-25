# Roadmap

This is the canonical milestone sequence. `docs/project-plan.md` is a phase summary; update both documents and this crosswalk in one change when ordering or exit gates change.

| Canonical roadmap milestone | Project-plan phase | Scope relationship |
| --- | --- | --- |
| M0.2 Contract v0.2 | Phase 0.2 | Contract, registries, fixtures, and evaluators |
| M0.3 Contract v0.3 | Phase 0.3 | Narrow Android/Unity/Meta contract extensions required by M2 |
| M0.4 Contract v0.4 | Phase 0.4 | Identity-only OpenMasu namespace migration and release baseline |
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
- Apache-2.0 licensing is complete; preliminary name clearance was completed on 2026-08-20, while formal trademark clearance remains required before any trademark registration
- A public `SECURITY.md` and a maintainer-approved private reporting path are required before M1a accepts runtime code

Evidence gate: Independently implemented evaluators reproduce the same reviewed canonical outputs from the same synthetic fixtures and policy versions.

## M0.3 Contract v0.3

Contract v0.3 is complete and locally validated. It preserves the M0.2 audit model while adding only the vocabulary and closed evidence shapes required by M2: third-party referrer classification, typed Meta Install Referrer evidence and precedence, imported click evidence, attribution-status metric grouping, a closed custom event, public click-injection classification, revenue precision, and wrapper provenance. The immutable v0.2.1 baseline is the `contract-v0.2.1` Git tag.

Evidence gate: 27 schemas, 8 registries, 47 reviewed synthetic fixtures, both independent evaluators, registry/schema equality, CTIT boundary mutations, optional integrity evidence, and runtime payload-schema rejection pass without real data or credentials.

## M0.4 Contract v0.4

Contract v0.4.0 is complete and mechanically proven equivalent to the immutable `contract-v0.3.6` baseline except for contract-owned identifiers, the OpenMasu namespace, and the resulting fixture-45 digests. The active schemas, registries, fixtures, specification, generated types, and both evaluators use the v0.4 identity as one unit. Metric, attribution, privacy, reconciliation, and fraud semantics are unchanged.

Evidence gate: `npm run verify:contract-rename` reports `SEMANTIC_DIFF=0`, `npm run validate` preserves TypeScript/Python JCS parity across all 47 synthetic fixtures, and the full CI suite passes without real data or credentials.

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

M1b is implemented and locally validated with synthetic inputs. The SQL engine is JCS-byte-identical to the evaluator for the reviewed cohort fixture, supports immutable snapshot supersession and redaction recalculation, and exposes authenticated JSON/CSV metric and difference-audit reads. The 10-million-row synthetic arithmetic floor completed well below ten minutes on the recorded development environment. Contract v0.3 closes the earlier `candidate_missing` and attribution-status grouping follow-ups. Exact 4-vCPU/8-GB cgroup validation remains unperformed.

- Recalculable D0, ROAS, retention, and cohort-LTV metric engine
- Cost and revenue snapshots with versioned FX, grouping, and watermarks
- Difference-audit API for candidates, exclusions, windows, joins, freshness, and neutral reason codes
- Operator-facing real-data validation checklist whose outputs remain outside the public repository

Evidence gate: `npm run test:metric-parity`, `npm run test:integration`, and the reduced CI benchmark pass; the manual third oracle and the recorded 10-million-row run remain reproducible without real data or credentials.

## M1.5 Continuation decision gate

This milestone has no code deliverable. The owner reviews the operator-run validation record, implementation and operating cost, unresolved platform limitations, and the evidence from M1a/M1b. The recorded decision is to continue as an audit layer, proceed toward a first-party measurement layer, or stop further expansion. Real exports, credentials, campaign values, and validation results remain outside this public repository.

Evidence gate: A dated owner decision identifies the selected path and the evidence used, without publishing protected or provider-confidential data.

## M2 Android, Unity, and redirector

M2a and M2b are implemented and synthetically validated. The Node redirector, stored tracking links, HMAC SDK enrollment and ingestion, ephemeral replay state, encrypted durable batches, ordered worker drain, late-click supersession, credential-bound deletion, Kotlin SDK, Unity bridge, Android emulator workflow, Android SBOM, and operator checklist are present. Real-device, Play internal-track, live Meta/MAX, and Unity-export evidence remains explicitly operator-verified and outside the code gate.

- Unity C# SDK and Android Kotlin bridge
- Google Play Install Referrer client and deterministic first-party attribution
- Portable Node.js redirector; a Cloudflare Workers redirector may be offered as an optional adapter
- Meta Install Referrer decryption after primary-source field verification
- Offline queue, retry, batch delivery, SDK disablement, and identifier reset
- Advertising-revenue callback, sample application, and device and Play internal-testing procedure
- Complete Android SDK field inventory, Google Play Data safety mapping, consent-queue tests, and backup/restore exclusion for `installation_id`

Evidence gate: An API 36 emulator first launch reads synthetic referrer evidence, sends one signed non-conflicting install through a local ingestion shell, and proves committed queue survival across process death. The runtime integration gate separately validates durable ingestion and attribution. Real-device and campaign validation remains separately labeled until performed.

## M3 Metrics dashboard

M3 is implemented on synthetic evidence. It uses dependency-free server-rendered HTML and SVG, tenant-scoped opaque sessions, a forced-RLS reader role, one typed filter/SQL-builder path shared by API and dashboard, additive CSV columns, aggregate-only record counts, and fixed-watermark consistency checks. Real-browser, production-TLS, real-cardinality, and five-day operator observations remain in the [M3 operator checklist](validation/m3-operator-checklist.md).

- App registration and measurement-link creation
- ROAS, retention, cohort, and attribution breakdowns
- CSV export
- Attribution method, policy version, grouping, and data-freshness display
- Authentication established before exposing any dashboard data

Evidence gate: `npm run verify:consistency` compares raw aggregate counts, reporting rows, the typed dashboard view, and rendered numeric attributes under at least eight synthetic filter combinations at one fixed watermark. Runtime CI separately proves reader RLS, SQL/evaluator metric parity, CSV byte identity, and the API runtime SBOM baseline.

## M4a iOS first-party measurement

M4a is implemented with synthetic evidence. The Swift Package, excluded SQLite
queue, HMAC delivery, consent/reset lifecycle, AdServices token handoff, MAX
mapping, Unity C ABI, Privacy Manifest, built-symbol audit, and dependency-empty
iOS SDK SBOM are executable gates in the pinned macOS workflow. Real-device,
live Apple/MAX, Unity-export, and App Store evidence remains in the
[M4 checklist](validation/m4-device-checklist.md).

- Swift SDK and Unity iOS bridge
- First-party events, persistent delivery queue, consent controls, and advertising-revenue evidence
- Apple AdServices token collection and server lookup after current primary-source verification
- Apple Privacy Manifest and App Privacy Details mapping

Evidence gate: The macOS CI sample compiles and synthetic install, event, conversion-value, and revenue paths reproduce the shared contract vectors. Real-device and Apple Ads validation remain separately labeled until performed.

## M4b Apple aggregate attribution

M4b is implemented with synthetic evidence. SKAdNetwork and AdAttributionKit
receivers verify generated signatures, reject replay/conflict, resolve tenancy
without enumeration, drive protected AdServices lookup, and persist separate
aggregate metric series. Historical aggregate metrics respect their fixed
watermark.

- SKAdNetwork and AdAttributionKit developer postback-copy receipt
- Signature and transaction-ID verification and replay rejection
- Versioned conversion-tag and value policy
- Aggregate reporting that never mixes the aggregate series with deterministic installation-level attribution

Evidence gate: Runtime CI produces verified, replay-resistant synthetic postbacks and aggregate results; live Apple delivery remains an operator procedure.

## M5 Production and limited adapter boundary

M5 is implemented as a synthetic code and CI milestone. It adds minimum
tenant-wide RBAC, authenticated Prometheus text metrics, closed structured
logging, backup/restore privacy reapplication, deletion/recalculation/export
evidence, append-only rule-bundle history, and an integrity-evidence contract
reservation. It does not claim a production deployment or live integrity
integration.

- Tenant isolation and minimum `admin | operator | read_only` RBAC
- Existing rate controls plus an informational [100,000-event and 10,000-postback synthetic load record](validation/m5-load-results.md)
- PostgreSQL custom-format backup/restore procedure and completed-privacy-request reapplication
- Authenticated dependency-free operational metrics; full OpenTelemetry is deferred until operational cardinality or tracing needs justify it
- Play Integrity and App Attest evidence fields and operator procedures only; no live project configuration
- Rule-bundle identifiers, versions, hashes, supersession history, and audit rows
- Adapter boundary limited to first-party evidence, Meta Install Referrer, and Apple Ads/Apple aggregate evidence
- User-level attribution for TikTok, AppLovin, Unity Ads, and Mintegral remains unsupported when it requires a partner MMP or non-public provider evidence
- Final threat-model review, all existing workspace/SDK SBOMs, and tenant-isolation, replay, deletion, and backup/restore CI evidence

Evidence gate: CI restores a synthetic PostgreSQL 17 custom-format dump into a
new database, reapplies completed privacy requests, proves restored encrypted
payloads remain unreadable, and verifies recalculated exports. CI also records
synthetic HTTP load and retains all prior replay, isolation, dashboard, SDK, and
contract gates. A production pilot remains an operator gate.

## Immediate next step

Run the operator checklists and a controlled shadow pilot. Real provider connectivity, device validation, platform approval, production TLS, backup operations, capacity, integrity-service configuration, and incident response remain separate states.
