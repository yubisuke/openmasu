# Automatic metric corrections

Automatic correction is **off until an administrator configures an app policy**.
It uses the existing PostgreSQL ledger, tenant worker cycle and durable metric
recalculation jobs. There is no additional scheduler, provider lookup or
all-history backfill. Original artifacts and saved definitions remain immutable.

## Configure, pause and inspect

`POST /v1/admin/apps/:app/metric-correction-policy` requires `administer`.
The body is closed; this example is synthetic:

```json
{
  "enabled": true,
  "date_from": "2026-08-06",
  "date_to": "2026-08-07",
  "metric_names": ["d30_total_net_roas"],
  "receipts_per_cycle": 5,
  "runs_per_page": 20,
  "maximum_runs_per_receipt": 200
}
```

Both dates are inclusive, with at most 31 days. Omitted metric names mean eligible
saved runs **in this finite cohort range**, not all history. Limits/defaults are
20/5 receipt pages per call, 100/20 targets per page and 1000/200 frozen candidate
targets per receipt. The ordinary worker calls the planner with a global budget
of five pages per tenant cycle, then the existing calculator with five items.
A larger policy budget cannot increase that ordinary process budget.

Post the bounded configuration with `enabled: false` to pause. The policy lock
serializes the operation with planning and publication: after it returns no
further automatic calculation publishes until re-enabled. Manual and privacy
jobs remain independent. Changed configuration applies to future receipts;
captured receipts retain their definition/digest. Pausing continues to capture
new evidence, so resuming does not silently skip it. No historical scan precedes
policy registration; use explicit correction requests for operator-selected
older work.

`GET` on the same path requires `read`. It returns the policy, aggregate retained
receipt states/cutoffs/processed-target counts and existing cost-refresh states.
Source/installation identifiers, payloads, private targets/replay manifests and
tokens are omitted. Unknown/cross-tenant apps have the normal 404 boundary.
`/dashboard/apps/:app/metric-recalculations` renders these observations alongside
existing jobs and original/successor explanation links. Reading starts no work.
Receipt `completed` means **planning finished**, not successful calculation;
inspect the jobs. Processed-target counts include ignored/nonmatching candidates,
not contributing events. Retained receipts never establish provider completeness.

## Fixed evidence and bounded continuation

Statement triggers capture canonical revenue/purchase/refund, published cost
rows and installation attribution revisions in the **same transaction** as the
evidence. Scope plus source kind and immutable source reference is unique.
Rollback removes both; duplicate publication creates no second receipt. No
timestamp/sequence high-water cursor can miss an older transaction committing
later. Transition tables avoid a separate policy query for every imported row.

Planning checks the committed source, then fixes a cutoff covering its recorded
timestamp and local planning time, plus a bounded candidate manifest in the
configured period. This is an operational cutoff, not an upstream arrival SLA.
Microsecond timestamps round the operational millisecond cutoff **up**, never
backwards. Existing saved definition, FX, full grouping and explicit successor
lineage are retained. A similarly named new series is not a successor. Included
late records are recognized by actual available evidence refs; a watermark alone
cannot prove an input was visible to an older transaction.

Each short transaction commits jobs and its continuation together. Insertion
failure leaves neither a partial job nor an advanced cursor. Concurrent planners
lock policy/receipt rows; the existing calculator fences claims and source runs.
Waiting for a predecessor has a 30-second backoff without spending an error
retry. Other planning/calculation errors have a three-attempt bound. Target
overflow becomes `selection_limit`, never truncated success. There is no
unbounded retry or widening of the configured range.

## Supported scope and privacy

- Late inputs: existing saved install-cohort revenue LTV/ROAS, elapsed windows
  through day 90, including supported settled-commerce and refund-reversal rules.
- Cost: saved acquisition-day ROAS with compatible campaign/network/country and
  declared detail dimensions. Only completed imports with cost rows are sources;
  empty, failed or merely attempted refreshes are not cost revisions.
- Attribution: selected-first-party-click revenue LTV/ROAS. Match both explicit
  predecessor membership and current selection: a move **out** of a group also
  needs correction. Check the attribution artifact digest and available evidence
  again before replay.

Other definitions are ignored when unrelated, or recorded
`unsupported_definition` when the relationship cannot be safely determined.
Missing private replay/evidence is unavailable, not a copied result. Selected
daily acquisition, retention/custom, imported/platform/Apple aggregate and
engagement attribution correction are not implied by this narrow selector.

Planning and calculation share existing tenant privacy fences/backlog gates.
Deleted source evidence cannot be restored by a receipt. Redaction between
queueing and replay makes that item unavailable; independent privacy jobs
withdraw/recalculate affected saved runs. `attribution_update_state` appends a
report CSV column and an optional attribution channel extends
`recalculation_state`. Older saved comparisons omit it and remain readable
unchanged. Job/successor state is not a guarantee that an original value was
correct or that a new value's only cause was the triggering source.

Synthetic regression covers two cohort days with late/cost/attribution changes,
immutable originals and an unrelated campaign; 105 inputs and a 106-target paged
manifest; pause/resume, concurrent calculators, duplicate publication; redaction
before planning/replay; and atomic job/cursor rollback. Live provider behavior,
production concurrency/SLO and operator-specific privacy obligations remain
unverified. No real data, device or provider credentials are required.
