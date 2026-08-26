# Contract v0.2 Historical Migration

This document summarizes the migration from Contract v0.1 to the completed v0.2
line. It is historical guidance. The complete v0.2.1 contract is preserved at
the `contract-v0.2.1` tag; the active working contract is v0.4.

## Identity and paths

- schema identifiers moved from the v0.1 to v0.2 minor line;
- artifact and event versions moved to `0.2.0`;
- fixtures moved to `fixtures/v0.2/`;
- the patch package advanced to `0.2.1` without changing existing event meaning.

## Semantic changes from v0.1

- logical-record lifecycle and payload availability became independent axes;
- money became non-negative integer unscaled value plus scale and currency;
- reason fields became closed registry-backed enums;
- completed deletion replaced subject references with protected correlation
  digests and explicit tombstone provenance;
- invalid calendar timestamps became typed rejections rather than evaluator
  exceptions;
- imported provider judgment gained its own method, model, evidence, and neutral
  reconciliation reasons;
- cost, FX, data-driven metric definitions, cohort grouping, and undefined metric
  states became typed contract artifacts;
- Apple aggregate and minimal Apple Ads/Meta evidence became distinct from
  deterministic first-party attribution;
- processing purpose became a closed versioned catalog.

## v0.2.1 patch

Metric runs added optional `value_state` and `undefined_reason`. Omitting
`value_state` retained the earlier present-value meaning. Reconciliation added
`provider_modeled_conversion` for an external modeled row without an internal
candidate. Existing v0.2.0 conforming goldens retained their meaning.

## Consumer guidance

Do not mix v0.1 and v0.2 schemas, registries, fixtures, or evaluators. Use the
tagged contract as a complete set. New implementations should target the active
v0.4 contract instead of reconstructing v0.2 from this summary.
