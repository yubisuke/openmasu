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

## Current integration work

| Workstream | Deliverable | Required evidence |
| --- | --- | --- |
| Worker database safety | Complete: separate scheduler/job pools and short transaction phases | Scheduler and MAX inbox integration tests at a one-connection pool limit |
| SDK queue parity | Complete: one duplicate/conflict policy across Android and iOS | Shared semantic vectors plus each platform's native gate |
| Apple current-spec compatibility | Complete: accept and separately report aggregate AdAttributionKit re-engagement while preserving install and device-level boundaries | Signed synthetic receiver test, reviewed fixture parity, SQL/reference parity, and macOS SDK gate |
| Newcomer documentation | Complete: one current documentation map and safe synthetic first run | Link check, documentation drift check, threat-model coverage, full validation |
| Release alignment | Complete for v0.2.0-rc.4 at green commit `2a2f6b5` | Release-version check, reproducible bundle verification, tagged evidence manifest, and exact-commit platform CI |
| CI efficiency | Complete: cancel superseded PR runs and gate expensive steps by changed scope | Classifier unit matrix plus GitHub pull-request proof with every required context present |
| Authenticated backend events | Complete: selected first-party server events use dedicated rotatable keys and the ordinary durable evaluator path | Signing and authority unit tests plus PostgreSQL key-lifecycle, replay, rejection, idempotency, projection, and deletion tests |
| Operator event webhooks | Complete: selected accepted events use immutable app destinations, destination-scoped references, an encrypted durable outbox, and exact-body signing | Destination/DNS unit tests plus PostgreSQL lifecycle, retry, identifier-exclusion, disablement, and deletion-ordering tests |
| Operator bulk event exports | Complete: the webhook event object is reused in deterministic gzip NDJSON objects delivered to immutable S3-compatible app destinations through encrypted durable batches and keyset checkpoints | Official SigV4 vectors plus PostgreSQL registration, retry-byte identity, checkpoint, privacy-deletion, disablement, grant, metrics, and credential-exclusion tests |
| Scheduled metric execution | Complete: app-scoped immutable definitions advance daily UTC cohort or calendar dates through the durable worker | API validation, non-overlap enforcement, PostgreSQL checkpoint recovery, exact artifact replay, report/dashboard visibility, role grants, and scheduler health tests |
| Runtime tenant discovery | Complete: integrity verification and commerce provider read-back queues independently expose their tenant to the worker | FORCE-RLS owner-policy coverage plus isolated queue-only tenant discovery and drain-to-terminal integration tests |
| Worker tenant fairness | Synthetic source-level complete: independent tenants use a bounded FIFO coordinator while each tenant retains its existing privacy-to-fraud job sequence within one worker process | Deterministic blocked-tenant progress, concurrency cap, deduplication, bounded shutdown, atomic environment reconciliation, failure isolation, and concurrent scheduler-lease evidence; full process SIGTERM and multi-replica tenant-wide ordering remain operational boundaries |
| Worker inbox slicing | Complete for SDK and MAX durable inboxes with configurable FIFO row limits per tenant cycle | Three-row synthetic integration evidence proves a limit of two drains as 2 then 1; a slow individual row and sustained backlog remain operational boundaries |
| Google conversion delivery fencing | Complete for the Google Data Manager delivery queue with per-row database-clock claims and token-fenced completion | Two concurrent synthetic processors prove one active provider call, expired-claim recovery, stale-completion rejection, stable transaction-ID reuse, and no stale result append; provider-side exactly-once behavior remains an operator boundary |

## Change acceptance

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
