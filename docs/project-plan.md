# Open MMP Project Plan

## Product hypothesis

Open MMP does not begin by copying every feature of an established MMP. It begins by solving two problems: measurements that cannot be explained and economics that cannot be tied to visible processing and storage costs.

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

Fraud decisions retain evidence references, reason codes, rule-bundle versions and digests, evaluation time, action, and supersession history. A later delayed-transparency policy for retired rules may be considered, but it is not part of v0.2.

## Execution phases

`docs/roadmap.md` is the canonical execution order and contains the project-plan crosswalk. This document is a phase summary and must be updated with that crosswalk when the roadmap changes.

### Phase 0.2: Contract v0.2

Contract v0.2 is complete and its local validation gate passes. It includes the in-place consistency migration plus imported provider-reported attribution, automatic neutral reconciliation, typed reporting dimensions, cost and cohort metrics, Apple aggregate envelopes, a minimal verified Meta envelope, and the closed processing-purpose catalog. It remains contract evidence, not production-runtime readiness.

### Phase 1a: Shadow ledger and import foundation

M1a is implemented and locally validated with synthetic evidence. The public repository does not contain or claim real provider/account validation.

- PostgreSQL received-evidence ledger, normalized logical records, corrections, and redactions
- Docker Compose with portable Node.js API and worker services
- Three runtime import paths: public Shadow Import Profile, media cost, and advertising revenue
- Authenticated tenant scope, idempotency, payload and batch limits, baseline rate limiting, envelope encryption, audit logs, tests, and SBOMs
- Runtime reproduction of reviewed synthetic contract fixtures
- Private vulnerability reporting, TLS 1.2-or-later transport evidence, ledger-isolation tests, and deletion recalculation tests

### Phase 1b: Cohort metrics and difference audit

Phase 1b is implemented for the v0.2.1 contract and locally validated with synthetic PostgreSQL data. Snapshot supersession, SQL/evaluator parity, redaction recalculation, undefined ROAS, JSON/CSV export, persisted difference evidence, a third oracle, and a 10-million-row arithmetic floor have executable evidence. Exact 4-vCPU/8-GB capacity validation and two contract vocabulary/grouping follow-ups remain outside the completed runtime change.

- Recalculable D0, ROAS, retention, and cohort-LTV engine
- Versioned cost, revenue, FX, grouping, and watermark handling
- Difference-audit API for candidates, exclusions, windows, joins, freshness, and neutral reasons
- Operator-facing validation checklist; its real-data results stay outside the public repository

### Phase 1.5: Continuation decision gate

There is no code deliverable. The owner uses the M1a/M1b evidence, operator-run validation, operating cost, and unresolved platform limits to choose one path: continue as an audit layer, proceed toward a first-party measurement layer, or stop further expansion.

### Phase 2: Android, Unity, and redirector

- Unity C# SDK and Android Kotlin bridge
- Google Play Install Referrer and versioned deterministic attribution
- Portable Node.js redirector, with an optional Cloudflare Workers adapter only for that redirector
- Meta Install Referrer decryption after primary-source field verification
- Persistent queue, retry, idempotency, identifier reset, and sample application

### Phase 3: Metrics dashboard

- App registration, measurement-link creation, and authenticated reporting
- ROAS, retention, cohort, and attribution views
- Raw, report, and dashboard consistency under identical definitions

### Phase 4a: iOS first-party measurement

- Swift SDK and Unity iOS bridge
- First-party events, advertising revenue, persistent delivery, and consent controls
- Apple AdServices evidence and required privacy disclosures

### Phase 4b: Apple aggregate attribution

- SKAdNetwork and AdAttributionKit developer postback-copy receipt
- Verification, replay rejection, versioned conversion-value policy, and aggregate reporting
- No mixing of aggregate iOS reports with deterministic installation-level attribution

### Phase 5: Production and limited adapter boundary

- Tenant isolation, RBAC, rate limits, observability, load tests, backup and restore, and deletion exercises
- Play Integrity, App Attest, rule-bundle versioning, and production security evidence
- Signed, least-privilege adapters limited to first-party links, Meta, and Apple Ads
- Other media-network adapters remain outside the roadmap unless a later owner decision and current primary-source evidence explicitly add them

## Evidence gates

A phase completes through measurable evidence, not code completion alone.

- Raw counts and aggregates can be recalculated under identical conditions
- Every exclusion has a reason code
- A fixed policy version reproduces a historical decision
- Duplicate, conflict, delay, deletion, import, aggregate, and platform fixtures pass automatically
- Runtime fixture reproduction, operator-run validation, device validation, platform approval, and production validation remain distinct states
- Platform approval, device validation, and campaign validation remain labeled unverified until actually completed

## Rough estimate

- M1a and M1b: approximately 8-12 weeks with two contributors, subject to implementation evidence
- M2: approximately 6-10 weeks, excluding platform and device-validation elapsed time
- M3: approximately 3-4 weeks
- M4a and M4b: approximately 8-12 weeks, excluding Apple validation elapsed time
- Production readiness and a shadow pilot require additional elapsed time and operational ownership

AI can accelerate implementation, fixtures, documentation, adapters, and discrepancy analysis. It cannot shorten platform approval, device-signal delivery, real-campaign observation, consent behavior, restore testing, or the owner's continuation decision.
