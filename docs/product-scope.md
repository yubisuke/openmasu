# Product Scope

## Product definition

OpenMasu is an auditable, self-hostable Shadow MMP. It runs alongside an
existing measurement provider, records first-party and authorized reporting
evidence, recalculates versioned attribution and metrics, and explains neutral
differences with traceable evidence.

It is intended for teams that need to answer questions such as:

- Which received records contributed to this result?
- Which timestamp, attribution window, join key, cost revision, currency rule,
  or exclusion changed the total?
- Can a historical result be reproduced with the same inputs and rule bundle?
- Does a provider export fit the public contract before it is imported?

## Supported workflow

1. **Collect or import evidence.** Use first-party SDKs and links, supported
   platform callbacks, or an explicitly authorized export.
2. **Normalize it.** Convert the source into closed Contract v0.4 events and
   evidence artifacts.
3. **Preserve provenance.** Store received evidence, delivery state, rules,
   timestamps, and protected references separately.
4. **Evaluate deterministically.** Produce versioned attribution, fraud,
   reconciliation, and metric artifacts.
5. **Compare like with like.** Freeze cohort, time zone, watermark, FX, metric
   definition, and rule bundle before comparing results.
6. **Explain differences.** Report candidates, exclusions, windows, joins,
   freshness, and closed neutral reason codes.

## Supported evidence families

- First-party click, install, session, custom event, purchase, refund, and ad
  revenue evidence from the OpenMasu SDK and redirector.
- Android Install Referrer and supported Meta Install Referrer evidence.
- Apple Ads installation evidence and privacy-preserving SKAdNetwork or
  AdAttributionKit aggregate postbacks.
- Manual cost plus bounded authenticated provider cost adapters.
- AppLovin MAX impression-level or aggregate advertising revenue.
- Authenticated synthetic lifecycle/read-back paths for Google Play and the App
  Store.
- Provider-reported imported attribution preserved as a distinct evidence and
  method class.

Support means the repository has a typed path and synthetic evidence. It does
not mean every account, report version, region, permission tier, or live API has
been verified.

## Measurement invariants

- Raw evidence, normalized facts, decisions, and aggregates remain distinct.
- Deterministic installation-level attribution and aggregate
  privacy-preserving attribution remain separate series.
- Imported provider judgment never becomes first-party evidence.
- Organic, non-organic, and unattributed results remain distinct.
- Undefined metrics remain undefined with a reason; they do not become zero.
- Money uses integer unscaled values and explicit currency and scale.
- Historical output binds the input snapshot, watermark, rule bundle, and
  metric definition needed to reproduce it.
- Corrections and supersession append new artifacts instead of rewriting
  history.
- Valid privacy deletion removes or redacts identifiable payloads even when the
  evidence ledger is otherwise append-only.

## Explicit non-goals

- Replacing an existing MMP as a blanket product objective.
- Device fingerprinting, probabilistic identity, cross-device graphs, or
  cross-advertiser device intelligence.
- User-level attribution that requires a partner-only MMP relationship or
  non-public provider evidence.
- Combining aggregate platform or mediation reports with installation-level
  cohort facts as though they represent the same subjects.
- iOS deferred deep linking.
- Collecting advertising identifiers by default.
- Shipping real fraud thresholds, credentials, watchlists, or customer data in
  the public repository.
- Claiming production readiness from synthetic CI.

## Public and private boundary

The public repository contains contracts, schemas, deterministic algorithms,
synthetic fixtures, adapters, deployment templates, and validation tools. It
must not contain real exports, credentials, identifiers, campaign names,
costs, revenue, provider responses, or values derived from them.

A private operator may validate real data outside this repository. Such a run
must preserve the project definitions and record its own authorization,
environment, source coverage, and residuals. It is not a prerequisite for
repository-only development.

## Acceptance boundary

A capability can be described as implemented only when its code and public
interface exist. It can be described as synthetically verified only when its
checked-in evidence passes. Real-provider, real-device, platform-approval,
operator-acceptance, and production-deployment states require separate records.

See [Project status](STATUS.md) for the current evidence level and
[Validation checklists](validation/README.md) for private operational gates.
