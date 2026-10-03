# Scheduled Metric Runs

OpenMasu can run versioned metric definitions from the durable worker instead
of relying on an external cron command. A schedule belongs to one application,
stores an immutable definition and its RFC 8785 digest, and advances one target
date at a time. Existing schedules use UTC; explicit
[calendar cohort schedules](calendar-cohort-metrics.md) use their captured
qualified zone for both local date and receipt-watermark midnight.

Use the manual `npm run metrics:run` command for an operator-controlled one-off
calculation or a deliberately selected historical backfill. Use a durable
schedule when the worker should calculate a stable metric set every day.

For count, cost, CPI, separate revenue and ROAS in one saved population, use the
complete [acquisition KPI set](acquisition-kpis.md) and its synthetic schedule.
Its explicit eight-definition first-party D7 profile needs no extra worker or
report calculator; keep all roles on the same target and correction cutoff.

For multiple custom outcomes, use the dashboard's closed key selection or the
[custom-outcome selection request](custom-conversion-metrics.md#choose-outcomes-without-copying-metric-definitions).
Each key gets stable count/rate names in the existing D7 profile, without copying
JSON definitions or adding a scheduler. The convenience selection is app-wide
and requires nine days of lag; advanced grouping still uses the ordinary request.

For independently named `platform_*` cohort metrics, supply the full
[verified platform profile](verified-platform-acquisition.md). Source namespaces
stay explicit and cannot be blended with first-party campaign discovery.

## Manage schedules through the dashboard

1. Sign in with an admin-role key, open the app, and select **Manage daily metric
   schedules** under **App configuration**. The page is
   `/dashboard/apps/<app-id>/metric-schedules`; like the API, even its list
   requires the `administer` capability.
2. Start from [the synthetic schedule JSON](../examples/synthetic/metric-schedule.json).
   Paste the complete request into **Complete schedule request JSON**. Set
   `lag_days`, an optional `start_date`, `fx_policy`, `evaluations`, and any
   explicit `metric_definitions` there. This is the API request, not a second
   metric designer. The synthetic fixed USD rate is an example, not a live feed.
3. Select **Register daily calculation**. Registration uses the same validation
   and metric-ownership rules as the API below, then returns to the list. It
   does not calculate a run synchronously. The form is limited to 32 KiB after
   URL encoding; it accepts no credentials or provider configuration.
4. Refresh to inspect the immutable definition and its digest, status, lag,
   start date, last completed target date, pending date, safe reason, and any
   latest campaign-discovery receipt. Missing progress is not success;
   `partial_unknown` is not a complete upstream report. Open the app's cohort
   reports to read saved metric runs.
5. Select **Disable** for an active schedule. There is no edit, resume, or
   run-now action. Register a new schedule to change its immutable settings.
   Prior definitions and metric runs remain; an already claimed date may finish.

Page reads use the database reader role and do not write or schedule work.
Forms require the authenticated app scope, session CSRF token and same-origin
check. Read-only and operator roles cannot register or disable schedules.
The dashboard uses cookies, never a bearer key; API calls use bearer keys,
never the dashboard cookie. Validation errors return a reason without echoing
the submitted definition. Return to the form and correct the request.

## Register a schedule through the API

The synthetic example calculates D7 ROAS and D7 retention. Its lag is eight
days: at the current UTC midnight, the full seven-day elapsed window for the
target cohort has closed.

```bash
export OPENMASU_PUBLIC_BASE_URL=http://localhost:8080
export OPENMASU_APP_ID=app-local
export OPENMASU_ADMIN_KEY='<the bootstrap admin key>'

curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${OPENMASU_ADMIN_KEY}" \
  -H 'Content-Type: application/json' \
  --data-binary @examples/synthetic/metric-schedule.json \
  "${OPENMASU_PUBLIC_BASE_URL}/v1/admin/apps/${OPENMASU_APP_ID}/metric-schedules"
```

The response contains the immutable schedule identifier, normalized definition,
definition digest, initial status, and target-date checkpoint. The admin key is
a secret; do not put its value in source files, copied logs, or shell history.

The registration API rejects:

- a lag outside 1 through 365 days;
- a start date later than the currently eligible target date;
- malformed FX or metric definitions;
- static `cohort_date` or `metric_date` values in the grouping;
- identifying grouping fields;
- a metric name already owned by another active schedule for the same app.
- an aliased custom-conversion calculation with the same saved key and meaning
  already owned by an active schedule, or duplicated within the request.

Multiple active schedules are allowed only when their metric-name sets are
disjoint and custom-conversion meanings have no duplicate owner. This prevents duplicate report series while allowing cohort and
calendar-day metrics to use different lags.

## Discover campaign targets automatically

Instead of a fixed campaign list, an evaluation may explicitly include:

```json
{
  "metric_names": ["d0_roas"],
  "date_dimension": "cohort_date",
  "grouping": {},
  "campaign_discovery": {
    "policy": "selected_acquisition_and_cost_v1",
    "max_targets": 100
  }
}
```

Supply the explicit selected-first-party definitions described in
[selected acquisition metrics](selected-acquisition-metrics.md); ROAS additionally
requires the [safe cost-selection policy](cost-selection.md). Discovery supports
UTC install cohorts only. A fixed network, country, or attribution status may
restrict an evaluation, but a fixed campaign or an aggregate Apple series may
not be combined with discovery. Metric names must be disjoint across evaluations
when discovery is enabled: do not include an overlapping manual total.
Manual schedules without this field retain their definition digest and run IDs.

For each target date, the worker unions adopted acquisition-source campaign/network
pairs and current cost campaign/network pairs at the fixed receipt watermark.
It uses the same selected evidence join as the metric engine, not an arbitrary
click or a client campaign claim. Discovery includes a superset for gross and
net metrics; each metric still applies its own fraud policy and calculation.
The target set, definition digest and watermark commit before metric calculation.
New campaigns can enter the next date without editing the schedule, but cannot
join an already frozen date. Late corrections use the existing
[bounded correction requests](metric-corrections.md), not another scheduler.

| Observed input | Treatment |
| --- | --- |
| Known non-organic campaign and network | One explicit campaign/network/status target, deduplicated across acquisition and cost |
| Cost-only known campaign | Included; a value of zero observed revenue is not proof that all installs were received |
| Organic or unattributed | Separate status-only target; never combined with paid acquisition, with no invented campaign |
| Non-organic campaign/network missing | No guessed target; `unknown_nonorganic` count and `partial_unknown` receipt |
| Cost campaign/network missing | No all-campaign denominator; `unknown_cost` count and `partial_unknown` receipt |
| No eligible or unknown inputs | `known_empty` receipt, no fabricated metric run |
| Target overflow, unavailable privacy evidence or calculation failure | Checkpoint does not skip the affected date; explicit `safe_reason` |

The limit is 1–100 targets per discovered evaluation and at most 1,000 expanded
metric runs per date across the schedule. Discovery has a bounded statement
timeout and fails rather than publishing a truncated set. The list endpoint
returns `latest_discovery` (date, watermark, digests, counts, target count and
selection state), `pending_target_date`, and `safe_reason`. `partial_unknown`
means known targets were calculated but some input could not be assigned; it
is not a complete acquisition report. `known_empty` is local evidence at that
watermark, not a provider-completeness claim.

Discovery and publication share the existing tenant privacy fence. An app's
redaction/purge state changing after the target receipt prevents publication
of that pending date (`privacy_unavailable`). This is deliberately conservative,
including unrelated deletions in the same app. Missing historical evidence is
not reinterpreted as an empty cohort. Resolve the privacy boundary and explicitly
disable/re-register a schedule if its frozen date can no longer be reproduced;
the worker does not rewrite the receipt or resurrect deleted evidence.

## Inspect or disable schedules

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${OPENMASU_ADMIN_KEY}" \
  "${OPENMASU_PUBLIC_BASE_URL}/v1/admin/apps/${OPENMASU_APP_ID}/metric-schedules"

curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${OPENMASU_ADMIN_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{}' \
  "${OPENMASU_PUBLIC_BASE_URL}/v1/admin/apps/${OPENMASU_APP_ID}/metric-schedules/<schedule-id>/disable"
```

Definitions are immutable. To change a lag, grouping, metric definition, or FX
snapshot, use the explicit replacement preview below, or disable the old
schedule and register an independent one. Existing metric artifacts keep their
old definition digest; deletion/retention may still limit reproducibility.

Re-registering the same selection creates a distinct schedule and distinct run
identifiers, even when its input snapshot and numeric result are unchanged.
An input snapshot describes the evidence, not the complete computation identity:
different receipt cutoffs or full definitions may share it. Forward migration
`059_metric_run_identity.sql` replaces the old snapshot-tuple uniqueness
constraint with a lookup index. The run-ID primary key, immutable artifacts,
scoped access, and exact replay checks remain in force; no old rows are rewritten.
Apply normal database migrations before restarting the worker after an upgrade.

Re-registration is not automatic supersession. Reports using `latest` retain
all runs that no later run explicitly supersedes, so old and new runs may both
appear for a cohort. Keyset pagination distinguishes them by run ID. Choose the
intended saved runs for comparison: duplicate cohort keys are rejected, not
silently added together or resolved by picking an arbitrary run. Use an explicit
[correction request](metric-corrections.md) when a result should supersede a
specific prior calculation. Never delete evidence to resolve a duplicate series.

## Explicit replacement and report-series selection

Use `POST /v1/admin/apps/:app/metric-schedules/:schedule/preview-replacement`
with `{ "mode": "same_meaning" | "new_series", "schedule": <complete registration request> }`.
The preview reads through the reader role; it does not register, disable, claim,
or calculate anything. It returns the normalized `schedule`, effective start
date, field-by-field definition/scheduling differences, pending target date,
and `preview_digest`. `in_flight.policy` is `wait_for_claimed_date`: a replacement
must wait for a pending date to complete. It never cancels a claimed date or
deletes its checkpoint. Refresh the preview after progress changes or a UTC
midnight; an old digest is not permission to replace newly changed state.

`same_meaning` requires exact equality of the complete normalized definition,
including FX, metric definitions and evaluation/grouping/discovery policy.
Changing lag or start date alone can preserve meaning. Reordering definition
arrays or changing a descriptive FX source still requires `new_series`; this
is deliberately conservative, not a numeric equivalence inference.
`new_series` preserves every old run and never supersedes it, even if metric
names match. The series must be selected separately, not added together.

To confirm, POST the same mode and normalized schedule to
`/v1/admin/apps/:app/metric-schedules/:schedule/replace`, with the acknowledged
`preview_digest`. For same-meaning recalculation, explicitly supply at most 100
`supersessions`, each containing a `source_metric_run_id` and its
`calculation_key_digest` from an eligible preview `source_runs` entry. The
preview shows the full keys: tenant/app, complete definition and FX snapshots,
grouping, input snapshot, receipt watermark, bundle identity, privacy state and
value type. There is no metric-name-only or automatic all-runs selection.
No selected sources means no supersession. Different meaning forbids source
handoffs entirely.

The operation atomically disables the source and registers one successor.
Repeated identical confirmations return the same schedule with `replayed: true`
instead of another schedule/audit/state row. A changed definition under
`same_meaning` is 400; in-flight work, stale previews, unavailable/mismatched
source keys, competing successors and disabled sources fail closed (409).
Unknown or out-of-scope schedules use the same 404. Existing overlap validation
still prevents a name from being owned by another active schedule in the app.

The worker revalidates explicit source keys, grouping, complete meaning,
watermark and privacy before publishing a successor. It shares the source-run
fence with cost/late/privacy recalculation and acquires it before a
repeatable-read snapshot. A competing correction is not silently overridden.
Artifacts, series membership and checkpoint finalization commit together for
replacement dates. A one-time handoff is excluded from later replay manifests;
ordinary later corrections supersede their actual source, not an earlier ancestor.

In the dashboard's **Daily metric schedules** page, expand a schedule's
replacement form, choose the mode in its JSON and preview it. Review the same
API conditions; eligible source checkboxes are initially unchecked. Confirm
only the intended sources. The page redirects to the new schedule's report
selection. This uses forms and server-rendered HTML, not browser JavaScript.

API and dashboard metric queries share `metric_schedule_id=<saved schedule ID>`.
That filter uses append-only, scoped runtime provenance, not an inferred latest
name. Use `supersession=all` to read a replaced series' history and saved detail
pages for its original artifacts. Unfiltered `latest` retains every explicitly
unsuperseded run, including different meanings. Raw record counts and stored
reconciliation rows do not have schedule provenance: they reject this filter,
and the dashboard marks these sections as unavailable for a schedule selection.
CSV columns and contract metric-run fields are unchanged.

Forward migration `065_metric_schedule_series.sql` adds only runtime membership
and replacement idempotency constraints. New scheduled runs and explicit replay
descendants record their membership with their artifact. During confirmation,
historical runs without membership are indexed only when the complete original
deterministic schedule key (including frozen discovery targets, if applicable)
or an explicit source lineage proves ownership. Their artifact bytes are never
rewritten. Before that adoption, old unindexed runs remain available in ordinary
reports/details, but a schedule-only query cannot claim them. A preview refuses
more than 10,000 candidate historical runs; larger administrative migrations
are not claimed as supported by this bounded operation.

Previously downloaded comparison JSON remains unchanged and can still be read
as the original file. A new live `latest` comparison export is a new selection:
it does not resurrect a superseded value or assert that the old number is current.
Privacy withdrawal rules still apply to every live report/history/detail route.

## Execution and recovery model

For each active schedule, the worker:

1. derives the eligible target date as `current date in the captured zone - lag_days`
   (UTC for historical schedules);
2. fixes the input watermark to that date's local midnight converted to UTC;
3. persists the pending target date, watermark, and definition digest before
   metric evaluation;
4. writes each metric run through the ordinary repeatable-read cohort engine;
5. advances the checkpoint only after all expected artifacts and replay
   manifests commit.

For discovery and replacement schedules, metric artifacts and checkpoint advancement are one
transaction under the schedule lock. An interrupted calculation retries the
same immutable target receipt. Previously committed runs must still reproduce
byte-for-byte before a replayed checkpoint advances; conflicting late/backdated
input fails closed rather than replacing a saved result. A known-empty receipt
advances without calling the metric engine. Disablement prevents new claims;
an already frozen date may finish.

Metric run identifiers are deterministic for the schedule, target date,
watermark, definition digest, evaluation, and metric name. If the worker stops
after a metric transaction commits but before checkpoint finalization, the next
attempt recomputes without persistence and requires every stored artifact to be
RFC 8785 byte-identical before advancing. A partial or conflicting run fails
closed.

One cycle processes at most 31 dates per schedule. A larger historical backlog
remains pending and the durable scheduler retries it; the worker does not hide
the backlog by skipping dates. Disabling a schedule prevents new claims but an
already claimed date may finish. Disablement does not delete prior results.

The `metric_run` scheduler job writes sanitized success or failure health rows.
Monitor overdue work and consecutive failures as described in
[Runtime observability](operations/observability.md). The public repository
does not configure an external alert receiver.

## Evidence boundary

For mixed-currency money, register the explicit
[dated FX schedule example](../examples/synthetic/metric-dated-fx-schedule.json)
with its bounded snapshot. The worker uses its immutable currency/date rates
at the saved cutoff, and replay retains them. A later date outside the snapshot
is `missing_fx_rate`, not an inferred previous rate. Register a new schedule to
change FX meaning; old runs and downloaded comparisons keep their policy.
See [FX snapshots](fx-snapshots.md) for exact date, cost and rounding rules.

Explicit [selected acquisition detail profiles](acquisition-detail-metrics.md)
can also schedule ad-group/creative selections. Use the v0.4.16 definitions and
`date_dimension: "cohort_date"`; the schedule supplies the date. Legacy
definitions cannot silently acquire these dimensions. These profiles use
explicit grouping, not automatic campaign/creative discovery. Their saved
meaning is retained during bounded cost and late-input recalculation.

Runtime CI registers schedules with synthetic data, exercises both cohort-date
and metric-date definitions, verifies report and dashboard visibility, simulates
the post-commit crash window, and checks disablement. This is durable scheduling
evidence for the repository implementation. It is not evidence of production
capacity, provider freshness, currency coverage, or an operator's alerting.
The discovery cases add a new campaign on the next date, freeze a target set
before new cost arrival, exercise crash replay, cost-only/organic/unknown
inputs, scope isolation, empty dates, overflow and privacy changes. These cases
extend the existing runtime integration suite; no live provider call is required.
Re-registration cases also preserve old and new run bytes and replay manifests,
recover a checkpoint interruption without inserting another run, distinguish
cutoffs and FX definitions over identical inputs, enforce the run-ID key, and
verify reader pagination, duplicate-comparison refusal and explicit supersession.
Replacement cases additionally cover same/different meanings, idempotent
confirmations, stale/full-key refusal, claim/disable races, legacy ownership,
immutable old comparison files and API/dashboard CSV identity for a selected
series. These are synthetic PostgreSQL gates, not live operational acceptance.
