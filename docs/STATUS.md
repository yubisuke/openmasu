# Project Status

Status date: 2026-08-30.

The latest tagged source and SDK release candidate is `v0.2.0-rc.3`.
This document describes the current `main` source tree, which contains reviewed
work added after that tag. Tagged release notes and evidence manifests remain
authoritative for the exact candidate they name.

## Release snapshot

| Source line | Contract patch ledger | Reviewed inventory | Release meaning |
| --- | --- | --- | --- |
| `v0.2.0-rc.3` tag | through v0.4.9 | 56 fixtures / 728 golden artifacts | Latest published prerelease and its frozen evidence |
| Current `main` | through v0.4.10 | 57 fixtures / 741 golden artifacts | Reviewed but unreleased development source |

The Contract wire and package identity remains `0.4.0`; v0.4.10 is the latest
additive patch ledger entry. The SDK version configured on `main` still reads
`0.2.0-rc.3` for drift detection, but artifacts built from post-tag source are
not rc.3 release artifacts and must not be published under that identity.

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
| Contract and deterministic evaluator | Implemented and synthetically verified across 28 schemas, 8 registries, 57 fixtures, and 741 goldens | Real input representativeness and external implementation adoption |
| Shadow ledger and imports | Implemented for raw events, manual/bounded provider cost, and advertising or verified-commerce revenue | Authorized real export compatibility, account permissions, completeness, latency, and reconciliation |
| Attribution and difference audit | Implemented for supported deterministic and aggregate evidence families | Same-cohort comparison with an existing MMP under frozen definitions |
| Cohort metrics and exports | Implemented for versioned revenue, cost, FX, retention, ROAS, LTV, JSON, CSV, and dashboard output | Real currency/time-zone coverage, source-dashboard reconciliation, and operator acceptance |
| Android, iOS, and Unity SDKs | Implemented with JVM, emulator, Swift, simulator, packaging, and bridge gates | Physical devices, Unity exports, store delivery, and live provider signals |
| Dashboard and management API | Implemented with server-rendered HTML, RBAC, sessions, RLS, and shared report encoders | Production TLS, browser/operator acceptance, and deployment-specific identity integration |
| Fraud and integrity evidence | Implemented with deterministic public rules, bundle provenance, aggregates, and synthetic provider normalization | Live integrity projects, threshold calibration, false-positive measurement, and device-farm coverage |
| Deep links and re-engagement | Implemented for direct Android/iOS and deferred Android flows plus separate aggregate AdAttributionKit re-engagement postbacks | Real domains, association propagation, devices, stores, Apple delivery, and long-running observation |
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

The open repository milestone is release coherence rather than another broad
provider claim:

1. select and version the next candidate from reviewed `main`;
2. create a new evidence manifest and run every full platform gate at that
   exact candidate commit;
3. keep release notes, SDK identities, SBOMs, bundle paths, and documentation
   aligned with the tag;
4. continue bounded concurrency and shared queue-vector hardening when existing
   runtime or SDK surfaces change;
5. preserve the current synthetic/operator evidence distinction.

Private real-data, real-device, and live-provider work is optional operator work
and is not required to continue repository-only hardening.
