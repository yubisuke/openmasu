# Next Release Scope

This is a living inventory of source work after published `v0.2.0` at `68b8c48`,
not a release note, version assignment, published SDK artifact or evidence manifest.
Do not change the frozen tag or its records to include this later behavior.

## Source additions to include

- Reader-only measurement health separates app/key configuration, receipt,
  processing, rejection, logical evidence and calculated runs.
- Exact money, ratio and count display, SSR filters and selection-preserving CSV
  exports retain audited unscaled integers.
- Supported new ad-revenue ROAS runs save their original operands, FX, selected
  cost and window evidence atomically. Legacy or removed evidence stays unavailable.
- Supported SQL runs save calculation meaning; incompatible or unknown meaning
  produces no ordinary numeric delta. Declaration-only comparison is explicit.
- Bounded all-page dashboard downloads use a fixed read-only selection with
  acquisition receipts, scope bindings and privacy/retention refusal.
- One provider-neutral aggregate CSV mapping records explicit units/undefined
  handling, canonical keys, input/mapping digests and safe error codes offline.
- One newcomer guide and the existing demo connect receipt, units, evidence and
  comparison. Synthetic corrected-cost and incompatible-window examples are
  derived by the reference evaluator, not hand-written expected business values.

Contract wire/package identity remains `0.4.0`, with the additive patch ledger
through v0.4.10. These additions do not change its 57 reviewed fixtures or 741
goldens. The SDK remains configured as `0.2.0` until a separate release change.

## Not included merely by this inventory

Durable provider cost refresh and correction-driven historical recalculation
are subsequent implementation work. SDK asset publication, upgrade procedures,
deployment preflight, capacity visibility and the HTTP contract have separate
acceptance scopes. Reassess this inventory after those changes merge.

## Unverified boundaries

No real provider account, credentials, exports, physical devices, live campaign,
consumer store delivery, platform approval or production deployment is verified.
No equivalence with another MMP or end-to-end exactly-once provider behavior is
claimed. An elapsed window does not prove complete upstream arrival.

Synthetic tests prove only their recorded source revision and named behavior.
Use the existing [release runbook](../operations/release.md) to bind a future
version, matching full-platform CI, SDK/SBOM artifacts, checksums, annotated tag
and GitHub Release to one exact green commit. Distribution should distinguish
compiled Android modules from source-distributed iOS and Unity packages. An
untagged bundle is only a candidate; this document publishes nothing.
