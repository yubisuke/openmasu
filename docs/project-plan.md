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
diagnostics, safe ingest recovery and optional monitoring rules/runbooks.
Separate UTC [daily activity](calendar-activity.md) counts session starts, custom
events and active installations without acquisition joins or period-unique sums.
Separate [verified payer metrics](payer-metrics.md) expose transaction and
paying-installation counts, payer rate and purchase-net ARPPU with explicit
store-projection authority, refund and undefined-denominator behavior.
[Scheduled comparisons](recurring-comparisons.md) retain explicit definition
revisions and aggregate snapshots for fixed-cutoff worker runs, with bounded
storage, expiry, deletion and conservative privacy suppression.
Matched backup/freshness commands and isolated, privacy-safe restoration are also
implemented ([#250](https://github.com/yubisuke/openmasu/issues/250)); a dedicated
Runtime gate owns synthetic evidence. These are not future implementation tasks. Backup custody,
live scheduling and recovery time remain separate operator responsibilities.

[Project status](STATUS.md) records their boundaries; the individual measurement
guides document their configuration. Published-release evidence remains separate.

## Next product slices

Updated: 2026-10-25. All 35 child implementations are present in current source;
the completed crosswalk follows the [roadmap sequence](roadmap.md#next-product-sequence).
Numbers are tracking links, not required background knowledge.

### Core and selected-use work

[Unity purchase binding](../sdk/unity/README.md#protected-store-purchases) is
implemented: the existing native preparation/submission paths retain consent,
credential and privacy boundaries. Queued/pending is not verification, and no
purchase authority or real-store qualification is added.

Saved bounded daily analysis and external revenue/ROAS/LTV, retention and outcome
comparison are implemented. External declarations never become captured execution
or completeness evidence; see [the comparison guide](cohort-comparison.md).
The prerequisites already implemented in the core plan do not need to be repeated.
Apple [postback observations](apple-postback-observations.md), [conversion meanings](apple-conversion-meaning.md)
and [campaign cost](cost-refresh.md#apple-ads-campaign-cost) are implemented.
Postbacks are not unique installs, selected meaning is not a verified binding,
and live Apple permissions/billing remain unverified. Other explicit dependencies
remain in the linked issues.

[Detailed Google costs](cost-refresh.md#explicit-google-ad-group-and-ad-costs)
are implemented with bounded explicit ad-group/ad selections, declared coverage,
reader-safe configured capability and existing saved-ROAS correction. Selected
children cannot become an unqualified parent denominator.
[Recorded-detail discovery](scheduled-metrics.md#discover-selected-ad-groups-or-creatives)
extends frozen daily target receipts to explicitly observed ad-group/creative
tuples. Unknown/parent-only input, overflow and privacy changes remain visible;
provider metadata crawling and live provider completeness remain unverified.

### Optional extensions

The [explicit engagement policy](engagement-outcomes.md#explicit-outcome-window-and-recorded-inactivity)
is implemented after rc.2: independent outcome windows, recorded SDK inactivity
and verified purchase/refund net preserve the historical 24h series. Unknown
history is undefined, device-reported opens remain forgeable, and no acquisition
or Apple aggregate identity is joined.

[App-scoped access](operations/access.md) is implemented after rc.2: one optional
app restriction narrows existing roles across API/session/list/export/job paths;
legacy keys remain tenant-wide. Issuance, rotation and revocation reuse existing
verifiers, sessions and audit storage, not a new IAM service.

[Explicit retention](operations/retention.md) is implemented after rc.2. It keeps
preview read-only, seals a bounded policy/target receipt on explicit apply, and
preserves privacy/history while reporting retention-affected replay honestly.

[Multiple-worker coordination](operations/observability.md#scheduler-behavior)
preserves tenant order and fences stale publications with the existing database.
Synthetic two-process probes cover provider stalls, cost/metric and privacy/export
order, owner-connection loss, lease expiry and process shutdown. Live capacity and
outstanding external requests remain separate operational boundaries.

The [additional Unity ILR sample](../sdk/unity/README.md#optional-levelplay-impression-revenue)
is implemented after rc.2. Provider types are an explicit shim; the existing
native queue, signed ingestion and worker revenue path retain their boundaries.

Implement only for the selected usage scope; these extensions are not required
for the completed integrated candidate.

[Fraud bundle preview](fraud-preview.md) is implemented: same retained evidence
shows decision and gross/net metric effects before receipt-bound activation.
Threshold, all-flag and negative-clock synthetic cases preserve ledger state;
recorded revisions replay without rewriting history. Incomplete old inputs are
unavailable and block activation, rather than becoming estimated detection rates.

### Integration and distribution

[#252](https://github.com/yubisuke/openmasu/issues/252) connects the required core
journey with the selected iOS/Unity/comparison paths and matching source, SDK,
upgrade and release evidence. Its dependencies include monitoring, backup,
Apple aggregate views, Unity purchase binding, daily analysis and broader
comparison semantics. Do not treat a local bundle or a green source-only check
as a published SDK.

The published prerelease is `v0.3.0-rc.2`. Its
[frozen integration record](validation/v0.3.0-rc.2-synthetic-evidence.md) reuses existing
journey, correction/privacy, package-consumer and backup suites. It adds no
service or parallel release harness. Frozen `v0.2.0` and `v0.3.0-rc.1` backups
passed forward migration and privacy reapplication. The
[publication receipt](validation/v0.3.0-rc.2-publication.md) records exact-commit
full CI, the annotated tag and eight verified public assets on 2026-10-24.

The downloaded rc.2 Android SDK passed the native Room queue/HMAC HTTP path
through durable backend processing to a daily install value and saved
analysis/CSV on JVM/Robolectric API 24. The publication receipt records the
later harness revision separately from the frozen SDK source. This completes
#252 within its declared synthetic scope, bringing the plan to 24 of 35 complete.
Existing fixture-projected campaign/cost/revenue tests remain separate; this is
not physical-device, all-platform onboarding or live-provider acceptance.

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
