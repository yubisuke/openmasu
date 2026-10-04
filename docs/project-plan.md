# Project Plan

## Objective

Make OpenMasu usable for its declared measurement scope: setup, receipt,
daily calculation, explanation, correction, comparison and recovery.
Replacing an existing MMP is not the objective.

## Sources of truth

| Topic | Canonical source |
| --- | --- |
| Product and current evidence | [Product scope](product-scope.md) and [Project status](STATUS.md) |
| Order and dependencies | [Roadmap](roadmap.md) and [functional issue plan](https://github.com/yubisuke/openmasu/issues/218) |
| Contract | [Specification](../spec/event-metric-contract-v0.4.md), schemas, registries and reviewed fixtures |
| Placement and design | [Development](development.md), [Architecture](architecture.md) and [design index](design/README.md) |
| Safety and operation | [Privacy/security](privacy-security.md), [threat model](threat-model.md) and [operator checklists](validation/README.md) |

This page is the roadmap's acceptance crosswalk, not a second backlog.
Historical reviews and closed integration plans do not override current behavior.

## Workstream order

Correctness before breadth; integrate existing workflows before promoting a
release. Keep missing operator evidence explicit. Use one bounded workflow per
PR, existing services and test suites, and proportionate evidence rather than
a growing list of overlapping checks.

## Implemented integration work

The earlier integration plan and structural preparation are complete.
Current source includes acquisition projection, cost grain safety, commerce,
schedule recovery, late-input correction, comparison/export, saved operands,
detailed acquisition and re-engagement outcomes.

The current functional plan has also completed privacy replay, daily acquisition,
schedule replacement, bounded automatic correction, freshness, verified platform
and imported profiles, calendar/FX definitions, same-set acquisition KPIs,
standard retention, multiple custom outcomes, guided setup, recent receipt
diagnostics and safe ingest recovery. These are not future implementation tasks.

[Project status](STATUS.md) records their boundaries; the individual measurement
guides document their configuration. Published-release evidence remains separate.

## Next product slices

Updated: 2026-10-04. Fifteen of 35 children are complete; the 20 remaining
issues below map directly to the [roadmap sequence](roadmap.md#next-product-sequence).
Numbers are tracking links, not required background knowledge.

### Core and selected-use work

| Workstream / issue | Acceptance boundary |
| --- | --- |
| Minimal monitoring and recovery: [#248](https://github.com/yubisuke/openmasu/issues/248), then [#250](https://github.com/yubisuke/openmasu/issues/250) | Small rules from existing metrics and actionable recovery; scheduled backup freshness and synthetic restore/privacy reapplication. No new observability service or production recovery claim |
| Daily analysis and comparison: [#244](https://github.com/yubisuke/openmasu/issues/244), [#245](https://github.com/yubisuke/openmasu/issues/245) | Saved, complete bounded selections and explicit meaning for purchase/net, total revenue, retention and outcomes; do not infer upstream completeness or compare incompatible populations |
| Apple aggregate usability: [#233](https://github.com/yubisuke/openmasu/issues/233), then [#234](https://github.com/yubisuke/openmasu/issues/234); [#235](https://github.com/yubisuke/openmasu/issues/235) | Window/suppression/unknown states, meaning-bound conversion decoding and scoped cost through existing paths. Never equate postbacks with unique installs; live Apple permissions remain unverified |
| Unity purchase binding: [#239](https://github.com/yubisuke/openmasu/issues/239) | Existing native verified preparation/submission through Unity, preserving consent, credential and privacy behavior; no new purchase authority or real-store claim |

The prerequisites already implemented in the core plan do not need to be repeated.
Apple conversion-schema work depends on the aggregate view; all other explicit
dependencies remain in the linked issues.

### Optional extensions

Implement only for the selected usage scope. They are not all prerequisites for
the integrated candidate.

| Issue / workstream | Narrow acceptance |
| --- | --- |
| [#231](https://github.com/yubisuke/openmasu/issues/231): Calendar activity | Active installations, sessions and event counts stay separate from acquisition cohorts |
| [#232](https://github.com/yubisuke/openmasu/issues/232): Payer metrics | Verified purchases support payer rate, purchase count and ARPPU with explicit denominator/window |
| [#236](https://github.com/yubisuke/openmasu/issues/236): Detailed cost adapter | Declared ad-group/ad grain without inferred parent allocation |
| [#237](https://github.com/yubisuke/openmasu/issues/237): Detailed target discovery | Bounded ad-group/creative discovery after detailed cost support |
| [#238](https://github.com/yubisuke/openmasu/issues/238): Additional Unity ILR | Thin callback adapter into existing advertising revenue; unknown is not zero |
| [#240](https://github.com/yubisuke/openmasu/issues/240): Engagement policy and purchase outcomes | Independent windows/inactivity and purchase-net definitions, not acquisition rewriting |
| [#246](https://github.com/yubisuke/openmasu/issues/246): Recurring comparison | Versioned configurations/snapshots after saved analysis and broader comparison semantics |
| [#247](https://github.com/yubisuke/openmasu/issues/247): App-scoped access | Explicit app restrictions without weakening tenant isolation |
| [#249](https://github.com/yubisuke/openmasu/issues/249): Retention expiry | Explicit-policy preview and bounded expiry with privacy-safe replay |
| [#251](https://github.com/yubisuke/openmasu/issues/251): Multiple workers | Tenant-wide ordering and stop/recovery evidence before multi-replica claims |
| [#253](https://github.com/yubisuke/openmasu/issues/253): Fraud bundle preview | Same synthetic evidence shows decision and metric effects before activation |

### Integration and distribution

[#252](https://github.com/yubisuke/openmasu/issues/252) connects the required core
journey with the selected iOS/Unity/comparison paths and matching source, SDK,
upgrade and release evidence. Its dependencies include monitoring, backup,
Apple aggregate views, Unity purchase binding, daily analysis and broader
comparison semantics. Do not treat a local bundle or a green source-only check
as a published SDK.

## Next development foundations

The [roadmap foundations](roadmap.md#next-development-foundations) are implemented.
New HTTP work uses authenticated feature controllers and typed ViewModels;
renderers remain pure. Metrics use shared profile admission and independent
TS/Python/SQL calculation. Ingestion preserves application-owned transactions
and client-only writers. Privacy correction uses saved-manifest replay, not
copied historical numbers. See [Development](development.md) for these seams.

No new framework, service, queue or structural prerequisite is implied by this
plan. A feature needs a new boundary only when existing code cannot express its
declared responsibility cleanly.

## Change acceptance

Every change reports:

- its user-visible or operational outcome;
- relevant synthetic checks, including what was not run;
- contract/golden changes and derivations, if any;
- remaining provider, device, platform and deployment boundaries.

Run focused existing tests while editing, then the applicable full gate once.
Documentation changes keep current status, roadmap and this crosswalk aligned.
Full `validate` already checks documentation; do not append its standalone
subsets. Follow [Schema versioning](schema-versioning.md) for contract changes.

## Public and private work

Only synthetic data and public examples belong here. Credentials, provider
exports, real campaign/device values, private fraud thresholds and operational
records stay outside the repository. Private operator validation is optional
and separately authorized; development must remain useful without it.
