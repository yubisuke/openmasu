# OpenMasu

OpenMasu is an auditable, self-hostable mobile measurement platform. It records
measurement evidence, applies versioned attribution and metric rules, and makes
the resulting differences explainable.

The name comes from *masu*, a traditional Japanese measuring box.

OpenMasu is designed to run beside an existing Mobile Measurement Partner
(MMP). It is not presented as a drop-in replacement, and the repository does
not claim parity with any commercial provider.

## What OpenMasu does

OpenMasu provides one reproducible path from evidence to reports:

1. SDKs, authenticated app backends, redirectors, platform callbacks, and
   importers submit evidence.
2. PostgreSQL stores received evidence and append-only derived artifacts.
3. Versioned evaluators produce attribution, fraud, reconciliation, and metric
   results.
4. The API, CSV export, and server-rendered dashboard read the same persisted
   results.
5. Synthetic fixtures reproduce reviewed output byte for byte in TypeScript,
   Python, and PostgreSQL.

The current implementation includes Android, iOS, and Unity SDKs; first-party
measurement links; Android Install Referrer; selected Apple and Meta evidence;
manual and bounded provider cost inputs; advertising and verified-commerce
revenue inputs; cohort metrics; difference auditing; deterministic fraud
controls; direct deep links; Android deferred deep links; and an operator
dashboard. A provider-neutral server-to-server endpoint accepts selected
first-party backend events through app-scoped, rotatable HMAC keys. Optional
operator event webhooks deliver a closed subset of accepted first-party events
to an explicitly allowlisted, operator-owned HTTPS receiver. Optional operator
bulk exports write the same closed event object as deterministic gzip NDJSON to
allowlisted, operator-owned S3-compatible storage.

App-scoped durable metric schedules can calculate disjoint daily metric sets
with fixed UTC dates and watermarks. They reuse the same cohort engine as the
manual metric command and fail closed on partial or non-identical replay. See
[Scheduled metric runs](docs/scheduled-metrics.md).

## What OpenMasu does not claim

- It is not production-ready.
- It has not been proven equivalent to an existing MMP.
- Synthetic tests do not prove live provider connectivity, real-device
  delivery, store approval, campaign accuracy, or production capacity.
- AppLovin MAX support is revenue evidence, not user-level install attribution.
- Partner-only or non-public attribution paths are not treated as supported.
- iOS deferred deep linking, probabilistic attribution, fingerprinting,
  cross-device identity, and cross-advertiser device intelligence are not
  provided.

See [Product scope](docs/product-scope.md) for the supported boundary and
[Project status](docs/STATUS.md) for the difference between implemented,
synthetically verified, and operationally unverified work.

## Start here

The [documentation map](docs/README.md) is the canonical index for current
guides, subsystem designs, operator procedures, tagged records, and historical
material. For the shortest safe first run, go directly to the
[synthetic getting started guide](docs/getting-started.md).

`v0.2.0` is the current published source and SDK release. Its annotated tag and
[GitHub Release](https://github.com/yubisuke/openmasu/releases/tag/v0.2.0)
point to green `main` commit `68b8c48`. It retains the independent Contract
v0.4 wire and package identity, including the additive patch ledger through
v0.4.10 with 57 reviewed fixtures and 741 goldens. Later `main` commits are not
evidence for that release. [`docs/STATUS.md`](docs/STATUS.md) defines the
current source tree, and the [release index](docs/releases/README.md) separates
the exact published record from ongoing development and historical prereleases.

## Safe synthetic verification

Requirements:

- Node.js `22.18.0`
- npm `11.6.2`
- Docker with Compose only for the disposable runtime pilot
- Python `3.13.5` only for the independent Python evaluator

The Node.js and npm versions are exact because `.npmrc` enables
`engine-strict`. Use `.nvmrc` with nvm, fnm, or an equivalent version manager.

Install the Node.js dependencies required by the offline demo:

```bash
npm ci
```

Install the Python dependencies only when running the independent evaluator:

```bash
python -m pip install --require-hashes --requirement requirements-contract.txt
```

For the shortest offline view of the Shadow MMP value, run:

```bash
npm run --silent demo:shadow
```

It evaluates three reviewed synthetic fixtures and prints deterministic JSON
for `window_mismatch`, `provider_modeled_conversion`, and
`crowd_anonymity_suppressed`. The command validates those evaluator artifacts
against their existing goldens. It does not start PostgreSQL or claim that the
rows were stored or served by a runtime API; `stored_runtime_claim` remains
`not_run`.

Run the isolated end-to-end synthetic pilot from a clean worktree with no
`.env` file or `.openmasu` directory:

```bash
npm run pilot:synthetic -- --disposable
```

The pilot copies tracked source to a temporary directory, creates an isolated
Compose project with generated local secrets and loopback ports, disables live
provider integrations, seeds reviewed fixtures, verifies PostgreSQL parity,
runs API/dashboard/redirector/SDK smoke checks, and removes its temporary
resources on success or failure. It does not use real credentials, devices,
campaigns, or provider data.

For a persistent local development stack and operator commands, follow the
[getting started guide](docs/getting-started.md). Do not run volume-reset or
fixture-seed commands against a stack that contains data you need to keep.
Backend event producers should begin with the
[server-to-server event guide](docs/server-to-server-events.md). Operators who
need outbound callbacks should use the separate
[operator event webhook guide](docs/operator-event-webhooks.md).
Operators who need delayed files should use the separate
[operator bulk export guide](docs/operator-bulk-exports.md).
Operators who need daily cohort or calendar metrics should use the
[scheduled metric guide](docs/scheduled-metrics.md).

## Validation

The main contract gate is:

```bash
npm run validate
```

It checks 28 schemas, 8 registries, 57 reviewed synthetic fixtures, 741 golden
output artifacts, 57 scenario assertions, 27 acceptance criteria,
deterministic TypeScript, the independent Python evaluator, release identity,
documentation drift, fraud artifacts, and RFC 8785 canonicalization.

Additional runtime, database, Android, iOS, Unity, security, and packaging gates
are documented in [Development](docs/development.md) and run in GitHub Actions.

## Repository map

```text
apps/
  api/                  management, reporting, dashboard, and ingest routes
  redirector/           portable measurement-link service
  runtime/              bootstrap, migrations, database, and scheduler support
  worker/               import, attribution, fraud, metrics, and delivery jobs
packages/
  contracts/            schemas, generated types, and contract validation
  attribution-core/     pure deterministic evaluator
  redirector-core/      portable redirect behavior
  fraud-rules/          public deterministic fraud rules
sdk/
  android/              Kotlin SDK, samples, and provider modules
  ios/                  Swift Package, samples, and Apple adapters
  unity/                UPM package and Android/iOS bridges
schemas/                active Contract v0.4 schemas
registries/             active closed vocabularies
fixtures/v0.4/          reviewed synthetic inputs and immutable goldens
spec/                    normative contract specification
docs/                    current guides, operations, design, and history
```

## Privacy and public-repository boundary

This public repository must never contain real MMP exports, credentials,
advertising identifiers, campaign names, revenue, cost, user data, device data,
or values derived from them. Examples and fixtures are synthetic. See
[Contributing](CONTRIBUTING.md), [Privacy and security](docs/privacy-security.md),
and [Security policy](SECURITY.md).

OpenMasu does not implement device fingerprinting. Advertising identifiers are
handled only when explicitly configured, permitted by platform rules, and
covered by the required consent.

## Release and license

Source and SDK releases require the platform AARs and SDK SBOMs before the repository
packager can run. Follow the complete [release runbook](docs/operations/release.md)
rather than invoking the final packaging command in a clean checkout.

The configured v0.2.0 bundle path is
`build/sdk-release/openmasu-sdk-0.2.0`. It is release evidence only when
built from the exact commit named by the matching `v0.2.0` annotated tag,
after every full platform gate is green for that commit. An untagged bundle is
only a local candidate artifact. See the [release runbook](docs/operations/release.md).
The generated Unity UPM archive contains its OpenMasu Android dependency
artifacts and has standalone Gradle plus synthetic Unity 6 Android export
gates; Unity 2022.3 and physical-device acceptance remain separate operator
checks.

OpenMasu is licensed under the [Apache License 2.0](LICENSE). Attribution is
recorded in [NOTICE](NOTICE). A preliminary name clearance was completed on
2026-08-20; formal trademark clearance remains a prerequisite for trademark
registration.
