# Custom-event cohort outcomes

Use this profile to answer: of the installations acquired in a cohort, how many
reached one explicitly selected outcome? It measures installations, not people,
devices across reinstalls, event frequency or a multi-step funnel.

Multiple outcomes can run concurrently. Each metric still selects exactly one
event key; there is no implicit total across different outcomes.

## Choose outcomes without copying metric definitions

Sign in with an admin-role key, open the app's **Manage daily metric schedules**
page, and use **Schedule custom outcomes**. Select the keys, a lag of at least
nine days, and an optional start cohort date. The ordinary durable worker then
calculates each selected key's count and rate over the app-wide install cohort.
Registration does not execute a run synchronously.

The closed selection lists the first 100 available observed keys, in key order,
for the authorized tenant/app; a request may select at most 50. It reads only
accepted, currently available custom-event facts, not payloads or installation
IDs. A key must already have been observed in this bounded selection. Unknown
keys, duplicate selections, identifying scope fields and lag below nine days
are rejected. If a key has not arrived yet or lies outside this convenience
list, use an explicit advanced definition rather than pretending it was observed.

The existing API exposes the same list in `custom_conversion_event_keys` from
`GET /v1/admin/apps/<app-id>/metric-schedules`. Post a selection to the same
schedule registration endpoint, using
[the synthetic selection](../examples/synthetic/custom-conversion-schedules.json):

```json
{
  "custom_conversion_event_keys": ["signup_complete", "tutorial_complete"],
  "lag_days": 9,
  "start_date": "2026-08-06"
}
```

Do not combine this convenience request with raw `metric_definitions`,
`evaluations` or an FX policy. The server expands it into the ordinary immutable
schedule definition, digest, checkpoints and correction pathway. Its required
FX-envelope identity is explicitly unused for counts/rates; it is not a live
USD quote or a money-conversion policy. There is no new table or scheduler.

For typed advanced setup, `keyedCustomConversionMetricDefinitions(eventKey)`
from `@openmasu/contracts/definitions` returns
`conversion_d7_<event_key>_count` and `conversion_d7_<event_key>_rate`. The names
are stable functions of the exact key, with the existing v0.4.14 meaning and
bundle. Different keys can own simultaneous schedules. Renaming a metric does
not change the outcome: the same key/calculation/profile/window/grouping/fraud
meaning cannot have a second active owner, even through an alias. Explicitly
disable or replace its existing schedule to hand off ownership. Old saved runs
and the legacy definitions below remain readable and unchanged.

Event keys have exact, case-sensitive meaning. Changing an SDK key creates a
different outcome, not a display-name change or an automatic synonym. Saved
comparison context retains the key; different keys must not be compared as the
same outcome just because both happen to have count 2 or rate 20%.

The existing SDK `custom_event` must carry an installation ID and an ordinary
`event_key`, for example the synthetic `tutorial_complete`. Do not infer an
installation from an unlinked backend event. No extra event payload is required.

## Definitions and arithmetic

`customConversionMetricDefinitions("tutorial_complete")` from
`@openmasu/contracts` returns two explicit metric definitions:

| Metric | Meaning |
| --- | --- |
| `cohort_custom_event_converters_d7` | Distinct eligible installations reaching the key, count |
| `cohort_custom_event_conversion_rate_d7` | Distinct converters / eligible installation cohort, ratio scale 6 |

Both bind `conversion_event_key`, selected-first-party-click acquisition and
independent bundle/version `metric-custom-conversion` / `0.4.14`. D7 is the
half-open cumulative interval `[install_at, install_at + 8 days)`, not activity
on the seventh day. Ten installations, with three emitting the outcome twice
each, produce count 3 and unscaled rate 300000 (30%). Repeated delivery and
repeated events do not increase the converter count. Integer half-even division
is used; no floating-point rounding is introduced.

The numerator and denominator use the same tenant/app, current privacy state,
campaign/network/country/cohort-date/status selection and gross/net fraud policy.
Only admitted unique events received by the fixed watermark qualify. Organic
and unattributed cohorts remain separate when selected by status. Exact end
boundary, pre-install events, another key and later receipt are excluded.
A nonempty cohort with no conversions is zero; an empty cohort is
`undefined/empty_cohort` for both metrics, never a manufactured zero rate.

## Use the existing workflow

Pass the two definitions explicitly using the checked-in synthetic example:

```bash
npm run metrics:run -- --date=2026-08-06 --definitions=examples/metrics/synthetic-custom-conversion.json --watermark=2026-08-15T00:00:00.000Z
```

Use the [existing definitions file format](import-mappings.md) and configure
the example's tenant/app to match your synthetic deployment. This command
calculates existing admitted records; it does not fabricate or import outcomes.
The date is an evaluation default,
not a substitute for the fixed received-at watermark. For daily execution use
the same definition objects in the existing [schedule controls](scheduled-metrics.md);
there is no new scheduler or service. They are not added to historical defaults.

Saved report rows use the existing API, dashboard and exact-unit formatting.
The complete definition, including the key, is retained in replay manifests and
reader-safe comparison context. Different keys are different meanings even if
names and values match. The rate's comparison meaning has no FX dependency.
Maturity for a whole cohort date uses its exclusive end plus eight days, because
installations can occur throughout that date; this does not prove completeness.

## Evidence and boundaries

[Fixture 61](../fixtures/v0.4/61-custom-conversion/input.json) and its
[independent derivation](../fixtures/v0.4/README.md#fixture-61-distinct-custom-event-conversions)
cover 10 installations, six events and three converters. Shared TS/Python/SQL
cases cover privacy, fraud, native acquisition, receipt and elapsed boundaries.
The same cases also exercise two independent keys: ten installs give signup
2/10 and tutorial 3/10; deleting their one shared converter gives signup 1/9
and tutorial 2/9. The schedule integration exercises two registrations, a late
tutorial correction to 4/10, unchanged signup 2/10, and key-bound JSON/CSV.
Definition/schema validation rejects a partial or mixed profile instead of
ignoring the key. Prior goldens and saved runs are not rewritten.

Per-key names and the convenience schedule are source-only additions. They do
not alter the v0.4.14 arithmetic or extend the event/metric wire schema. Contract
patch 0.4.23, URNs, wire/package 0.4.0 and all reviewed golden artifacts stay
unchanged; no new golden or migration entry is needed for this naming helper.

This is a synthetic implementation gate, not evidence of real event delivery,
SDK deployment or a provider's conversion definition. No arbitrary attributes,
reserved conversion-value lifecycle keys, cross-device identity or funnel
builder are supported by this profile.
