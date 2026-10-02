# Cost Corrections and Bounded Metric Recalculation

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
The role matrix covers both new control tables. No contract, reviewed golden,
dependency, service or physical-device/provider requirement is added.

Real provider revisions, credentials, completeness, long-running operator use
and production capacity remain unverified. Legacy runs without recorded
calculation meaning cannot be selected reliably. Unsupported or unavailable
replay bodies require a separate reviewed decision, not a synthetic backfill.
