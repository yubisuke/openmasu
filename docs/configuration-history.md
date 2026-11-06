# Configuration history

Open an app in the dashboard and choose **Review configuration history**. This
read-only timeline uses the existing append-only audit log; it does not activate
settings, call providers, recalculate results, or maintain another settings store.

## Covered changes

| Configuration | Safe recorded fields and revision identity |
| --- | --- |
| Cost schedule | Schedule ID, active/disabled state, provider, currency, lag/lookback days and definition digest |
| Metric schedule | Old/new schedule IDs, state, lag/start date, definition/evaluation counts and definition digest |
| Import mapping | Mapping ID/revision, mapping kind, approved-header count and definition digest; registration does not activate an import |
| Webhook content | Destination/policy revision, policy mode, money-sharing flag, custom-event/renaming counts and definition digest |
| Google conversion destination | Destination/revision, enabled state, audience, operator-reviewed readiness and definition digest |
| First-party attribution window | Activation revision, lookback days and definition digest; live fraud policy is excluded |

The timeline shows operation time, app/target scope and the administrator key
identity. A key is not an individual-person identity. Private account identifiers,
endpoint URLs, secrets, mapping bodies/headers, custom event labels and live fraud
definitions are excluded. A digest change proves a different registered definition,
not which undisclosed field changed or whether a saved metric was affected.

Changes are recorded in the same transaction as successful setting writes. A
metric replacement has one old-to-new receipt; its supporting registration is not
shown as a second change. A schedule disable keeps the definition revision and
records its state transition. Failed mutations and idempotent retries do not create
successful receipts. If an operation already records a failure, the timeline labels
it failed; this is not a complete security log of every rejected HTTP request.
Identical safe projections with a new revision are labeled revision-only, not a
field change. No record is backfilled or inferred for older operations: an existing
audit without these details explicitly says they were not recorded. A missing
registered attribution revision means the built-in window still applies, not that
attribution previously had no policy.

## Read surface

- GET `/v1/admin/apps/:app/configuration-history`: bearer key with `read`
  capability. Returns `{data, next_cursor}`.
- GET `/dashboard/apps/:app/configuration-history`: dashboard session with the
  same capability and app restriction. It never accepts a bearer key.
- `limit`: integer 1–100, default 50. `after`: opaque keyset cursor returned by
  the prior page. Unknown, repeated or invalid parameters return 400.
- Order is descending operation time, then audit ID. Newer inserts do not shift
  an already opened older page. This is a live keyset, not a frozen export: a
  concurrently committed backdated operation can still appear in later pages.
- The cursor never grants tenant/app access. Unknown or inaccessible apps share
  the existing 404 response; the reader pool and RLS remain authoritative.
- `change_state` is `fields_changed`, `revision_only`, `details_not_recorded` or
  `failed`. A known change contains `before_revision`, `after_revision`, `before`
  and `after`. A null before revision means no registered predecessor. Unknown
  historic details and failed operations have `change: null`.

The limited [report OpenAPI description](api/README.md) does not cover these
administration routes. GET never appends an audit record or performs a mutation.
Migration `102_configuration_history.sql` adds a nullable safe receipt and an
app-scoped keyset index to the existing audit table. Existing rows remain unchanged.

## Evidence and limits

The existing Runtime integration suite owns actual configuration writes,
old/new revision receipts, no-op/failure behavior, reader permissions, app/tenant
isolation, stable keysets and zero-JS rendering. Pure tests cover closed fields,
query bounds and escaping. There is no additional CI pipeline or dependency.
Contract schemas, evaluators and golden fixtures are unchanged. This source
feature is not included in previously published releases; live operational use
and attribution of shared keys to individual people remain unverified.
