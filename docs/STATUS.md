# Project Status

Status date: 2026-08-26.

The latest tagged source and SDK release candidate is `v0.2.0-rc.2`.
The development branch contains additional reviewed work after that tag. This
document describes current source; the release notes describe the exact tagged
candidate.

## How to read status

- **Implemented**: the code and public interfaces exist.
- **Synthetically verified**: checked-in synthetic inputs pass the named local
  or CI gate.
- **Operator verification open**: a private deployment, device, domain,
  provider account, or store environment is still required.
- **Out of scope**: the project deliberately does not provide the capability.

A synthetic pass proves contract and code behavior only. It does not prove live
provider connectivity, real-device or campaign delivery, platform approval,
production capacity, operator acceptance, or metric equivalence with another
MMP.

## Current capability status

| Capability | Repository state | Open operational evidence |
| --- | --- | --- |
| Contract and deterministic evaluator | Implemented and synthetically verified across 28 schemas, 8 registries, 56 fixtures, and 728 goldens | Real input representativeness and external implementation adoption |
| Shadow ledger and imports | Implemented for raw events, manual/bounded provider cost, and advertising or verified-commerce revenue | Authorized real export compatibility, account permissions, completeness, latency, and reconciliation |
| Attribution and difference audit | Implemented for supported deterministic and aggregate evidence families | Same-cohort comparison with an existing MMP under frozen definitions |
| Cohort metrics and exports | Implemented for versioned revenue, cost, FX, retention, ROAS, LTV, JSON, CSV, and dashboard output | Real currency/time-zone coverage, source-dashboard reconciliation, and operator acceptance |
| Android, iOS, and Unity SDKs | Implemented with JVM, emulator, Swift, simulator, packaging, and bridge gates | Physical devices, Unity exports, store delivery, and live provider signals |
| Dashboard and management API | Implemented with server-rendered HTML, RBAC, sessions, RLS, and shared report encoders | Production TLS, browser/operator acceptance, and deployment-specific identity integration |
| Fraud and integrity evidence | Implemented with deterministic public rules, bundle provenance, aggregates, and synthetic provider normalization | Live integrity projects, threshold calibration, false-positive measurement, and device-farm coverage |
| Deep links and re-engagement | Implemented for direct Android/iOS and deferred Android flows | Real domains, association propagation, devices, stores, and long-running observation |
| Verified commerce lifecycle | Implemented with authenticated synthetic Google and Apple lifecycle/read-back paths | Live credentials, quotas, delivery, key rotation, complete recovery, entitlement, tax, and payout |
| Operations and release | Implemented for bootstrap, migration, scheduler state, metrics, backup/restore logic, SBOMs, and release packaging | Production hosting, alerts, real backup recovery, incident response, and measured capacity |

## Product direction

OpenMasu continues as an auditable Shadow MMP and first-party measurement
toolkit. Its purpose is to explain evidence and measurement differences while
running beside an existing provider. Replacing an existing MMP is not a project
goal and must not be inferred from feature coverage.

Compatibility results apply only to the supplied artifact and mapping. They do
not score a provider, certify its product, or recommend migration.

## Current engineering focus

The next development cycle is integration and release coherence rather than
feature expansion:

1. validate worker database-pool budgets under longer synthetic concurrency and
   failure campaigns;
2. keep Android and iOS queue conflict behavior semantically identical;
3. provide one canonical synthetic onboarding path and safe operator guidance;
4. keep tagged release state distinct from post-tag development state;
5. reduce redundant CI execution without weakening platform-specific gates.

Private real-data, real-device, and live-provider work is optional operator work
and is not required to continue repository-only hardening.
