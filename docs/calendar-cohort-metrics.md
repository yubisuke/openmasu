# Calendar cohort metrics

Choose the meaning of D0/D1/D3/D7 before comparing results. An elapsed window
and a local calendar day are different, even when both are labeled D7.
Existing definitions keep their original windows; changing an app's display
time zone does not reinterpret a saved run.

## Explicit definition

Use `calendarAcquisitionMetricDefinitions(zone, basis, provider?)` from
`@openmasu/contracts/definitions`. Qualified zones are `UTC`, `Asia/Tokyo`,
and `America/New_York`. The default basis is `selected_first_party_click`;
`selected_verified_platform` stays source-namespaced, and
`selected_imported_provider` requires an explicit provider. These populations
reuse their existing evidence/subject/privacy rules and never blend together.

Each selection returns eleven definitions: advertising ROAS and advertising
LTV for D0/D1/D3/D7, D1/D7 retention and installation count. Names use
`calendar_utc_`, `calendar_jst_`, or `calendar_ny_`, with `platform_` or
`imported_` prepended for those bases. The independent definition/bundle version
is `0.4.21`; `calendar_cohort_policy=cumulative_revenue_on_day_activity` is
mandatory. Wire/package identity and schema URNs remain `0.4.0` / v0.4.

Declare `grouping.cohort_date` in the selected zone. The install's local date
must equal it. Revenue accumulates from the exact installation instant to
the **exclusive local midnight after day D**. Retention counts distinct
installations with an accepted `session_start` on local day D, not cumulative
activity and not `floor(elapsed hours / 24)`. Pre-install events never count.
FX still rounds each event half-even before addition and divides half-even.

For a synthetic install at `2026-08-06T23:59:00.000Z`, the cohort date is
August 6 in UTC/New York and August 7 in Tokyo. Calendar D7 closes respectively
at August 14 00:00Z, 04:00Z and August 14 15:00Z. The elapsed D7 profile instead
closes at August 14 23:59Z. Calendar-day length is not assumed to be 24 hours:
New York's tested 2026 spring/fall days are 23/25 hours.

## Cost and operations

Calendar ROAS selects same-grain acquisition-day cost only when its optional
`reporting_time_zone` is explicitly the definition's aggregation zone. Missing
or different zones are not converted, allocated or inferred from campaign names.
Missing cost remains `undefined/no_attributed_cost`; overlapping grain remains
undefined. Older cost rows and elapsed definitions retain their original behavior.
The [synthetic mapping](../examples/mappings/synthetic-calendar-cost.json)
shows an explicit reporting-zone column. Provider adapters do not invent it.

Use the ordinary `metrics:run` CLI with these definitions, explicit evaluations
and a chosen receipt watermark. [The schedule example](../examples/synthetic/metric-calendar-schedule.json)
uses one New York profile. A calendar schedule must contain only calendar
definitions in one zone, use `cohort_date`, and declare its campaign selection;
automatic campaign discovery is deliberately not supported here. The worker
derives both its target date and fixed receipt watermark at that zone's local
midnight. Its captured `cohort_time_zone` is derived metadata, not an input field.
Choose a lag sufficient for the metric window; a closed occurrence window does
not assert that delayed data is complete. Manual backfills retain an explicit
watermark. Existing bounded late/cost/attribution corrections create replacement
runs, not edits to saved history, and use the saved local window/cost zone.

JSON/CSV and saved calculation explanations retain the definition, local date,
zone, cumulative/on-day policy, receipt watermark and exact window end. Calendar
and elapsed D7, or two zones, are not automatically comparable. The older
external-v1 ROAS declaration cannot express this policy and stays unsupported
as an equivalent calendar definition.

## Qualification and limits

Fixture 68 independently derives 101 runs, including all 99 calendar
zone/basis definitions and two historical elapsed controls. Shared synthetic
cases cover exclusive ends, pre-install revenue, late receipt, cost-zone
absence/mismatch, permutations, spring/fall transitions and month rollover.
Contract TypeScript/Python and the existing PostgreSQL metric gate compare
canonical bytes; no second calculator, service or runtime dependency is added.

Node uses its pinned ICU time-zone data. The independent Python oracle loads
hash-pinned first-party `tzdata==2025.2` (IANA 2025b) explicitly, rather than
silently depending on the host's time-zone database; this is a validation-only
dependency, including on Windows. PostgreSQL resolves the same qualified zone
names. This change does not freeze PostgreSQL's time-zone database into every
metric snapshot. Requalify boundary/parity cases after a Node/PostgreSQL/tzdata
upgrade; arbitrary IANA zones, all historical law changes and live provider cost
zone correctness are not claimed as verified.

Primary references, checked 2026-10-04:

- [Node.js 22.18 internationalization](https://nodejs.org/download/release/v22.18.0/docs/api/intl.html): ICU/Intl and official full-ICU binaries.
- [Python 3.13 ZoneInfo](https://docs.python.org/3.13/library/zoneinfo.html): IANA support, DST folds and data-source selection.
- [First-party tzdata 2025.2](https://pypi.org/project/tzdata/2025.2/): pinned cross-platform validation data.

See [the derivation](../fixtures/v0.4/68-calendar-acquisition-cohorts/README.md)
and [migration inventory](contract-v0.4-migration.md#calendar-acquisition-cohorts-0421).
