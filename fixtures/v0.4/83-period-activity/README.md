# Independent period-activity derivation

All values are synthetic. This extends fixture 72's unchanged nine attempts,
including one redelivery, delayed D receipt and completed deletion of B's two
records. Add 29 starts for A on August 21 through September 18: A is active
on every day of the 30-day period, but contributes exactly one installation.
The extra August 21 start is a different logical event, not a new installation.

Three additional installations establish half-open boundaries:

- G occurs at August 19 23:59:59.999, immediately before the August 20 start.
- E occurs exactly at August 27 00:00, the exclusive seven-day end.
- F occurs exactly at September 19 00:00, the exclusive thirty-day end.

The new receipts are occurrence plus one second. D retains its August 22
receipt, and B's August 21 receipt exactly matches the initial inclusive cutoff.
The later cutoff is September 20 00:00 UTC. These are recorded installations,
not people, calendar-month audiences or proof of complete device delivery.

| Evaluation | Inclusive start | Privacy | 7-day unique set | 30-day unique set |
| --- | --- | --- | --- | --- |
| initial; Aug 21 cutoff | Aug 20 | historical before | A,B,C = 3 | A,B,C = 3 |
| late; Sep 20 cutoff | Aug 20 | historical before | A,B,C,D = 4 | A,B,C,D,E = 5 |
| private; Sep 20 cutoff | Aug 20 | after | A,C,D = 3 | A,C,D,E = 4 |
| next; Sep 20 cutoff | Aug 27 | after | A,E = 2 | A,E,F = 3 |
| empty; Sep 20 cutoff | Jun 1 | after | empty = 0 | empty = 0 |

## All thirteen expected families

There are 41 deliveries, 40 canonical events and two redactions, leaving 38
raw and 38 logical records. For each added session, copy fixture 72's reviewed
session envelope shape, substitute its explicit ID and timestamps, hash only
its synthetic payload with SHA-256/JCS, and construct `protected:<record_id>`
and `logical:tenant-a:app-a:sdk-android:<event_id>`. All added deliveries are
unique, accepted, on-time and protected. The original retry remains a second
delivery, not another raw/logical row. No implicit late flag is invented.

The original corrections, privacy request, tombstones and five empty families
(attributions, costs, fraud, rejections, reconciliation) are unchanged copies
of fixture 72's reviewed artifacts. Metric definitions are fixture 01's three
defaults plus the two independently declared 0.4.36 period definitions. The
bundle SHA-256/JCS is
`2d9c3050280e232c1a3cf92b1c1373abb331caaa2e99cd4c76aa0cb3573418b6`.

The ten run values come from the table above, not an evaluator. For each
evaluation, exclude the retry and receipts above its inclusive watermark;
sort canonical records by `(received_at, record_id)`. The snapshot hashes
`[received_at, record_id, lifecycle_status, policy_digest]` tuples. Historical
before examples use available lifecycle; current examples mark both B records
redacted. The last tuple supplies the ledger position. All snapshot records
remain in sorted scoped evidence references, not only contributing activity.
Hash exactly `{metric_date}` for grouping. Runs retain the reviewed count-run
shape, half-even metadata, explicit `partial` freshness and no invented
supersession. Historical before examples never authorize publishing deleted data.

All thirteen independently constructed arrays matched both TypeScript and
Python before promotion. Neither evaluator output was copied into a golden.
The existing 82 inputs and 1066 expected artifacts are unchanged. The golden
commit is separate from the definition/calculation commit. Runtime tests also
exercise SQL JCS parity, late-window selection, immutable replacement, real
privacy-worker replay, schedules and API/dashboard CSV identity.
