# Explicit recorded-inactivity engagement policy

This synthetic case declares a three-day outcome window and seven recorded
SDK-activity-free days, independently of the unchanged historical 24h profile.
No provider account, device or human inactivity is asserted.

## Independent derivation

The nine event shapes and their admission/attribution templates come from
reviewed fixture 64. The installation with a new install prefix uses the valid
`installation:engagement-75-x` namespace; its payload hashes are independently
recalculated. Four records reuse fixture 73's admission shapes:
one SDK install on August 1, two verified settled purchases (USD 8 and USD 5),
and one USD 3 partial refund of the first purchase. IDs, payload hashes and
timestamps are recalculated from these declared synthetic inputs, not from an
evaluator. All 13 records are accepted and available; there is one correction,
four attributions, no cost, rejection, fraud, deletion or reconciliation row.

- Campaign a opens August 21 at 10:00 UTC. Its SDK install predates the seven-day
  lookback, with no earlier recorded activity inside that interval: eligible.
  The 10:30 ad contributes 2,000,000 USD micros and the tutorial contributes one
  installation. The 11:00 verified purchase contributes 8,000,000; its 14:00
  refund contributes -3,000,000 to the original purchase's open: net 5,000,000.
- Campaign b opens at 12:00 on the same installation. The earlier open and
  tutorial prove recorded activity: its three runs are `undefined/empty_cohort`.
  Its later purchase/ad cannot transfer credit to campaign a.
- Campaign c has an open but no install prefix proving the lookback: all three
  runs are `undefined/insufficient_activity_history`, never numeric zero.
- The empty campaign has no eligible population: three `empty_cohort` runs.

The six definitions are the unchanged three reference definitions plus the
three explicit 0.4.28 declarations. Twelve runs are ordered by run ID.
Present money retains USD/scale 6 and the reviewed fixture 64 FX snapshot
`d99ad4f7b6dccd97b8bdf3430dcd0cc068a6262645f61c32999f8523d362f5b2`.
Undefined runs omit value, currency, scale and FX fields. Every run has the
same thirteen record-ID-ordered, scoped protected evidence references.

Snapshot input rows are receipt-ordered `[received_at,record_id,"available",policy]`.
Their digest, the three unchanged engagement-attribution tuples/digests, and
the independently declared definition digest form the new profile's snapshot.
The ad/count/purchase-net snapshot hashes are respectively:

- `f2912d00409267b2724370de9f1e6d51e67b63970aa736979c48a3b35a032414`
- `f438b0ab8df6ab1b648875e43d15eea43cbaadac0260e1c09a00322a4d9cc00c`
- `98d2e6c7a9eb1d51233fef25cd044de89df627df0536c55a61c430182e73011c`

The ledger position is `2026-08-22T12:00:01.000Z|revenue64-boundary`.
The cutoff/computation time is August 25 at midnight. No database sequence or
current clock enters the hashes. The registered bundle JCS SHA-256 is
`4f0f69a1c097d502f40c8c22421849c34581be1626052b31cf4a15a5c13bdab5`.
The independent thirteen-family construction matched both evaluators before
promotion. The previous 74 inputs and 962 golden files remain unchanged.
The combined family-keyed JCS SHA-256 is
`806323e24d210e370aa33aee3cddd4bae518d57a065a4a544e5ac65d2939f7ef`.
