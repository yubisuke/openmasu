# Custom-event cohort conversion

Use this profile to answer: of the installations acquired in a cohort, how many
reached one explicitly selected outcome? It measures installations, not people,
devices across reinstalls, event frequency or a multi-step funnel.

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
Definition/schema validation rejects a partial or mixed profile instead of
ignoring the key. Prior goldens and saved runs are not rewritten.

This is a synthetic implementation gate, not evidence of real event delivery,
SDK deployment or a provider's conversion definition. No arbitrary attributes,
reserved conversion-value lifecycle keys, cross-device identity or funnel
builder are supported by this profile.
