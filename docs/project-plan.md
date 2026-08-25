# Open MMP Project Plan

## Product hypothesis

Open MMP does not begin by copying every feature of an established MMP. It begins by solving two problems: measurements that cannot be explained and economics that cannot be tied to visible processing and storage costs.

The product therefore starts as a Shadow MMP alongside an existing provider.

- Store first-party events independently
- Normalize existing MMP and media outputs into a common contract
- Recalculate attribution and revenue under explicit definitions
- Explain neutral measurement differences through candidates, exclusion reasons, windows, joins, and freshness; these categories do not score provider quality
- Move a measurement path to primary status only after a real shadow pilot validates it

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
- Real user and campaign evidence

Fraud decisions retain evidence references, reason codes, rule-bundle versions and digests, evaluation time, action, and supersession history. A later delayed-transparency policy for retired rules may be considered, but it is not part of v0.1.

## Execution phases

`docs/roadmap.md` is the canonical execution order and contains the project-plan crosswalk. This document is a phase summary and must be updated with that crosswalk when the roadmap changes.

### Phase 0: Contract

M0.1 hardening is complete and its local validation gate passes. The phase now has explicit paid reinstall/redownload semantics, global record-ID collision rejection, tenant/app-scoped defensive references, deterministic click ambiguity handling, unambiguous installation anchors, and an initial public [threat model](threat-model.md). M1 Shadow Ledger is next; this is not production-runtime readiness.

Produce `Open MMP Event & Metric Contract v0.1`:

- Raw-record envelope
- Click, install, and session core events
- Schema-only revenue, purchase, consent, privacy, and fraud extensions
- Orthogonal lifecycle and quality states
- Attribution result and reason registry
- Shadow difference-reason registry and external-row matching-key types
- Explicit D0 24-hour, UTC-calendar, and JST-calendar definitions
- Synthetic fixtures and a pure reference evaluator

### Phase 1: Shadow ledger

- PostgreSQL received-evidence ledger
- Normalized logical records
- Import API and CSV import
- Public shadow-import profile and synthetic fixtures; provider mappings and certification remain deployment-private
- Recalculable metric engine
- Difference-audit API

The first goal is to explain differences between existing MMP raw output and first-party evidence.

### Phase 2: Android and Unity vertical slice

- Unity C# SDK
- Android Kotlin bridge
- Google Play Install Referrer
- Deep links (not in the M2 exit gate; deferred)
- MAX ad-revenue callback
- Persistent queue, retry, and idempotency
- Versioned last-click attribution

### Phase 3: Minimal dashboard

- App registration, measurement-link creation, and daily reporting
- Raw/report/dashboard consistency under identical definitions

### Phase 4: iOS privacy-preserving measurement

- AdAttributionKit and SKAdNetwork postback receipt and aggregate reporting
- No mixing of aggregate iOS reports with deterministic installation-level attribution

### Phase 5: Production, trust, fraud, and media adapters

- Replay evidence using nonce, time, and event IDs
- Play Integrity integration
- Click and install time consistency
- Append-only evidence and supersedable decisions
- Signed, least-privilege media adapters
- Adapter certification against public fixtures

Add media adapters only with primary-source, current approval evidence. The initially proposed order is:

1. First-party ads and referral URLs
2. AppLovin MAX ad revenue
3. Google Ads third-party provider flow
4. Apple Ads
5. AdAttributionKit
6. Networks requiring additional approval or contracts

Each adapter declares `official | approval_pending | experimental | unsupported`.

- Three-to-five-month real-campaign shadow comparison
- Missing, duplicate, delayed, and reinstall measurement
- Consent withdrawal and deletion end-to-end tests
- Backup and restore
- Failure exercises and audit review
- Decision on which paths, if any, can become primary

## Evidence gates

A phase completes through measurable evidence, not code completion alone.

- Raw counts and aggregates can be recalculated under identical conditions
- Every exclusion has a reason code
- A fixed policy version reproduces a historical decision
- Duplicate, conflict, delay, deletion, and aggregate fixtures pass automatically
- Platform approval, device validation, and campaign validation remain labeled unverified until actually completed

## Rough estimate

- Contract and working prototype: 2–4 weeks
- Production pilot: approximately 3–5 months with two backend/Unity contributors and part-time security support
- Media approvals and campaign observation: additional elapsed time

AI can accelerate implementation, fixtures, documentation, adapters, and discrepancy analysis. It cannot shorten platform approval, device-signal delivery, real-campaign observation, consent behavior, or restore testing.
