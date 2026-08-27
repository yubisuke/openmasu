# Project Plan

## Objective

Develop OpenMasu as an auditable Shadow MMP and first-party measurement toolkit.
The project succeeds when a contributor can trace a reported value to received
evidence, reproduce it under fixed rules, and understand why it differs from
another measurement result.

Replacing an existing MMP is not the objective.

## Sources of truth

| Topic | Canonical source |
| --- | --- |
| Product boundary | [Product scope](product-scope.md) |
| Current evidence state | [Project status](STATUS.md) |
| Milestone order | [Roadmap](roadmap.md) |
| Contract behavior | [Contract specification](../spec/event-metric-contract-v0.4.md), schemas, and registries |
| Runtime design | [Architecture](architecture.md) and `docs/design/` |
| Security boundary | [Privacy and security](privacy-security.md) and [Threat model](threat-model.md) |
| Contributor workflow | [Development](development.md) |
| Private operational checks | [Validation checklists](validation/README.md) |

Historical issue drafts, reviews, and migration records explain how earlier
versions were reached. They do not override current sources of truth.

## Workstream order

1. **Correctness before breadth.** Fix deterministic, transactional, security,
   and cross-platform semantic defects before adding providers or event types.
2. **Integration before promotion.** Make the existing import-to-report path
   coherent and easy to reproduce before publishing another release candidate.
3. **Evidence before claims.** Add the narrowest gate that proves the intended
   behavior; keep unperformed operator evidence explicitly open.
4. **Release coherence before tagging.** Align version identities, release
   notes, SBOMs, SDK artifacts, documentation, and CI on the exact commit to be
   tagged.

## Current integration work

| Workstream | Deliverable | Required evidence |
| --- | --- | --- |
| Worker database safety | Complete: separate scheduler/job pools and short transaction phases | Scheduler and MAX inbox integration tests at a one-connection pool limit |
| SDK queue parity | Complete: one duplicate/conflict policy across Android and iOS | Shared semantic vectors plus each platform's native gate |
| Newcomer documentation | One current documentation map and safe synthetic first run | Link check, documentation drift check, threat-model coverage, full validation |
| Release alignment | Distinguish latest tag from development main and keep all SDK/package identities synchronized | Release-version check, bundle verification, tagged evidence manifest |
| CI efficiency | Complete: cancel superseded PR runs and gate expensive steps by changed scope | Classifier unit matrix plus GitHub pull-request proof with every required context present |

## Change acceptance

Every change must identify:

- the product or operational outcome;
- files and public interfaces affected;
- synthetic tests that passed;
- golden fixtures changed, if any, with their derivation;
- checks that were not run;
- remaining real-provider, device, platform, or production boundaries.

Contract changes follow [Schema versioning](schema-versioning.md). Security,
privacy, release, or public API changes require proportionate broad validation.
Documentation-only work still runs the documentation consistency and full
contract gates because status and validation counts are mechanically linked.

## Public and private work

The repository may contain only synthetic data and public configuration
examples. Credentials, provider exports, campaign values, device identifiers,
fraud watchlists, private thresholds, and operational evidence stay outside the
repository.

Private operator validation is optional and separately authorized. Repository
development must remain useful without it.
