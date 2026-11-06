# Exact-key daily activity: independent derivation

All input is synthetic. This extends fixture 72's reviewed admission templates,
not its calculator. Five additional logical custom events use key
`synthetic_repeat`: A at UTC day 20 start, midday and its last millisecond; B at
midday with receipt on day 22; A exactly at day 21 start. An identical retry of
the first event is a delivery only. The three existing `synthetic_activity`
events are the separate-key control. No installation/acquisition event is added.

## Counts

The UTC occurrence window is half-open; receipt cutoff is inclusive.
The reviewed columns are repeat events, repeat installations, other-key events
and other-key installations, in that order:

| Evaluation | Four expected values | Derivation |
| --- | --- | --- |
| initial | 3, 1, 3, 3 | A contributes three distinct repeat events and one installation; B's late receipt is excluded. Original custom events belong to A, B and custom-only D. |
| late | 4, 2, 3, 3 | B's later receipt adds one repeat event and one installation. |
| private | 3, 1, 2, 2 | Completed B deletion removes B's repeat, original custom and original session records; A's three repeat events remain. |
| next | 1, 1, 0, 0 | Exact midnight belongs to the next day, not day 20. |
| empty | 0, 0, 0, 0 | A computed empty day is present zero; an unrequested day produces no run. |

Twenty runs are four definitions times five evaluations. A repeated logical
delivery never increments an event or installation count. Case variants of a
key are rejected by the closed definition schema rather than normalized.

## Every expected family

- Raw records and logical events: fixture 72's eight canonical records plus
  five new canonical records minus B's three redacted records = ten each.
  New raw payload digests are SHA-256 of JCS payloads, independently calculated.
- Deliveries: original nine plus five accepted events and one retry = fifteen.
  There are two duplicate deliveries overall; both retain the original canonical
  record reference and do not create a second logical event.
- Privacy: one completed request extends the existing B request to include the
  late repeat record. Three tombstones and three privacy corrections reference
  its three scoped records. Provenance digests use the same normative sorted
  request-ID list and scoped identity tuple as fixture 72.
- Definitions: three unchanged defaults plus four closed keyed definitions =
  seven. Definition and bundle version is `0.4.32`; bundle hash is
  `b6de51a6d28ebff0662ff6b0049d393a9b85df8f894634bcaba1e5d23731d534`.
- Runs: the twenty scalars above, with integer count units and no currency or
  monetary scale. Date grouping hashes SHA-256(JCS(dimensions)). Snapshot hashes
  use visible canonical rows sorted by `(received_at, record_id)` and tuples
  `[received_at, record_id, lifecycle_status, policy_version]`, including
  non-contributing visible keys. Evidence references use sorted scoped record
  IDs. Deletion changes lifecycle/provenance, not original receipt chronology.
- Attributions, costs, fraud decisions, rejections and reconciliation are empty:
  there are no qualifying inputs for those families.

Expected artifacts were constructed from those counts, normative hash formulas
and immutable admission templates, without importing either evaluator or SQL
calculator. Candidate TypeScript and independent Python outputs matched all
thirteen constructed families. Their combined JCS SHA-256 is
`f91f2baaab65c3ae8ea0c69af5b74af7b3853275c007cbfffa4f4acc45f61da6`.
No previous fixture input or expected artifact changes. Runtime tests separately
exercise SQL parity, current-privacy schedules, exact-key late replay, automatic
receipts, saved comparisons, CSV and deletion replay.
