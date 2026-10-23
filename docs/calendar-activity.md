# Daily recorded activity

The opt-in `metric-calendar-activity` / `0.4.25` profile measures activity on a
UTC date, independently of acquisition cohorts. It reuses accepted logical
events, the existing SQL worker, saved runs, schedules and dashboard. No install
event, attribution result or campaign is needed to establish the population.

| Metric | Unit and population |
| --- | --- |
| `daily_session_starts` | Accepted canonical `session_start` events, not distinct session IDs |
| `daily_custom_events` | All accepted canonical `custom_event` events, without an event-key filter |
| `daily_active_installations` | Distinct `(tenant, app, installation_id)` in the union of those two event kinds |

An installation with only a custom event is active. Several events from one
installation still contribute one active installation. A redelivery of the same
logical event does not add a session start or custom event. Distinct event IDs
can represent separate starts even if their session IDs match.

## Date, evidence and limits

- `metric_date` is the activity date, not the installation date. Use the UTC
  half-open occurrence interval `[00:00, next 00:00)` and include only receipts
  at or before the saved inclusive watermark.
- UTC and exactly `metric_date` grouping are supported. Country, campaign,
  network, attribution-status, cohort-date and provider filters are rejected,
  rather than inferred from unrelated acquisition evidence.
- This is recorded **gross** activity. Net/fraud-filtered activity is not
  defined by this profile and is rejected. Receipt/admission protections still
  apply; accepted device reports are not independent proof of human behavior.
- Operational runs use current privacy state. Completed deletion removes the
  affected activity, invalidates saved results and uses existing immutable
  replay to produce replacements. A historical `before` reference evaluation
  is not permission to disclose deleted data.
- Late receipts are absent from an earlier cutoff. Recompute explicitly at a
  later saved cutoff; do not mutate the earlier result. An observed empty day
  is zero, while a missing saved run is missing. Closing a UTC day is not proof
  that every device has delivered all events.

These are installations, **not unique people or DAU/MAU**. Daily active counts
must not be summed into a period-unique audience. The same installation can
appear on several days; period comparison aligns daily values without summing
them. No identity merging, cross-device inference or monthly-unique estimate
is provided. Apple aggregate postbacks and unrelated revenue events are not
activity inputs. Imported events count only when they are actually admitted
as canonical session/custom events with an installation ID; matching external
campaign text is irrelevant.

## Calculate and read

In the app's metric schedules, use **Schedule daily activity**. The form creates
one schedule for the three fixed definitions, with `date_dimension=metric_date`,
UTC and at least one day of lag. It uses the existing administrator, CSRF,
tenant isolation, schedule ownership and replacement rules. It does not change
the recommended acquisition schedule or enable automatic target discovery.

For explicit API/CLI inputs, import `calendarActivityMetricDefinitions()` from
`@openmasu/contracts/definitions`. Put the returned definitions in
`metric_definitions`, retain the existing explicit `fx_policy` envelope (no
money is calculated), and select the three names in an `evaluations` entry with
`grouping: {}` or an explicit `metric_date`. [Scheduled metrics](scheduled-metrics.md)
describes the full request. `npm run metrics:run -- --date=2026-08-20
--definitions=<file> --watermark=2026-08-22T00:00:00.000Z` defaults omitted grouping
to that UTC `metric_date` and uses current privacy state. An explicit grouping
date is preserved. Do not combine cohort and activity anchors in one evaluation.

The activity table labels units and UTC dates. JSON/CSV append `activity_unit`
and `activity_date` without reordering older columns. Saved analyses and bounded
previous-period views retain definition, bundle, watermark and privacy context;
they do not join activity to acquisition KPIs or manufacture period uniques.

## Synthetic evidence

[Fixture 72](../fixtures/v0.4/72-calendar-activity/README.md) independently derives
15 saved values across repeated sessions, a custom-only installation, redelivery,
both UTC boundaries, delayed receipt, deletion and an empty day. Existing suites
cover TypeScript/Python/SQL parity, schedule-to-report/CSV, closed-profile
admission and deletion replay. No new service, table, dependency or CI job is
needed. Physical-device delivery and real-data representativeness are unverified.
