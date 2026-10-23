# Independent daily-activity derivation

All identifiers and events are synthetic. There is deliberately no install,
click, attribution, cost or revenue record. Activity is not an acquisition join.

## Population and arithmetic

On 2026-08-20 UTC, installation A has two session starts and one custom event;
B has one session start and one custom event; C has only one custom event.
A's first start occurs exactly at midnight; B's start occurs at 23:59:59.999
and is received at the inclusive initial cutoff, 2026-08-21T00:00:00.000Z.
A's additional start at exactly that next midnight belongs to August 21.
A's retry uses the original event ID and identical payload, so it is another
delivery, not another logical event. D's August 20 start arrives exactly at the
later cutoff, 2026-08-22T00:00:00.000Z. A completed synthetic privacy request
redacts both of B's records.

| Evaluation | Date | Privacy | Session starts | Custom events | Active installations |
| --- | --- | --- | ---: | ---: | ---: |
| initial | Aug 20 | historical before; first cutoff | 3 | 3 | 3 (A, B, C) |
| late | Aug 20 | historical before; later cutoff | 4 | 3 | 4 (A, B, C, D) |
| private | Aug 20 | after; later cutoff | 3 | 2 | 3 (A, C, D) |
| next | Aug 21 | after; later cutoff | 1 | 0 | 1 (A) |
| empty | Aug 19 | after; later cutoff | 0 | 0 | 0 |

C proves that active installations use the union of session/custom events.
A appears on two dates: summing daily active values would not be a period-unique
count. These are installations, not unique people. The historical before runs
are reference examples, not authority to disclose deleted evidence in reports.

## Every expected family

- Raw and logical records: eight canonical records minus B's two redactions =
  six. Preserve the declared envelope, hash each payload with SHA-256/JCS,
  use `protected:<record_id>` and consent-not-required metadata. Sort by the
  contract's explicit keys. The retry emits neither a raw nor a logical row.
- Deliveries: all nine attempts are accepted. Eight are unique. The retry has
  `duplicate_resolution=duplicate_delivery` and canonical record
  `session-a-first-72`. All are protected, on-time and not clock-skewed; delayed
  receipt alone does not invent the optional late marker.
- Corrections and tombstones: two redactions, one per affected B record. Each
  correction key is `correction:<privacy_request_id>:<record_id>`. A tombstone's
  provenance digest hashes `[tenant, app, request_id, record_id, completed_at]`.
  The privacy-request family preserves the one supplied completed request.
- Metric definitions: the three new explicit definitions plus the three
  unchanged default definitions reused from fixture 01's immutable golden.
  New bundle identity is `metric-calendar-activity / 0.4.25`, with JCS digest
  `05a850574304074f7ab93cd2ab0f8781a957b31cb7c48271992d66ba5b53178b`.
- Metric runs: the table supplies all 15 values, not evaluator output. For each
  evaluation, include canonical receipts at or below its cutoff and sort by
  `(received_at, record_id)`. Hash `[received_at, record_id, lifecycle_status,
  policy_digest]` rows for `input_snapshot_id`; use the final row for
  `input_ledger_position`. `before` has available lifecycle; `after` records
  B's redaction and `redaction_affected`. Evidence references retain every
  snapshot record with its scoped lifecycle, sorted by reference. They are not
  just the contributing events for a particular date. Hash exactly
  `{metric_date}` for the dimension digest. Count values have no money/FX
  fields; the existing explicit rounding policy is retained. No supersession
  relationship is invented between these independent saved examples.
- Attributions, cost records, fraud decisions, rejections and reconciliation:
  empty. No input authorizes any of them; a duplicate delivery is not a rejection.

The candidate input was evaluated independently in TypeScript and Python before
promotion. All 13 manually constructed expected arrays matched both outputs.
Neither evaluator's output was copied into a golden. Existing 71 inputs and
923 golden files remain unchanged. Golden promotion is committed separately
from schema/calculation changes. Runtime tests additionally compare the actual
ingestion/SQL path, privacy replay, schedules and saved CSV.
