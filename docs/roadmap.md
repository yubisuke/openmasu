# Roadmap

This is the canonical milestone sequence. `docs/project-plan.md` is a phase summary; update both documents and this crosswalk in one change when ordering or exit gates change.

| Canonical roadmap milestone | Project-plan phase | Scope relationship |
| --- | --- | --- |
| M0 Contract | Phase 0 | Contract, registries, fixtures, and evaluator |
| M1 Shadow ledger | Phase 1 | Received-evidence ledger and shadow reconciliation |
| M2 Android and Unity SDK | Phase 2 | Native deterministic vertical slice |
| M3 Minimal dashboard | Phase 3 | Reporting surface over the same definitions |
| M4 iOS privacy-preserving measurement | Phase 4 | Separate aggregate privacy-preserving series |
| M5 Production and fraud boundary | Phase 5 | Trust boundary, approved media adapters, and production pilot |

## Milestone 0: Event & Metric Contract v0.1

### M0.1 Contract hardening

M0.1 is complete and the full local contract validation suite passes. It hardens paid reinstall/redownload attribution, globally unique `record_id` rejection, tenant/app-scoped references, deterministic `click_id` ambiguity handling, explicit installation anchors, and the initial public [threat model](threat-model.md). The contract remains a reference implementation; M1 Shadow Ledger is next, not a runtime release.

- Versioned event envelope and raw-record contract
- Attribution result, reason codes, and state transitions
- Retraction, redaction, and privacy-request contracts
- D0 24-hour, UTC calendar-day, and JST calendar-day definitions
- Synthetic duplicate, conflict, late, missing, and aggregate fixtures
- Public fraud-evidence schema and private live-policy boundary
- Pure reference evaluator
- Apache-2.0 licensing is complete; name/trademark clearance remains a release prerequisite owned by the project maintainer before the first public release
- A public `SECURITY.md` and a maintainer-approved private reporting path are required before M1 accepts runtime code

Evidence gate: An independently authored evaluator, or a separately implemented evaluator in another language with separate review, can reproduce the expected canonical outputs from the same fixtures and policy versions.

## Milestone 1: Shadow ledger

- PostgreSQL append-only received-evidence layer
- Lawful correction and redaction records
- Existing MMP and media-output import through the public Shadow Import Profile and synthetic fixtures; provider mappings and certification remain deployment-private
- Normalization and deterministic recalculation
- Difference-audit API for candidates, exclusions, windows, joins, and freshness
- Docker Compose and automated tests
- Private vulnerability reporting, ledger isolation tests, deletion recalculation tests, and an SBOM for each runtime artifact

Evidence gate: The same inputs and policy versions reproduce the same aggregate and the same difference reasons.

## Milestone 2: Android and Unity SDK

- Unity C# SDK and Android Kotlin bridge
- Google Play Install Referrer client
- Offline queue, retry, and batch delivery
- SDK disablement and identifier reset
- Sample application
- MAX ad-revenue callback
- Device and Play internal-testing validation procedure
- Complete Android SDK field inventory, Google Play Data safety mapping, consent-queue tests, and backup/restore exclusion for `installation_id`

Evidence gate: A Google Play first launch retrieves the click evidence and produces one non-conflicting install record.

## Milestone 3: Minimal dashboard

- App registration
- Measurement-link creation
- Daily clicks and installs
- Organic, non-organic, and unattributed breakdown
- CSV export
- Attribution method, policy version, and data-freshness display

Evidence gate: Raw records, reporting API, and dashboard match under identical filters and definitions.

## Milestone 4: iOS privacy-preserving measurement

- AdAttributionKit and SKAdNetwork postback receipt
- Signature and transaction-ID verification
- Conversion-tag and value policy
- Aggregate reporting
- UI that does not mix aggregate iOS reports with deterministic Android attribution
- Apple Privacy Manifest and App Privacy Details mapping

Evidence gate: Apple test procedures produce verified, replay-resistant postbacks and aggregate results.

## Milestone 5: Production and fraud boundary

- Tenant isolation and RBAC
- Rate limiting
- Backup and restore
- Deletion-request end-to-end flow
- OpenTelemetry and load tests
- SDK distribution and compatibility policy
- Play Integrity and App Attest integration
- Rule-bundle versions, digests, and supersession history
- Signed, least-privilege media adapters with fixture certification
- Google Ads provider and Apple postback prerequisites revalidated from primary sources immediately before work; the adapter owner records the result before implementation
- Final threat-model review, production SBOM, and tenant-isolation, replay, deletion, and backup/restore evidence

Evidence gate: A production pilot completes backup restoration, deletion, replay, failure, and shadow-reconciliation exercises with documented evidence.

## Immediate next step

Begin M1 Shadow Ledger planning and implementation. The M0.1 validation evidence is recorded; M1 remains separate from runtime-release and production evidence. This step requires no external service or GitHub access.
