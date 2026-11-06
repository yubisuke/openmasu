# Purpose-scoped consent: independent derivation

All values are synthetic. The accepted-control context is trusted input, not
an inference from unvalidated event payloads. The five control payloads exercise
the omitted/global selector and all three explicit purpose selectors.

## Admission matrix

All record IDs have the prefix `consent81-`. Receipt times are
`2026-11-01T00:00:SS.000Z`, where SS is the authoritative sequence.

| Record | Sequence | Declared revision | Resolved revision | Independent result |
| --- | --- | --- | --- | --- |
| control-1 | 1 | payload: 1 | not evaluated | global grant; control accepted |
| before | 2 | 1 | 1 | analytics granted at this receipt; accepted |
| control-2 | 3 | payload: 2 | not evaluated | analytics withdrawn; control accepted |
| control-3 | 4 | payload: 3 | not evaluated | revenue not required; control accepted |
| blocked | 5 | 1 | 2 | analytics withdrawal; discarded |
| revenue | 5 | 3 | 3 | separate revenue declaration; accepted |
| control-4 | 6 | payload: 4 | not evaluated | analytics regrant; control accepted |
| stale | 7 | 1 | 4 | pre-withdrawal queue revision does not match; discarded |
| fresh | 8 | 4 | 4 | acknowledged new analytics revision; accepted |
| control-5 | 9 | payload: 5 | not evaluated | explicit attribution grant; control accepted |

The two analytics grants produce `consent_valid_for_revision`. The stale event
produces `consent_revision_unconfirmed` on its delivery and rejection; the
blocked event retains `consent_withdrawn` and recognition time 00:00:03.
Control records use `fraud_prevention` with `not-applicable` policy and
`consent_not_required`. The revenue record also has `consent_not_required`,
but carries the measurement policy and declared/resolved revision 3.

## All thirteen expected families

- `expected_raw_records.json`: eight accepted rows (five controls, before,
  fresh, revenue). Version, scope, producer and timestamps copy the declared
  input. Each available payload reference is `protected:<record_id>`.
- `expected_logical_events.json`: those same eight unique events, identified
  by `logical:tenant-a:app-a:sdk-android:event:<record_id>`; active/on-time.
- `expected_deliveries.json`: all ten unique attempts; canonical record ID is
  their own ID, no clock skew, on-time. Eight protected/accepted, two
  discarded/rejected. Revision metadata follows the table, not a device clock.
- `expected_rejections.json`: blocked and stale only; non-identifying metadata,
  no payload/installation/session fields.
- `expected_metric_definitions.json`: the three unchanged built-in D0
  ad-revenue definitions (elapsed UTC, calendar Asia/Tokyo, calendar UTC).
  The existing metric-default 0.3.0 definition hash remains
  `f765891ef3ac0337da9811cfb00f3883e3eece5a0ef3ec4ac23a6b2d0a24e443`.
- The eight other files are empty: `expected_corrections.json`,
  `expected_privacy_requests.json`, `expected_privacy_tombstones.json`,
  `expected_attributions.json`, `expected_cost_records.json`,
  `expected_metric_runs.json`, `expected_fraud_decisions.json`,
  `expected_reconciliation.json`. There are no installs, clicks, evaluations,
  costs, corrections, deletion requests or reconciliation inputs.

Each payload contains only ASCII keys/strings, small integers and no floats;
sorted-key compact JSON therefore equals its RFC 8785 bytes. Python standard
library `json.dumps(payload, sort_keys=True, separators=(",", ":"))` plus
`hashlib.sha256` independently gives these retained hashes:

| Record suffix | SHA-256 |
| --- | --- |
| before | 2f95de2dd3b0f40b0b4d14a1664448391d404301f320ceb85cbd19ac464b9c33 |
| control-1 | deb598efbe0b02b42395d3352dd94f2c51e98c86a3bf7392ea8c4f444a35be27 |
| control-2 | 551b42dfc1818c75a5b15cd0a2d510e339c13cbdc1035b80cd7da4c3885462c9 |
| control-3 | ffdcc59a59023850d550865211eb43cb0289989c54641160f8b43f5d3372f31a |
| control-4 | 918a462cf10d1a8a9cd3f37d3343367a29cfdf89d8c2b66e076cd4e99e2c6ab9 |
| control-5 | 0c96d1ee84184dc6d4ea0c0cfce030e95c469e86db6e6970a8e11d0a8dd18e0e |
| fresh | 12ffb869fbb9466b3043a8ef1f433b75f12b0bdb9ff0ecc2a54dbdb799c4c017 |
| revenue | 43c7ef2a0f76ed0667f7b121af55b80f0e5cc16537a9efbf5b965617b8d5b2a5 |

Arrays are sorted by the existing family identity tuples. No evaluator output
was saved as golden authority. The candidate was checked in both languages
before these expected files were authored. Replay mutations exercise reversed
input, stale controls, same-revision conflict, unknown state, future/missing
revision, legacy withdrawals, explicit server fences and invalid event time.
Device queue persistence and runtime authentication require their separate
integration tests; this fixture does not claim those are implemented.
