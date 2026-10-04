# OpenMasu

An auditable, self-hostable mobile measurement platform: contract-first,
reproducible attribution and explicit difference explanations.

Masu is a traditional Japanese measuring box.

## Why OpenMasu exists

Mobile measurement results can disagree even when they describe the same app.
Different attribution evidence, cohort definitions, costs, conversion windows,
and privacy restrictions can all matter. A number alone does not explain them.

OpenMasu preserves the evidence and calculation meaning needed to reproduce a
result and explain a difference. Its starting point is a **Shadow MMP**: run
alongside an existing Mobile Measurement Partner, without claiming to replace
it or treating its judgment as first-party evidence.

## What you can do

| Workflow | Current source |
| --- | --- |
| Collect | Android, iOS and Unity SDKs; authenticated backend events; explicit file mappings |
| Attribute | Separate first-party, verified platform, imported-provider and Apple aggregate evidence |
| Calculate | Scoped acquisition KPIs, ROAS, LTV, retention and custom outcomes with saved definitions, cutoffs and exact money |
| Maintain | Daily schedules, bounded cost refresh and corrections, receipt diagnostics and confirmed ingest recovery |
| Explain | Reader-only dashboard, saved calculation operands, JSON/CSV reports and explicit aggregate comparison |
| Operate | PostgreSQL role isolation, privacy deletion/reapplication, backup/restore, signed webhooks and bulk exports |

These are bounded, synthetically verified capabilities, not universal provider
support. [Project status](docs/STATUS.md) lists their limits; the
[documentation index](docs/README.md) locates detailed guides.

## Source and release

`v0.3.0-rc.1` is the current published source and SDK release, marked as a
prerelease. Download its SDK assets from the
[GitHub Release](https://github.com/yubisuke/openmasu/releases/tag/v0.3.0-rc.1).
Later `main` commits are not evidence for that release.

Current source includes additions through contract patch `v0.4.24`; the wire
identity remains `0.4.0` with schema URNs ending in `:v0.4`. See
[current status](docs/STATUS.md) and [unreleased changes](docs/releases/next.md).
Use the matching tag and its documentation when evaluating a published release.

## Start with synthetic data

No provider account, real credential, device or production data is needed.

### Requirements

Node.js `22.18.0` and npm `11.6.2` must match **exactly**: `.npmrc` enables
`engine-strict`. Use nvm, fnm or another version manager with `.nvmrc`.
Python `3.13.5` is needed for the independent evaluator/full validation;
Docker with Compose is needed only for the runtime path.

### Offline walkthrough

```bash
npm ci
npm run --silent demo:shadow
```

This checks reviewed fixture results and shows difference reasons without a
database. To generate synthetic CSV inputs and equal, different, incomparable
and unknown HTML reports in a new output directory:

```bash
npm run --silent demo:shadow -- --comparison-dir=build/synthetic-comparison
```

The command refuses to overwrite an existing directory. This is reference
evaluator evidence, not proof of runtime persistence or provider agreement.

### Disposable runtime walkthrough

After `npm ci`, from a clean checkout without `.env` or `.openmasu`:

```bash
npm run pilot:synthetic -- --disposable
```

This isolates a temporary Compose project, seeds synthetic data with writers
stopped, verifies PostgreSQL parity and HTTP behavior, then removes its own
containers, volumes and secrets. It refuses remote Docker contexts.

For a persistent local dashboard, app registration, tracking-link allowlists,
safe seeding and import confirmation, follow
[Getting started](docs/getting-started.md). Never reseed a ledger you need to keep.

## Develop with KISS

Use the existing services and test suites. Run the affected check while editing,
then the applicable full gate once at handoff; do not rerun subsets already
covered by that gate. See [Development](docs/development.md) and
[CI scope and test cost](docs/ci-scope.md).

Install Python dependencies before full validation:

```bash
python -m pip install --require-hashes --requirement requirements-contract.txt
npm run validate
```

It checks 28 schemas, 8 registries, 71 reviewed synthetic fixtures, 923 golden
output artifacts, 71 scenario assertions, 27 acceptance criteria,
TypeScript/Python determinism and RFC 8785 conformance, plus type, documentation,
release-identity and public-data guardrails. It never regenerates goldens.
Runtime, database and native SDK evidence have separate CI owners.

[Roadmap](docs/roadmap.md) gives the next work; [Project plan](docs/project-plan.md)
defines its acceptance boundaries. Tests passing do not by themselves establish
live-provider, physical-device, store-approval or production readiness.

## Repository map

| Directory | Responsibility |
| --- | --- |
| `apps/` | API/dashboard, redirector, runtime support and worker |
| `packages/` | Contract validation/types, pure evaluator, redirect and fraud rules |
| `sdk/` | Android, iOS and Unity SDKs and samples |
| `schemas/`, `registries/`, `spec/` | Normative contract behavior |
| `fixtures/v0.4/` | Reviewed synthetic inputs and immutable goldens |
| `docs/` | Current guides, designs, operations and historical records |

## Privacy, limits and license

This public repository contains synthetic data only. Never commit real exports,
credentials, campaign values, revenue/cost, user/device data or values derived
from them. See [Contributing](CONTRIBUTING.md),
[Privacy and security](docs/privacy-security.md) and [Security policy](SECURITY.md).

OpenMasu does not implement device fingerprinting or probabilistic identity.
Advertising identifiers require explicit configuration, platform permission
and the required consent. Direct deep links are deterministic on both OSes;
deferred deep links are deterministic on Android only, not provided on iOS.
Apple aggregate reports are not device-level or unique-install counts.

The configured SDK bundle path is
`build/sdk-release/openmasu-sdk-0.3.0-rc.1`. An untagged bundle is only a local candidate artifact.
Publishing requires exact-tag platform/build evidence; follow the
[release runbook](docs/operations/release.md). Unity 2022.3 and physical-device
acceptance remain separate from the synthetic Unity 6 Android export gate.

Licensed under [Apache-2.0](LICENSE); attribution is in [NOTICE](NOTICE).
A preliminary name clearance was completed on 2026-08-20; formal trademark
clearance remains a prerequisite for any trademark registration.
