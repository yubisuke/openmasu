# OpenMasu Project Plan

## Product hypothesis

OpenMasu does not begin by copying every feature of an established MMP. It begins by solving two problems: measurements that cannot be explained and economics that cannot be tied to visible processing and storage costs.

The product therefore starts as a Shadow MMP alongside an existing provider.

- Store first-party events independently
- Normalize existing MMP and media outputs into a common contract
- Recalculate attribution and revenue under explicit definitions
- Explain neutral measurement differences through candidates, exclusion reasons, windows, joins, and freshness; these categories do not score provider quality
- Move a measurement path to primary status only after an operator-run shadow pilot validates it and the owner explicitly chooses that direction

The project is an open-source product for self-hosting teams. No company-specific replacement is assumed. Real deployment data may be used by an operator outside the public repository to test whether the contract represents reality, but it is not a repository artifact or a public completion gate.

## Open and private boundaries

### Open

- Event and Metric Contract
- Attribution algorithms and versions
- Database schema and recalculation model
- Duplicate, conflict, delay, and missing-data fixtures
- Fraud evidence types and reason taxonomy
- Media-adapter interfaces and declared support status
- Infrastructure-cost calculation method

### Private and deployment-specific

- API keys, signing keys, and media tokens
- Live fraud thresholds and rule combinations
- Detection-model weights
- IP, device, and operator watchlists
- Detection-response timing
- Real user, campaign, cost, revenue, and provider-export evidence

Fraud decisions retain evidence references, reason codes, rule-bundle versions and digests, evaluation time, action, and supersession history. A later delayed-transparency policy for retired rules may be considered, but it is not part of v0.3.

## Execution phases

`docs/roadmap.md` is the canonical execution order and contains the project-plan crosswalk. This document is a phase summary and must be updated with that crosswalk when the roadmap changes.

### Phase 0.2: Contract v0.2

Contract v0.2 is complete and its local validation gate passes. It includes the in-place consistency migration plus imported provider-reported attribution, automatic neutral reconciliation, typed reporting dimensions, cost and cohort metrics, Apple aggregate envelopes, a minimal verified Meta envelope, and the closed processing-purpose catalog. It remains contract evidence, not production-runtime readiness.

### Phase 0.3: Contract v0.3

Contract v0.3 is complete and locally validated. It adds only the closed Android/Unity/Meta evidence required by Phase 2, including third-party referrer classification, typed Meta Install Referrer evidence, attribution-status grouping, custom events, click-injection classification, revenue precision, and wrapper provenance. It does not claim an SDK, device run, live campaign, or production integration.

### Phase 0.4: Contract v0.4

Contract v0.4.0 completes the identity-only OpenMasu namespace migration. A tag preserves the complete v0.3.6 baseline, and a mechanical verifier proves that schema structure, registry vocabularies, fixture semantics, metric/rule versions, and evaluator behavior do not drift. This phase adds no measurement capability and no production-readiness claim.

### Phase 1a: Shadow ledger and import foundation

M1a is implemented and locally validated with synthetic evidence. The public repository does not contain or claim real provider/account validation.

- PostgreSQL received-evidence ledger, normalized logical records, corrections, and redactions
- Docker Compose with portable Node.js API and worker services
- Three runtime import paths: public Shadow Import Profile, media cost, and advertising revenue
- Authenticated tenant scope, idempotency, payload and batch limits, baseline rate limiting, envelope encryption, audit logs, tests, and SBOMs
- Runtime reproduction of reviewed synthetic contract fixtures
- Private vulnerability reporting, TLS 1.2-or-later transport evidence, ledger-isolation tests, and deletion recalculation tests

### Phase 1b: Cohort metrics and difference audit

Phase 1b is implemented and locally validated with synthetic PostgreSQL data. Snapshot supersession, SQL/evaluator parity, redaction recalculation, undefined ROAS, JSON/CSV export, persisted difference evidence, a third oracle, and a 10-million-row arithmetic floor have executable evidence. Contract v0.3 closes the two vocabulary/grouping follow-ups. Exact 4-vCPU/8-GB capacity validation remains outside the completed runtime change.

- Recalculable D0, ROAS, retention, and cohort-LTV engine
- Versioned cost, revenue, FX, grouping, and watermark handling
- Difference-audit API for candidates, exclusions, windows, joins, freshness, and neutral reasons
- Operator-facing validation checklist; its real-data results stay outside the public repository

### Phase 1.5: Continuation decision gate

There is no code deliverable. The owner uses the M1a/M1b evidence, operator-run validation, operating cost, and unresolved platform limits to choose one path: continue as an audit layer, proceed toward a first-party measurement layer, or stop further expansion.

### Phase 2: Android, Unity, and redirector

M2a and M2b are complete on synthetic evidence: the portable redirector, HMAC app and installation authentication, durable batch processing, Kotlin SDK, Install Referrer/Meta/MAX modules, Unity UPM bridge, native and Unity samples, emulator evidence, Android SBOM, and operator checklist are present without changing contract v0.3. Real-device, real-Play, live Meta/MAX, and Unity-export validation remains an external operator responsibility and is not a code-completion claim.

- Unity C# SDK and Android Kotlin bridge
- Google Play Install Referrer and versioned deterministic attribution
- Portable Node.js redirector, with an optional Cloudflare Workers adapter only for that redirector
- Meta Install Referrer decryption against the v0.3 typed evidence fields, using synthetic vectors for the code gate
- Persistent queue, retry, idempotency, identifier reset, and sample application

### Phase 3: Metrics dashboard

Phase 3 is implemented on synthetic evidence. The dashboard is served by the existing API process as server-rendered, zero-JavaScript HTML/SVG and shares the reporting query builder and encoder rather than calling a second reporting implementation.

- App registration, measurement-link creation, and authenticated reporting
- ROAS, retention, cohort, and attribution views
- Raw, report, and dashboard consistency under identical definitions
- Fixed-watermark consistency across aggregate record counts, API rows, typed views, and rendered values
- Reader-role RLS, opaque sessions, CSRF/Origin protection, and a no-growth API runtime SBOM gate

### Phase 4a: iOS first-party measurement

Implemented with synthetic Swift, Simulator, server-ingestion, privacy-manifest,
Unity bridge, and SBOM gates. Real-device and live-provider evidence remains
operator-owned.

- Swift SDK and Unity iOS bridge
- First-party events, advertising revenue, persistent delivery, and consent controls
- Apple AdServices evidence and required privacy disclosures

### Phase 4b: Apple aggregate attribution

Implemented with generated signature vectors, replay/conflict tests, protected
AdServices lookup, fixed-watermark metrics, and separate dashboard/API series.

- SKAdNetwork and AdAttributionKit developer postback-copy receipt
- Verification, replay rejection, versioned conversion-value policy, and aggregate reporting
- No mixing of aggregate iOS reports with deterministic installation-level attribution

### Phase 5: Production and limited adapter boundary

Implemented as a synthetic code/CI phase: tenant-wide minimum RBAC, existing
rate controls, closed structured logging, authenticated Prometheus metrics,
informational load measurement, privacy-safe backup restoration, deletion
recalculation/export evidence, rule-bundle history, and release runbooks.

- Play Integrity and App Attest are reserved as optional evidence and remain operator-configured; they are not live integrations.
- Supported attribution evidence is limited to first-party links, Meta Install Referrer, and Apple Ads/Apple aggregate paths.
- AppLovin MAX remains revenue evidence. TikTok, AppLovin, Unity Ads, and Mintegral user-level attribution is unsupported where partner-MMP or non-public evidence is required.
- Production TLS, real backup recovery, real load, provider/device delivery, integrity projects, incident response, and formal trademark clearance before registration remain operator-owned gates.

### Phase 6: Deterministic fraud controls

Implemented through a public, replayable rule package, source-day aggregates, real fraud-bundle JCS binding, gross/net cohort policy, deadline-bound quarantine, and an aggregate-only audit report. Play Integrity and App Attest are normalized through a protected server-verification boundary, but real provider projects and real devices remain operator evidence.

- No device fingerprinting, third-party IP/device intelligence, device graph, or cross-advertiser history.
- Real-device farms cannot be detected from the permitted evidence; reset fraud is intentionally not detected.
- Default actions are conservative flags and do not change metrics.
- Threshold calibration, real provider availability, and chargeback acceptance remain operator work.

### Phase 7: Deep links and re-engagement

Implemented in synthetic code/CI: tenant-owned link hosts, public association-file generation, closed deep-link destinations, Android App Links, iOS Universal Links, Android deferred delivery through Install Referrer, Unity callbacks, engagement-scope attribution, and separated daily metrics.

- Direct deep linking is deterministic on both supported mobile platforms.
- Deferred deep linking is deterministic on Android only; iOS deferred deep linking is not offered.
- Device-reported opens are forgeable evidence and do not become redirector-observed clicks.
- Real-domain verification, store delivery, devices, propagation, reinstall behavior, Unity export, and four-week observation remain operator gates.

## Evidence gates

A phase completes through measurable evidence, not code completion alone.

- Raw counts and aggregates can be recalculated under identical conditions
- Every exclusion has a reason code
- A fixed policy version reproduces a historical decision
- Duplicate, conflict, delay, deletion, import, aggregate, and platform fixtures pass automatically
- Runtime fixture reproduction, operator-run validation, device validation, platform approval, and production validation remain distinct states
- All planned synthetic code phases are implemented; M2-M5 operator evidence remains open and must not be inferred from CI
- Platform approval, device validation, and campaign validation remain labeled unverified until actually completed

## Rough estimate

- M1a and M1b: approximately 8-12 weeks with two contributors, subject to implementation evidence
- M2: approximately 6-10 weeks, excluding platform and device-validation elapsed time
- M3: approximately 3-4 weeks
- M4a and M4b: approximately 8-12 weeks, excluding Apple validation elapsed time
- Production readiness and a shadow pilot require additional elapsed time and operational ownership

AI can accelerate implementation, fixtures, documentation, adapters, and discrepancy analysis. It cannot shorten platform approval, device-signal delivery, real-campaign observation, consent behavior, restore testing, or the owner's continuation decision.
