# Ledger, Import, and Metric Design

Status: implemented and synthetically verified.

This design describes the storage and calculation foundation shared by all
OpenMasu inputs. The active contract is v0.4; historical contract tags remain
available for compatibility research.

## Goals

- preserve received evidence and its provenance;
- normalize multiple input families into one closed contract;
- prevent partial writes and duplicate logical events;
- reproduce attribution, cost, revenue, and metrics under fixed definitions;
- expose neutral difference reasons rather than provider scores;
- keep protected bytes and deployment secrets outside public artifacts.

## Storage model

PostgreSQL uses separate schemas:

- `control` for tenants, apps, keys, imports, rules, schedules, and audit;
- `ledger` for append-only received and derived artifacts;
- normalized fact tables for bounded reporting projections;
- `ephemeral` for replay, inbox, session, quarantine, and other expiring state;
- `testing` for synthetic parity evidence.

Canonical JSON artifacts are the durable source of meaning. Normalized columns
support constraints and queries but do not replace the artifact. Tenant row-
level security is forced, and separate application, reader, seed, and migration
roles receive minimum grants.

## Import boundary

Raw events, manual/bounded provider cost, and aggregate advertising revenue use
explicit mapping or adapter boundaries. A compatibility run is no-write and
reports only aggregate status and field coverage. It never prints source values,
identifiers, paths, or digests.

After normalization, the worker validates the event payload with the compiled
Contract v0.4 schema. Invalid input produces a non-identifying rejection.
Accepted logical records write raw record, delivery, logical event, and fact
projection atomically. The logical idempotency key is tenant, app, producer,
and event ID; event IDs are unique across event names within that producer.

## Protected payloads

Protected source bytes are encrypted through the payload-store port. Database
artifacts carry opaque references and provenance digests, not plaintext. Valid
deletion or retention policy can purge or crypto-erase the protected bytes while
preserving a non-identifying tombstone.

## Metrics and reconciliation

Metric definitions declare selector, value source, window, grouping, currency,
scale, and version. SQL follows the evaluator's per-event conversion and
half-even rounding rules. A run binds its input snapshot, watermark, metric
definition, policy versions, rule bundle, aggregation time zone, and
supersession link. Internal ledger sequence is not part of the public digest.

The difference audit reads stored reconciliation artifacts. It does not
recompute a provider result while rendering. Matching keys, candidates,
exclusions, windows, joins, and freshness remain explicit, and reason codes are
neutral classifications.

## Evidence gates

- contract TypeScript/Python/RFC 8785 parity;
- PostgreSQL fixture and JCS byte parity;
- SQL/evaluator metric parity and rounding mutation tests;
- redaction and supersession recalculation;
- no-write import compatibility tests;
- transaction, idempotency, rejection, RLS, and grant-matrix integration tests;
- synthetic import and metric performance floors.

## Residual boundary

Synthetic evidence does not prove real export compatibility, provider account
permissions, data completeness, metric equivalence, production scheduling,
operational capacity, or live backup recovery.
