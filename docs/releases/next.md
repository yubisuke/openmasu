# Next Release Scope

This is the living development inventory after published `v0.3.0-rc.1` at
`90a0f5f`, not a release note or a new release promise. The
[publication receipt](../validation/v0.3.0-rc.1-publication.md) binds its eight
SDK assets and full platform CI to the exact annotated tag. Do not change that
tag, assets, notes or frozen requirements to include later `main` work.

## Published integration baseline

The following work is included in the published version, not a future task list.

- Reader-only measurement health separates app/key configuration, receipt,
  processing, rejection, logical evidence and calculated runs.
- Exact money, ratio and count display, SSR filters and selection-preserving CSV
  exports retain audited unscaled integers.
- Supported new ad-revenue ROAS runs save their original operands, FX, selected
  cost and window evidence atomically. Legacy or removed evidence stays unavailable.
- Supported SQL runs save calculation meaning; incompatible or unknown meaning
  produces no ordinary numeric delta. Declaration-only comparison is explicit.
- Bounded all-page dashboard downloads use a fixed read-only selection with
  acquisition receipts, scope bindings and privacy/retention refusal.
- One provider-neutral aggregate CSV mapping records explicit units/undefined
  handling, canonical keys, input/mapping digests and safe error codes offline.
- One newcomer guide and the existing demo connect receipt, units, evidence and
  comparison. Synthetic corrected-cost and incompatible-window examples are
  derived by the reference evaluator, not hand-written expected business values.
- Default-off bounded daily cost refresh reuses one existing adapter with
  immutable app definitions, fixed lookback, database-clock fencing, bounded
  retries/stop and atomic cost/checkpoint publication. Empty is not zero;
  reader health excludes private account configuration and secret references.
- Explicit bounded cost-correction requests select affected saved ROAS runs and
  reuse their original definition/FX in the existing engine. Input-revision and
  pending states, transactional retry and immutable old/new supersession remain
  separate from unverified source completeness or inferred causes.

Contract wire/package identity remains `0.4.0`, with the additive patch ledger
through v0.4.10. These additions do not change its 57 reviewed fixtures or 741
goldens. The SDK is published as `0.3.0-rc.1`. Its eight downloadable assets
reuse the existing packager and standalone consumer gates, with public
re-download verification at the exact annotated tag.

## Unreleased source and planned product work

Explicit selected-first-party acquisition definitions now connect native SDK
installs to campaign/network advertising ROAS, LTV, retention and install count.
The additive v0.4.11 patch adds fixture 58, v0.4.12 safe cost selection adds
fixture 59, v0.4.13 selected-commerce definitions add fixture 60, and explicit
v0.4.14 custom-conversion definitions add fixture 61
(61 reviewed fixtures / 793 goldens in development), retaining
wire/package identity `0.4.0` and all earlier
goldens. Native inbox, fixed-watermark, privacy and SQL parity cases extend the
existing gates. See [selected acquisition metrics](../selected-acquisition-metrics.md).
Explicit purchase-net and total-net definitions now use selected acquisition,
with settled/capped-refund semantics and safe total-net ROAS denominators;
[cost selection](../cost-selection.md) explains overlap refusal and legacy replay.
Explicit bounded [late-input corrections](../metric-corrections.md) discover
revenue/commerce arrivals in a requested receipt interval, fix affected saved
runs and replay their definitions through the existing worker. Receipt discovery
is not automatically triggered by ingestion, and no history-wide scan is added.
Opt-in [daily campaign discovery](../scheduled-metrics.md) fixes campaign/network/status
targets at each date's watermark, includes cost-only campaigns, exposes unknown
inputs and reuses the same worker and cohort engine.
The [external calculation declaration bridge](../cohort-comparison.md#compare-a-saved-roas-with-explicit-external-calculation-conditions)
connects saved ad-revenue ROAS to explicitly declared external CSV calculations.
It requires opt-in and matching meaning, retains separate provenance, and never
upgrades the external claim to verified execution or completeness.
The [dashboard comparison flow](../cohort-comparison.md#compare-through-the-dashboard)
adds bounded file selection, condition review and identical JSON/HTML downloads
using those same pure functions, with no server-side comparison history.
[Recorded attribution analysis](../attribution-reasons.md) adds reader-only
fixed-cutoff counts by stored acquisition status, method and reason, with
one retained install per subject and current privacy filtering.
[Daily schedule controls](../scheduled-metrics.md#manage-schedules-through-the-dashboard)
add admin-only SSR registration, immutable definition/checkpoint inspection and
disablement through the existing API service and worker. No extra scheduler,
edit/resume/run-now action or provider credential form is added.
The following schedule-recovery fix removes the overbroad input-snapshot tuple
uniqueness constraint through forward migration `059_metric_run_identity.sql`.
Distinct schedules, cutoffs and FX definitions can retain the same input evidence
without colliding. Run-ID uniqueness, old artifact bytes and exact retries remain;
re-registration does not implicitly supersede prior results.
The TypeScript reference retention calculation also now joins sessions to its
eligible installation cohort, matching the denominator's selected-source and
gross/net filters. Synthetic TS/Python/SQL cases cover previously wrong 0% and
100% outcomes, gross/net arithmetic and a late session. No existing golden,
metric-definition identity or saved artifact is rewritten by this correction.

Supported-source upgrade procedures, single-host deployment preflight/restart,
capacity visibility and the limited backend/report HTTP contract also have
merged acceptance scopes and are included in the publication. The integration
batch is complete. The next product batch is selected in
[plan #172](https://github.com/yubisuke/openmasu/issues/172), with the ordered
[roadmap](../roadmap.md#next-product-sequence) as its canonical crosswalk.
All eight original workflow slices have source implementation, including explicit
custom-event outcomes (#177), D30 total-net ROAS evidence (#178), correction controls
(#179) and the saved-retention matrix (#180). The separately reproduced
schedule identity collision (#200) and reference retention population mismatch
(#202) now have source implementation.
No development slice is part of the
published baseline, and no next
version or release scope is selected by that development plan.
These synthetic scopes do not establish real recovery, hosting/TLS,
representative capacity or live backend/provider interoperability.

Begin with selected acquisition-source projection, overlapping cost-grain
safety, purchase/total-net acquisition, late-input correction and campaign
discovery (#182/#183/#191/#184/#185). All five have source implementation.
The external declaration bridge (#173), dashboard comparison (#174) and
attribution analysis (#175) and daily calculation controls (#176) also have
source implementation. [Custom-event outcomes](../custom-conversion-metrics.md)
(#177) use a single saved key, distinct eligible converters and elapsed D7,
with TS/Python/SQL parity and independent 3/10 arithmetic. Different keys are
not comparable; zero and empty-cohort undefined remain distinct.
[D30 total-net explanations](../metric-explanations.md) (#178) retain original
advertising, purchase, refund and cost components with exact rounding. Version 1
ad-revenue evidence remains readable; older and unsupported runs are not
backfilled. Apply migration 060 before the new worker. The dashboard now
offers condition review and submission for existing bounded cost recalculation,
plus reader-visible jobs and original/replacement details (#179). It does not
add a selector or start work on GET/preview. [Saved-retention presentation](../dashboard-analysis.md#saved-retention-matrix)
(#180) aligns compatible cohorts and activity-day horizons from the existing
bounded report page, with exact values/details, separate duplicate snapshots,
per-observation maturity and explicit unrequested pages. It adds no calculation,
unbounded query or browser dependency.
App Store preparation now issues installation-scoped retry-stable tokens and
erases their protected anchors through normal deletion and restore reapplication.
It does not yet submit transactions, create verified financial facts or expose
a Swift purchase API. Full App Store binding, finer advertising grain and separate
re-engagement outcomes (#186-#188) remain scoped follow-ups. These connections
must not be inferred from existing component coverage. Each Issue reuses
existing services and relevant synthetic
gates. New provider connections, services, databases, broad re-audits or heavier
CI are not automatic next steps.

## Unverified boundaries

No real provider account, credentials, exports, physical devices, live campaign,
consumer store delivery, platform approval or production deployment is verified.
No equivalence with another MMP or end-to-end exactly-once provider behavior is
claimed. An elapsed window does not prove complete upstream arrival.

Synthetic tests prove only their recorded source revision and named behavior.
Use the existing [release runbook](../operations/release.md) to bind a future
version, matching full-platform CI, SDK/SBOM artifacts, checksums, annotated tag
and GitHub Release to one exact green commit. Distribution should distinguish
compiled Android modules from source-distributed iOS and Unity packages. An
untagged bundle is only a candidate; this document publishes nothing.
