# Project Status

Status date: 2026-08-31.

`v0.2.0` is the current published source and SDK release. Its annotated tag,
[GitHub Release](https://github.com/yubisuke/openmasu/releases/tag/v0.2.0),
and every required full platform gate identify green commit `68b8c48`. This
document describes the later current `main` source tree; tagged release notes
and evidence manifests remain authoritative only for the exact source revision
they name.

## Release snapshot

| Source line | Contract patch ledger | Reviewed inventory | Release meaning |
| --- | --- | --- | --- |
| `v0.2.0-rc.3` tag | through v0.4.9 | 56 fixtures / 728 golden artifacts | Previously published prerelease and frozen historical evidence |
| `v0.2.0-rc.4` tag | through v0.4.10 | 57 fixtures / 741 golden artifacts | Latest published prerelease and frozen exact-commit evidence |
| `v0.2.0` tag | through v0.4.10 | 57 fixtures / 741 golden artifacts | Published non-prerelease at green commit `68b8c48`; frozen exact-commit evidence |

The Contract wire and package identity remains `0.4.0`; v0.4.10 is the latest
additive patch ledger entry. The SDK version configured on `main` is `0.2.0`.
The rc.4 tag, GitHub prerelease, and exact-commit platform evidence remain
frozen at `2a2f6b5`; the stable v0.2.0 record is independently frozen at
`68b8c48`. A version string alone never proves publication or exact-commit
validation.

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
| Server-to-server events | Implemented for selected first-party backend events with app-scoped rotatable HMAC keys, durable inbox admission, contract rejection, replay controls, and deletion-race enforcement | Production TLS, secret custody, sustained load, backend integration, and operator acceptance |
| Operator event webhooks | Implemented as a default-off, app-scoped export of selected accepted events with exact-origin egress policy, destination-scoped references, exact-body HMAC, durable retry, and deletion-race enforcement | Production receiver, DNS/TLS, capacity, alerting, secret custody, downstream retention/deletion, and operator acceptance |
| Operator bulk event exports | Implemented as a default-off, app-scoped deterministic gzip NDJSON export to allowlisted S3-compatible operator storage, with SigV4, conditional create, digest-verified replay, durable keyset cursors, and destination-scoped deletion rows | Live Amazon S3/Cloudflare R2 account, IAM policy, DNS/TLS, lifecycle/replication, throughput, cost, alerting, downstream deletion, and operator acceptance |
| Attribution and difference audit | Implemented for supported deterministic and aggregate evidence families | Same-cohort comparison with an existing MMP under frozen definitions |
| Cohort metrics and exports | Implemented for versioned revenue, cost, FX, retention, ROAS, LTV, JSON, CSV, dashboard output, and app-scoped durable daily schedules with exact replay | Real currency/time-zone coverage, source-dashboard reconciliation, schedule/alert operation, and operator acceptance |
| Android, iOS, and Unity SDKs | Implemented with JVM, emulator, Swift, simulator, reproducible packaging, standalone UPM dependency resolution, and a synthetic Unity 6 Android export/APK gate | Physical devices, Unity 2022.3, iOS Unity export, store delivery, and live provider signals |
| Dashboard and management API | Implemented with server-rendered HTML, RBAC, sessions, RLS, and shared report encoders | Production TLS, browser/operator acceptance, and deployment-specific identity integration |
| Fraud and integrity evidence | Implemented with deterministic public rules, bundle provenance, aggregates, and synthetic provider normalization | Live integrity projects, threshold calibration, false-positive measurement, and device-farm coverage |
| Deep links and re-engagement | Implemented for direct Android/iOS and deferred Android flows plus separate aggregate AdAttributionKit re-engagement postbacks | Real domains, association propagation, devices, stores, Apple delivery, and long-running observation |
| Verified commerce lifecycle | Implemented with authenticated synthetic Google and Apple lifecycle/read-back paths plus per-row claims and privacy-fenced completion | Live credentials, quotas, delivery, key rotation, unmatched App Store installation linkage, entitlement, tax, payout, and provider-side duplicate behavior |
| Operations and release | Implemented for bootstrap, migration, scheduler state, metrics, DB-first durable privacy purge and restore reapplication, SBOMs, and release packaging | Production hosting, alerts, real backup recovery, incident response, and measured capacity |

## Product direction

OpenMasu continues as an auditable Shadow MMP and first-party measurement
toolkit. Its purpose is to explain evidence and measurement differences while
running beside an existing provider. Replacing an existing MMP is not a project
goal and must not be inferred from feature coverage.

Compatibility results apply only to the supplied artifact and mapping. They do
not score a provider, certify its product, or recommend migration.

## Current engineering focus

The published v0.2.0 release consolidates the release-coherence work completed
after rc.4. Provider-neutral backend event submission, outbound operator event
webhooks, deterministic operator-owned bulk event exports, durable scheduled
metrics, and the queue/privacy hardening below are implemented with synthetic
evidence. Live provider and object-storage use remain operator gates. Current
work remains integration hardening rather than another broad provider claim:

Source-level synthetic tests now show that the worker admits independent tenant
cycles through a bounded FIFO coordinator while preserving the existing serial
job order inside each tenant in one worker process. The default is four
concurrent tenants, with a
documented rollback setting of one and a bounded shutdown drain. Multiple
worker replicas do not provide tenant-wide ordering. SDK and MAX inboxes use
bounded FIFO slices. Google conversion delivery and server-side AdServices
lookup now claim one durable row immediately before provider I/O and fence
completion by claim token. AdServices also rechecks source availability under
the tenant privacy barrier before persisting its protected response. Platform
integrity verification now applies the same local ownership and privacy
boundary to its own queue, including protected result purge during deletion
and backup restore reapplication. Google Play product verification now claims
one due row, bounds provider waits, rejects stale completion, and prevents a
deletion-raced result or settled purchase from becoming available again.
Commerce read-back now applies the same local ownership boundary to Google
lifecycle/refund and Apple history work, including transactional refund or
cursor completion. Lease expiry can still repeat a provider operation, and
distributed provider quotas remain separate operational work.

1. preserve the rc.4 notes, SDK identities, SBOMs, bundle paths, tag, and
   evidence manifest as one immutable historical release record while keeping
   v0.2.0 bound to its own source, SBOM, bundle, tag, and evidence;
2. preserve the server-event, operator-webhook, and bulk-export key, replay,
   egress, privacy, and durable-queue invariants while auditing other
   high-impact compatibility gaps;
3. preserve bounded tenant concurrency and the Google conversion, AdServices,
   integrity, Google Play, and commerce read-back claim-fencing slices while
   continuing provider-quota hardening;
4. preserve durable scheduled-metric checkpoints and exact replay, the
   tenant-scoped SDK admission/projection privacy barrier, and deletion-state
   rechecks while hardening the remaining provider-completion deletion races;
5. ensure every durable runtime queue can independently make its tenant
   discoverable to the worker before a tenant RLS context exists;
6. preserve the current synthetic/operator evidence distinction.

Private real-data, real-device, and live-provider work is optional operator work
and is not required to continue repository-only hardening.
