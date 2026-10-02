# Project Plan

## Objective

Develop OpenMasu as an auditable Shadow MMP and first-party measurement toolkit.
The project succeeds when a contributor can trace a reported value to received
evidence, reproduce it under fixed rules, and understand why it differs from
another measurement result.

Replacing an existing MMP is not the objective.

## Sources of truth

| Topic | Canonical source |
| --- | --- |
| Product boundary | [Product scope](product-scope.md) |
| Current evidence state | [Project status](STATUS.md) |
| Milestone order | [Roadmap](roadmap.md) |
| Contract behavior | [Contract specification](../spec/event-metric-contract-v0.4.md), schemas, and registries |
| Runtime design | [Architecture](architecture.md) and `docs/design/` |
| Security boundary | [Privacy and security](privacy-security.md) and [Threat model](threat-model.md) |
| Contributor workflow | [Development](development.md) |
| Private operational checks | [Validation checklists](validation/README.md) |

Historical issue drafts, reviews, and migration records explain how earlier
versions were reached. They do not override current sources of truth.

## Workstream order

1. **Correctness before breadth.** Fix deterministic, transactional, security,
   and cross-platform semantic defects before adding providers or event types.
2. **Integration before promotion.** Make the existing import-to-report path
   coherent and easy to reproduce before publishing another release candidate.
3. **Evidence before claims.** Add the narrowest gate that proves the intended
   behavior; keep unperformed operator evidence explicitly open.
4. **Release coherence before tagging.** Align version identities, release
   notes, SBOMs, SDK artifacts, documentation, and CI on the exact commit to be
   tagged.

## Implemented integration work

| Workstream | Deliverable | Required evidence |
| --- | --- | --- |
| Measurement visibility | Reader-only app health connects existing ingestion, rejection and metric metadata to operator next steps | Synthetic API/role isolation and read-only DB checks plus state/rendering unit tests; no live completeness claim |
| Saved ROAS explanation | Elapsed-window ad-revenue ROAS records its operands with the original run and exposes aggregate details | SQL parity, exact operands/rounding, duplicate delivery, selected cost history, missing/redacted evidence and reader scope; no historical reconstruction |
| Comparison semantics | New SQL runs save aggregate-only definition/FX context; the offline comparison distinguishes definition-backed meaning, declarations and unknowns | Original-run persistence/reader export, equivalent meaning across different IDs, gross/net/window/FX mismatches, legacy refusal and exact integer arithmetic; no provider authentication or completeness claim |
| Dashboard comparison download | A bounded all-page fixed selection can be saved through the existing session/reader role and shared converter | Screen/download/CLI-HTML flow, one-connection repeatable-read paging, concurrent new/superseding runs, receipt digests, bounds/cancellation/privacy refusal and auth/no-write checks; no upstream-completeness claim |
| Aggregate CSV comparison input | One explicit offline mapping reuses CSV and exact-money conversion; no raw-event ingestion | Synthetic CSV-to-snapshot-to-JSON/HTML, scales/large integers, missing/undefined/zero, duplicate/date/quote refusal, limits and redacted errors; no invented definition-backed meaning |
| Integrated first use | One purpose-based newcomer path connects existing demo/pilot, app/key setup, receipt states, readable metrics, original-run evidence and comparison | Two narrow offline connection tests prove fixture-derived equal/corrected-cost/incompatible-window/unknown reports, ordinary CLI replay and refusal to overwrite; existing runtime/role/pilot gates remain authoritative |
| Bounded cost refresh | One existing cost adapter runs default-off app schedules with fixed range/configuration and atomic cost/checkpoint publication | Synthetic adapter and PostgreSQL tests cover complete/empty/partial outcomes, concurrent/expired claims, stop, bounded retries/timeout, correction history, rollback and private reader columns |
| Selected cost correction | Explicit app/import/range/watermark requests use saved replay definitions and the existing SQL engine; immutable old/new runs have supersession and visible pending input state | Synthetic affected/unrelated cohorts, old/new ROAS/snapshots, duplicate/concurrent work, expired claims, transactional retry, reader scope and redaction/retention; incompatible conditions yield no ordinary delta |
| Worker database safety | Complete: separate scheduler/job pools and short transaction phases | Scheduler and MAX inbox integration tests at a one-connection pool limit |
| SDK queue parity | Complete: one duplicate/conflict policy across Android and iOS | Shared semantic vectors plus each platform's native gate |
| Apple current-spec compatibility | Complete: accept and separately report aggregate AdAttributionKit re-engagement while preserving install and device-level boundaries | Signed synthetic receiver test, reviewed fixture parity, SQL/reference parity, and macOS SDK gate |
| Newcomer documentation | Complete: one current documentation map and safe synthetic first run | Link check, documentation drift check, threat-model coverage, full validation |
| Release alignment | v0.2.0 published at green commit `68b8c48`; v0.2.0-rc.4 remains historical at `2a2f6b5` | Release-version check, reproducible bundle verification, tagged evidence manifest, and exact-commit platform CI |
| SDK distribution | Complete for published v0.3.0-rc.1 using one exact-commit CI bundle and eight downloadable Android/Unity/iOS assets | Existing bundle/consumer gates plus deterministic outer packaging, wrong-SHA refusal, checksums/SBOMs and verified exact-tag public re-download receipt |
| Safe upgrades | Stopped-writer supported-source path with archive checksum, frozen migration and exact target preflight | Existing backup gate extended with frozen v0.2.0 DDL/data, actual dump/restore, transactional failure/resume, preserved artifacts and privacy reapplication; no production downtime claim |
| Single-host deployment | One existing Compose stack, exact release, operator HTTPS proxy, private configuration and stable named volumes | Static preflight refusals and normal no-reseed restart in the existing isolated pilot; real domains/TLS, secret custody and host readiness remain operator gates |
| Storage visibility | Private privileged read-only observation distinguishes allocation, row estimates, payload metadata and unavailable results | Small protected write/purge and catalog-allocation/reader-refusal tests in existing suites; no new benchmark, retention default or automatic cleanup |
| HTTP usage contract | Limited machine-readable backend receipt and three report routes reference existing schema/enums, signing and paging rules | Two generated-description drift tests and one existing real-route client case cover pending, malformed input, authentication and cursor continuation; no new SDK/platform/UI |
| CI efficiency | Complete: cancel superseded PR runs and gate expensive steps by changed scope | Classifier unit matrix plus GitHub pull-request proof with every required context present |
| Authenticated backend events | Complete: selected first-party server events use dedicated rotatable keys and the ordinary durable evaluator path | Signing and authority unit tests plus PostgreSQL key-lifecycle, replay, rejection, idempotency, projection, and deletion tests |
| Operator event webhooks | Complete: selected accepted events use immutable app destinations, destination-scoped references, an encrypted durable outbox, and exact-body signing | Destination/DNS unit tests plus PostgreSQL lifecycle, retry, identifier-exclusion, disablement, and deletion-ordering tests |
| Operator bulk event exports | Complete: the webhook event object is reused in deterministic gzip NDJSON objects delivered to immutable S3-compatible app destinations through encrypted durable batches and keyset checkpoints | Official SigV4 vectors plus PostgreSQL registration, retry-byte identity, checkpoint, privacy-deletion, disablement, grant, metrics, and credential-exclusion tests |
| Scheduled metric execution | Complete: app-scoped immutable definitions advance daily UTC cohort or calendar dates through the durable worker | API validation, non-overlap enforcement, PostgreSQL checkpoint recovery, exact artifact replay, report/dashboard visibility, role grants, and scheduler health tests |
| Runtime tenant discovery | Complete: integrity verification and commerce provider read-back queues independently expose their tenant to the worker | FORCE-RLS owner-policy coverage plus isolated queue-only tenant discovery and drain-to-terminal integration tests |
| Worker tenant fairness | Synthetic source-level complete: independent tenants use a bounded FIFO coordinator while each tenant retains its existing privacy-to-fraud job sequence within one worker process | Deterministic blocked-tenant progress, concurrency cap, deduplication, bounded shutdown, atomic environment reconciliation, failure isolation, and concurrent scheduler-lease evidence; full process SIGTERM and multi-replica tenant-wide ordering remain operational boundaries |
| Worker inbox slicing | Complete for SDK and MAX durable inboxes with configurable FIFO row limits per tenant cycle | Three-row synthetic integration evidence proves a limit of two drains as 2 then 1; a slow individual row and sustained backlog remain operational boundaries |
| Google conversion delivery fencing, pacing, and health | Complete for the Google Data Manager delivery queue with per-row database-clock claims, token-fenced completion, one database-backed request slot per destination, and a bounded reader-safe API/dashboard view | Synthetic processors prove active-claim exclusion, expired-claim recovery, stale-completion rejection, stable transaction-ID reuse, distinct-row pacing, bounded `Retry-After` propagation, no false attempt append, complete state summaries, and secret-column exclusion; live quotas and provider-side exactly-once behavior remain operator boundaries |
| Operator delivery health | Complete for webhook and bulk-export current state through one bounded app-scoped API/dashboard surface with least-privilege reader columns | Unit and PostgreSQL integration tests prove complete state summaries, recent-row limits, tenant/app scoping, unchanged destination listings and metrics, and exclusion of credentials, payload/object references, source record IDs, paths, digests, and artifacts; live receiver/storage effects remain operator boundaries |
| Platform-integrity completion fencing | Complete for the Integrity verification queue with per-row database-clock claims, bounded provider waits, and privacy-fenced completion | Concurrent, lease-recovery, timeout, deletion-first, completion-first, and backup-reapply synthetic tests prove local ownership and protected-evidence cleanup; provider-side exactly-once behavior remains an operator boundary |
| Google Play verification completion fencing | Complete for the product, initial-subscription, and renewal verification queue with per-row database-clock claims, bounded provider reads, and privacy-fenced completion | Concurrent, lease-recovery, timeout, deletion-first, completion-first, and backup-reapply synthetic tests prove local ownership, derived-projection cleanup, and protected-evidence cleanup; provider-side exactly-once behavior remains an operator boundary |
| Commerce read-back completion fencing | Complete for Google Play lifecycle/refund and App Store history queues with per-row database-clock claims and privacy-fenced completion | Concurrent, expired-claim recovery, stale-cursor rejection, existing-binding cursor cleanup, and Google/Apple deletion-race tests prove local ownership and no derived-state resurrection; App Store binding creation and provider-side exactly-once behavior remain operator boundaries |

## Next product slices

The prior integration batch and SDK publication are complete. The
[roadmap](roadmap.md#next-product-sequence) and
[plan #172](https://github.com/yubisuke/openmasu/issues/172) select the following
work from source `1c7c223` on 2026-10-02, expanded after inspecting `ce7b056`
to connect the core measurement path before improving its screens. These
entries identify planned work except the source-implemented slices
marked below. The inventory above remains the completed component foundation,
not proof that every path is connected.

### Core integration and scoped follow-ups

The advertising-acquisition gap is reproduced by a native-shaped synthetic install whose
legacy campaign cohort is empty; explicit selected-acquisition definitions
connect it without changing historical definitions. Separate synthetic cases
reproduce parent/detail cost double counting, now refused by explicit safe-cost
definitions, and purchase/total-net acquisition, now connected by explicit
v0.4.13 commerce definitions and fixture 60.

| Priority / issue | Workstream | Narrow deliverable | Acceptance focus |
| --- | --- | --- | --- |
| Source implemented / [#182](https://github.com/yubisuke/openmasu/issues/182) | Acquisition projection | Explicit v0.4.11 definitions use selected first-party Install Referrer campaign/network; historical definitions retain recorded-dimension semantics | Native-shaped install through ingestion to campaign installs/ad-revenue ROAS; selected evidence only, fixed watermark, privacy and TS/Python/SQL parity |
| Source implemented / [#183](https://github.com/yubisuke/openmasu/issues/183) | Cost grain safety | Explicit v0.4.12 definitions detect overlapping campaign/ad-group/country cost scopes and refuse ambiguous denominators | Fixture 59 and importer/SQL tests cover overlap, disjoint siblings, dated as-of revisions, saved meaning and immutable old runs |
| Source implemented / [#191](https://github.com/yubisuke/openmasu/issues/191) | Commerce acquisition projection | Explicit v0.4.13 definitions reuse selected source and safe costs for purchase/refund/total-net | Fixture 60 and SQL parity fix advertising 20 plus purchase 10 minus refund 4 over cost 10 at total-net 26 and ROAS 2.6, with unchanged old runs and privacy boundaries |
| Source implemented / [#184](https://github.com/yubisuke/openmasu/issues/184) | Late-input correction | Explicit bounded receipt discovery or source IDs select advertising-revenue/purchase/refund impact through existing recalculation jobs | Late arrival to new immutable run, exact replay and deduplication, visible bounds/unsupported evidence and deletion fencing; no implicit all-history enqueue |
| Source implemented / [#185](https://github.com/yubisuke/openmasu/issues/185) | Campaign discovery | Opt-in bounded campaign target discovery for existing daily install-cohort schedules | New campaign appears without editing a list, frozen target-set replay, cost-only/unknown/empty/overflow handling, unchanged manual schedules |
| Follow-up / [#186](https://github.com/yubisuke/openmasu/issues/186) | App Store purchase binding | Authenticated installation-to-verified-transaction binding and existing purchase/refund projections | Synthetic signed/read-back path reaches cohort revenue; unbound stays unbound, duplicate and privacy safety, no live Store claim |
| Follow-up / [#187](https://github.com/yubisuke/openmasu/issues/187) | Detailed acquisition grain | Selected ad-group/creative dimensions and same-grain cost support | Additive fixture-backed parity, unknown dimensions, overlapping cost refusal and no estimated parent-cost allocation |
| Follow-up / [#188](https://github.com/yubisuke/openmasu/issues/188) | Re-engagement outcomes | Separate first-party engagement conversion and advertising revenue series | Explicit anchor/window/credit policy, duplicate protection, unchanged acquisition runs and separation from signed aggregate evidence; no initial re-engagement ROAS claim |

The five core slices have source implementation; #173 begins the workflow improvements below.
#184/#185 reuse #182/#183, with commerce cohorts connected by #191; #186 depends on #184, #187 on #182/#183, and #188 on
#182/#177. Keep the scoped follow-ups separate from the initial Android-first
campaign path. They do not add a new provider, identity graph or metric service.

### Existing workflow improvements

| Order / issue | Workstream | Narrow deliverable | Acceptance focus |
| --- | --- | --- | --- |
| 1 / [#173](https://github.com/yubisuke/openmasu/issues/173) | External comparison meaning | Explicit external declarations for one elapsed ad-revenue ROAS family; retain captured versus declared evidence | Matching declared/captured meaning with opt-in produces known exact deltas; unknown, window/FX/gross-net/rounding mismatches refuse; provenance and legacy behavior remain |
| 2 / [#174](https://github.com/yubisuke/openmasu/issues/174) | Comparison workflow | Bounded SSR input, condition review and result download using existing converters/comparator | CLI/Web result identity, receipt app scope, input limits, no partial file, no server-side file/history persistence, session and CSRF checks |
| 3 / [#175](https://github.com/yubisuke/openmasu/issues/175) | Attribution analysis | Reader-only fixed-watermark install counts by status/method/recorded reason | As-of decision selection, no duplicate subject counts, not-recorded distinct from organic, privacy and tenant scope, no raw IDs or mixed aggregate population |
| 4 / [#176](https://github.com/yubisuke/openmasu/issues/176) | Daily calculation controls | SSR list/register/disable for existing immutable metric schedules | Register to worker checkpoint to disable, existing validation/ownership rules, administer capability, no GET writes |
| 5 / [#177](https://github.com/yubisuke/openmasu/issues/177) | Cohort outcomes | One explicit custom-event key, distinct D7 cohort converters and conversion rate | Additive contract and derived fixtures, TS/Python/SQL parity, duplicate/window/watermark/privacy rules, key-bound saved meaning and schedule validation |
| 6 / [#178](https://github.com/yubisuke/openmasu/issues/178) | Commerce calculation evidence | Saved operands for existing D30 total-net ROAS in the same calculation transaction | Advertising plus purchases minus refunds, cost and exact rounding, old-run immutability, redacted/unavailable evidence, existing result parity |
| 7 / [#179](https://github.com/yubisuke/openmasu/issues/179) | Correction workflow | SSR request/status and links to original/replacement run details using existing bounded recalculation | Cost revision to completion, duplicate request identity, existing bounds/permissions, no second selector or all-history recomputation |
| 8 / [#180](https://github.com/yubisuke/openmasu/issues/180) | Cohort presentation | Saved retention matrix with dates as rows and definition-backed horizons as columns | Exact values and source links, compatible series only, missing/undefined/zero/maturity and page-boundary distinctions |

Within the original eight workflow slices, #173 must precede #174.
Their priority now follows the five core integration slices above; #179 and
#180 remain lower priority. Reuse current services and suites, and implement one
bounded user workflow per PR. A non-breaking contract addition must still
record fixture derivation, migration and evaluator parity. The plan does not
select another provider adapter, general BI/funnel builder, infrastructure
service, private pilot or release. Promotion remains a separate decision.

## Change acceptance

The readable-analysis integration gate adds exact metric units, server-rendered
filters and selection-preserving CSV links to existing reports. It does not add
a metric engine or grant access to private replay manifests. Window/maturity
remain unknown in the main table; saved ad-revenue ROAS details expose recorded
operands and window boundaries. See [Dashboard analysis](dashboard-analysis.md)
and [Metric explanations](metric-explanations.md).

Every change must identify:

- the product or operational outcome;
- files and public interfaces affected;
- synthetic tests that passed;
- golden fixtures changed, if any, with their derivation;
- checks that were not run;
- remaining real-provider, device, platform, or production boundaries.

Contract changes follow [Schema versioning](schema-versioning.md). Security,
privacy, release, or public API changes require proportionate broad validation.
Documentation-only work still runs the documentation consistency and full
contract gates because status and validation counts are mechanically linked.

## Public and private work

The repository may contain only synthetic data and public configuration
examples. Credentials, provider exports, campaign values, device identifiers,
fraud watchlists, private thresholds, and operational evidence stay outside the
repository.

Private operator validation is optional and separately authorized. Repository
development must remain useful without it.
