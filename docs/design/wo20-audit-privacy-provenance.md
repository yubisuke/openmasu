# WO-20 audit, privacy, and provenance decisions

Status: Decided for implementation under Issue #5 (2026-08-25)

This note records the contract-impact decision for each WO-20 workstream before
any schema, registry, or reviewed golden artifact is changed.

## D-1 — Subject access and portability

Subject access is an authenticated runtime and storage feature. It uses the
existing installation-scoped authentication boundary and a new additive,
append-only internal DSAR request record. The portable response is assembled
only from normalized, purpose-limited ledger facts. It never exposes encrypted
payload references, raw request bodies, provider credentials, or another
tenant's or application's data.

Contract impact: none. The public event and artifact schemas do not change.
Aggregate operator reports remain analytics exports and are not DSAR responses.

## D-2 — Non-fraud rule-bundle provenance

The existing required rule-bundle identity triple is retained. Placeholder
hashes used by reference attribution, metric, and Apple postback artifacts are
replaced by SHA-256 digests of RFC 8785-canonicalized, checked-in default bundle
definitions. Runtime evaluation prefers a valid current registered revision and
rejects identity or digest mismatches. Historical persisted rows are never
rewritten.

Contract impact: non-breaking behavioral correction. No schema shape, enum, or
required field changes. Reviewed golden artifacts whose only semantic change is
the replacement of a documented placeholder hash may change; every such file
must be classified and recorded before acceptance.

## D-3 — Forgeable deep-link-open evidence

A `deep_link_open` remains a device-reported engagement claim. Successful
ingestion records an idempotent, tenant/app/record-scoped audit fact describing
the claim and whether a server-observed redirect click was available. This
evidence can be used by later fraud review, but it does not reject ingestion,
authenticate the device, or alter installation attribution.

Contract impact: none. The new evidence is an additive internal ledger table;
public event and fraud-decision schemas and registries remain unchanged.

