# Measurement comparison priorities

OpenMasu compares measurement results without assuming equal metric names mean
equal definitions. This vendor-neutral document is not a ranking or endorsement.

| Area | Required distinctions |
| --- | --- |
| Cohorts | Date range, time zone, maturity, cumulative versus on-day |
| Attribution | Acquisition, re-engagement, organic, unattributed |
| Cost | Source, reporting grain, cutoff, historical revisions |
| Revenue | Exact units, currency, undefined values, missing rows |
| Reproducibility | Saved inputs and explicit definitions |

## Implementation sequence

1. Compare aggregate snapshots with explicit conditions and exact arithmetic.
   Incompatible definitions must not produce a numerical comparison. A delta
   alone does not establish its cause.
2. Connect comparisons to saved metric runs and the reporting UI. Pagination
   boundaries are not reproducible source cutoffs.
3. Add durable cost refresh and historical corrections using existing adapters.
   Incomplete reads must not become complete cost snapshots.

These steps require only synthetic inputs, not live providers or devices.
External code must not introduce fingerprinting or incompatible licensing.
