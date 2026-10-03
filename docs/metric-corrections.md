# Input Corrections and Bounded Metric Recalculation

For opt-in receipt-driven processing in a finite cohort period, see
[automatic metric corrections](automatic-metric-corrections.md). The explicit
requests below retain their bounds; privacy correction remains independent.

A completed cost import can revise the inputs of an already saved ROAS run.
An input revision does not prove that a value changed or explain a causal
measurement difference. Original cost records and metric runs remain immutable.
This path reuses the existing SQL metric engine, original replay definition and
FX policy; it does not add a second engine or automatically recalculate history.

## Read revision state

Ordinary metric JSON, CSV and the dashboard expose `cost_update_state`:

- `input_revised`: a newer matching cost row exists after this run's watermark;
- `recalculation_pending`: an explicit request for this run is queued, claimed
  or waiting for a bounded retry;
- `no_recorded_revision`: no matching newer cost input is visible at the selected
  cutoff; this is not proof that upstream data is complete;
- `unknown`: original calculation meaning was not recorded.

This operational field is appended to existing CSV columns. It does not mutate
the artifact's original `data_freshness`, integer value or snapshot. The
`latest` filter means unsuperseded saved runs, not current upstream truth. A fixed
report watermark also bounds visible cost revisions and recalculation requests.

## Request a selected recalculation

In the app dashboard, follow **Review input corrections and recalculation jobs**.
All readers can inspect the latest 20 jobs and follow each original/replacement
run's saved details. Users with the `operate` capability can enter a completed
cost import receipt, inclusive cohort date range, fixed UTC watermark and an
optional comma-separated metric list. Select **Review requested conditions**,
check the normalized values, then **Request this recalculation**.

The confirmation page is stateless and does not enqueue work or claim a target
count. On confirmation, the same API service below validates the receipt,
selects current eligible runs and applies the bounds atomically. Repeated
normalized requests return the same job, including after it completes. Refresh
the list to observe `queued`, processing/retry, `completed` or `unavailable`;
missing selections or replacement links are not successful calculations.
API-created late-input jobs are visible in the same list with their trigger
type, but the initial dashboard form requests cost-driven jobs only.

Reading the page uses the reader role and does not modify jobs or metric runs.
Preview and submission require a dashboard session, `operate` capability and
Origin/CSRF checks; bearer credentials are not read on dashboard routes.
These controls reuse the existing service and worker, not a second scheduler.
The saved-detail links preserve unavailable/redacted evidence and never infer
that a numeric difference was caused by cost alone.

Get the completed `last_import_run_id` and `last_snapshot_digest` from
`GET /v1/admin/apps/:app/cost-schedules`, or use a completed manual-cost import
receipt. Empty refreshes have no import receipt and cannot create recalculation
work. These IDs describe recorded acquisition, not authenticated upstream truth.

Use the existing app-scoped bearer API with the `operate` capability:

```http
POST /v1/admin/apps/app-a/metric-recalculations
Authorization: Bearer <private-operator-key>
Content-Type: application/json

{
  "cost_import_run_id": "01800000-0000-7000-8000-000000000000",
  "date_from": "2026-08-01",
  "date_to": "2026-08-01",
  "watermark": "2026-08-11T00:00:00.000Z",
  "metric_names": ["d7_roas"]
}
```

All values in the example are synthetic. Supply an actual completed private
import receipt in an authorized deployment; this document grants no access to
real data. Dates here are **inclusive**, at most 31 days. The optional list of
metric names narrows selection; it never supplies a replacement definition.
The canonical UTC millisecond watermark must cover the selected cost revision.
No global-history option is accepted.

At acceptance, the request fixes tenant/app, cost-import ID and snapshot digest,
date range, watermark, source run IDs and original replay digests. Selection is
limited to 100 unsuperseded cost-based cohort ROAS runs with recorded meaning,
whose cohort/campaign/network/country match newer costs in that completed import.
An over-limit selection fails without creating partial work. Missing private
replay manifests are recorded as `unavailable`, not rebuilt from today's rules.
An identical normalized request returns its original job even after completion.

`GET /v1/admin/apps/:app/metric-recalculations` is reader-only and returns the
latest 20 jobs with at most 100 items each: source/replacement run IDs, input
snapshot receipt, range, states and safe reasons. It excludes replay bodies,
credentials, raw evidence references and claim tokens. Other apps/tenants and
unknown import receipts cannot reveal the private source.

## Late advertising revenue, purchases, refunds and custom outcomes

The same `operate`-authorized POST accepts `trigger_kind: late_events`. It does
not fabricate a cost-import receipt. Supply either 1–100 `source_record_ids`
or an explicit receipt interval of at most 24 hours, exclusive at the start
and inclusive at the end. The receipt cutoff must not exceed `watermark`.
The following bounded query discovers accepted revenue/commerce/custom-outcome inputs; it
does not require downloading their payloads or transaction identifiers:

```json
{
  "trigger_kind": "late_events",
  "source_received_from": "2026-08-12T00:00:00.000Z",
  "source_received_to": "2026-08-13T00:00:00.000Z",
  "date_from": "2026-08-06",
  "date_to": "2026-08-06",
  "watermark": "2026-08-13T00:00:00.000Z",
  "metric_names": ["d30_total_net_roas"]
}
```

These values are synthetic. The cohort range is inclusive and at most 31 days.
An interval containing over 100 source records or a selection containing over
100 candidate unsuperseded runs fails with `metric_recalculation_input_limit`
or `metric_recalculation_selection_limit`; no partial job is saved. Narrow the
input interval, cohort range or metric list instead of silently truncating it.
Selection has a 15-second SQL statement limit and no all-history option.

Support covers saved installation-anchored, elapsed-window revenue sums,
revenue-per-cohort LTV and revenue-over-cost ROAS, using the saved advertising,
purchase-net or total-net numerator. Canonical accepted `ad_revenue`, settled `purchase`
and settled `refund` projections are considered. A refund must have the existing
same-installation/currency settled purchase target. Unknown/unbound commerce,
pending or reversed amounts, non-canonical deliveries and future receipts do
not trigger calculation. Receipt acceptance is not independent provider proof.

The existing explicit custom-conversion D7 profile also supports admitted
`custom_event` inputs with an installation binding and the exact saved
`conversion_event_key`. A late tutorial event selects its tutorial count/rate,
not a signup outcome or revenue metric. Explicit IDs and the bounded receipt
interval share this selector, its limits, privacy fences and immutable replay.
This manual correction support does not claim every automatic receipt planner
or arbitrary retention/event-count profile consumes custom outcomes.

Impact selection reuses selected first-party click evidence and the saved
definition's cohort, attribution status, gross/net policy and half-open window.
It does not infer a campaign from arbitrary clicks. Refunds affect purchase-net
and total-net metrics, not advertising-only metrics. Advertising input does not select a
purchase-only numerator. Legacy, selected-acquisition, disjoint-cost
and selected-commerce profiles retain their original replay definitions and FX.

The accepted job fixes its input receipt digest, candidate metadata, original
run IDs/replay digests and watermark. Status responses expose aggregate
`input_status_counts`, `selection_status` and `source_snapshot_digest`, never
source record/transaction IDs or payloads. `eligible` means accepted input;
`matched_to_supported_runs` and `not_matched_to_supported_runs` describe the
bounded definition selection, not universal contribution or completeness.
`no_eligible_inputs` and `no_matching_runs` are distinct recorded results.
Unavailable replay, unsupported definitions, unavailable historical evidence
and another pending request appear as `unavailable` items with separate safe
reasons. An overlapping pending request is not silently retargeted to a future
replacement: inspect the first job, then submit a new bounded request.

Late-input jobs also refuse removed source or historical evidence at execution,
using `input_unavailable`. They do not rebuild missing evidence from current
values. Original artifacts stay immutable. `late_input_update_state` is
appended to metric JSON/CSV and the dashboard; it distinguishes pending,
completed, unavailable and `no_recorded_request`. The latter is not a claim
that no late input exists. Cost-specific labels continue to describe cost only.

**Automation boundary:** detection requires this explicit bounded API request.
The existing worker automatically processes the accepted items. Ingestion
does not enqueue unlimited history work, and daily schedule checkpoints are
not rewound. No new scheduler, provider call, metric engine or service is added.

## Execution and recovery

The existing worker checks explicit requests each tenant cycle. It processes
at most five items by default (hard maximum ten), with a 120-second claim,
60-second SQL statement bound and at most three attempts. Retry waits 30 seconds;
operator investigation is required after exhaustion. There is no unbounded
retry or implicit all-history scan. A crash before publication leaves a recoverable
claim; stale tokens cannot complete another claim.

The worker acquires the existing privacy read fence and a source-run lock before
opening its repeatable-read snapshot. It refuses pending deletion work, verifies
the original replay digest, and uses current redaction/retention state
(`privacy_state=after`). It never returns to `before` to restore deleted inputs.
Existing supersession makes a competing request `skipped` rather than creating
another replacement of the same source run.

The engine writes the new run, original operands/meaning, replay manifest and
completed item in one transaction. The deterministic replacement ID depends on
the accepted job/source run. `computed_at` is the fixed request timestamp;
`data_freshness=recalculated`, the chosen watermark and `supersedes_metric_run_id`
identify the new audit boundary. A failed transaction publishes none of them.
The private replay manifest stays private; the public report exposes only saved
aggregate calculation meaning and snapshots.

The new watermark may also admit later events, not just later cost. Do not
label the whole value difference as caused exclusively by a cost correction.
Use history (`supersession=all`) and saved run details to inspect both snapshots.
The comparison tool still refuses ordinary numeric deltas when privacy, FX,
window, maturity, grouping or calculation meaning are incompatible or unknown.
Before/after privacy semantics remain distinct even when no deletion is observed.
Comparison acquisition also refuses superseded or redaction-affected runs before
they can become an ordinary downloadable snapshot; correction does not bypass
that existing privacy and reproducibility gate.

## Synthetic evidence and boundaries

The existing Runtime CI runs `bounded cost correction recalculation` tests for:

- changed cost → affected JP cohort only → pending label → ROAS 1.5 to 0.75;
- unchanged GB cohort, old/new snapshot references and immutable original runs;
- duplicate requests, concurrent workers and committed replay;
- expired-claim recovery and fixed input revision;
- transaction rollback after run insertion, followed by same-job recovery;
- cross-tenant and premature-cutoff refusal plus replay-digest failure;
- redacted/purged revenue exclusion and historical/affected snapshot refusal.

Unit gates cover closed requests, range/work bounds and honest dashboard labels.
The `bounded late revenue and commerce recalculation` Runtime suite exercises
purchase USD 10 / cost USD 10 = 1, late advertising USD 20 = 3, then late refund
USD 4 = 2.6; unchanged prior runs, selected source, unrelated/window/future
inputs, canonical retry, concurrent workers, expired claims, pending conflicts,
missing replay, limits and deletion fences. The contract goldens are unchanged.
The role matrix covers both new control tables. No contract, reviewed golden,
dependency, service or physical-device/provider requirement is added.

Real provider revisions, credentials, completeness, long-running operator use
and production capacity remain unverified. Legacy runs without recorded
calculation meaning cannot be selected reliably. Unsupported or unavailable
replay bodies require a separate reviewed decision, not a synthetic backfill.
