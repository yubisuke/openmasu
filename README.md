# OpenMasu

OpenMasu is an early-stage project for a self-hostable, open-source Mobile Measurement Partner whose measurement evidence can be audited and reproduced.

The name comes from *masu* — a traditional Japanese measuring box.

## Why this project exists

Independent measurement systems can produce totals that need transparent evidence to reconcile: raw events, attribution decisions, metric definitions, attribution logic, and pricing or cost assumptions. OpenMasu starts in complementary shadow mode alongside an existing MMP, so neutral measurement differences can be explained before any primary migration.

The project focuses on auditable, open event and metric contracts that independent implementations can reproduce from synthetic fixtures. Deployment-specific data, credentials, and live fraud defenses remain private. It is designed to make measurement more transparent without enabling device fingerprinting or cross-app tracking.

This is an early runtime-stage project, not a production-ready MMP.

## License

This project is licensed under the [Apache License 2.0](LICENSE); attribution is recorded in [NOTICE](NOTICE). A preliminary name clearance was completed on 2026-08-20; formal trademark clearance remains a prerequisite for any trademark registration. Security reporting follows [SECURITY.md](SECURITY.md).

## Current status

This project contains the v0.4.0 contract and the synthetic code milestones from M1 through M5: the Shadow ledger and import foundation, cohort metrics and difference audit, Android/Unity and Apple measurement paths, the server-rendered operator dashboard, minimum RBAC, authenticated operational metrics, privacy-safe restore support, rule-bundle history, and release evidence. Real provider connectivity, real-device and campaign validation, Unity Xcode export, App Store review, a production deployment, real backup operations, real production load, real integrity-service configuration, real-cardinality dashboard usability, and exact 4-vCPU/8-GB capacity validation have not been demonstrated. Immutable baselines are available at the `contract-v0.1`, `contract-v0.2.1`, and `contract-v0.3.6` Git tags. See [the current status](docs/STATUS.md) for the milestone-by-milestone boundary.

The first product entry point is a Shadow MMP that runs alongside an existing provider. It normalizes first-party events, existing MMP exports, media cost, and revenue into a common contract, then explains neutral differences through candidate evidence, exclusion reasons, attribution windows, ID joins, and recalculation history. Difference reasons describe measurement semantics, not provider quality. It must not be treated as the primary MMP until a real shadow pilot has produced sufficient evidence.

The first native attribution vertical slice targets Android:

1. A user opens a measurement link.
2. The redirector passes a click ID to Google Play through Install Referrer.
3. The Android SDK reads Install Referrer on first launch.
4. The SDK sends an install record to the ingestion API.
5. The attribution engine deterministically matches the click and install.
6. Reporting separates organic and non-organic installs and groups results by campaign.

The implemented adapter boundary is deliberately narrow: first-party measurement links and evidence, Meta Install Referrer, and Apple Ads/Apple aggregate evidence. AppLovin MAX integration is revenue evidence, not user-level install attribution. User-level attribution for TikTok, the AppLovin ad network, the Unity Ads network, or Mintegral is outside the supported boundary when it requires a partner MMP relationship or non-public provider evidence.

## Principles

- Privacy by default
- No device fingerprinting
- Raw evidence, normalized records, decisions, and aggregates remain traceable
- Deterministic and aggregate privacy-preserving measurement remain distinct
- Received evidence is append-only; corrections are new records, and valid deletion requests produce redacted tombstones
- The measurement core is open; deployment secrets and live fraud policy remain private
- SDK, ingestion, attribution, and reporting are loosely coupled
- Start with PostgreSQL and add analytical infrastructure only when measured load requires it

## Runtime layout

```text
apps/
  api/                 # Management/reporting API and server-rendered dashboard
  redirector/          # Measurement links and redirects
  worker/              # Attribution and recalculation jobs
packages/
  contracts/           # API schemas and shared types
  attribution-core/    # Pure attribution logic
  redirector-core/     # Portable redirect and referrer behavior
  meta-install-referrer/ # Synthetic AES-GCM decryption core
sdk/
  android/             # Kotlin SDK, optional provider modules, and native sample
  ios/                 # Swift Package, Apple adapters, native sample, and tests
  unity/               # UPM package, Android/iOS bridges, samples, and compile probe
docs/
```

Implemented runtime code lives in `apps/api`, `apps/redirector`, `apps/worker`, `apps/runtime`, `packages/contracts`, `packages/attribution-core`, `packages/redirector-core`, `packages/meta-install-referrer`, `sdk/android`, `sdk/ios`, and `sdk/unity`.

## Current layout (v0.4 contract artifacts)

- `schemas/` — Draft 2020-12 artifact schemas, including event payloads under `schemas/events/`
- `registries/` — versioned closed vocabularies and compatibility definitions
- `fixtures/v0.4/` — reviewed synthetic inputs and immutable golden outputs
- `spec/` — normative contract behavior and serialization rules
- `tools/` — TypeScript and Python reference evaluators and contract validation
- `issue-drafts/` — historical design and acceptance records

## Documents

- [Product scope](docs/product-scope.md)
- [Architecture](docs/architecture.md)
- [Privacy and security](docs/privacy-security.md)
- [Import mapping DSL](docs/import-mappings.md)
- [Initial threat model](docs/threat-model.md)
- [Roadmap](docs/roadmap.md)
- [Project plan](docs/project-plan.md)
- [Issue #1 draft](issue-drafts/001-event-metric-contract-v0.1.md)
- [Primary references](docs/references.md)
- [Event & Metric Contract v0.4](spec/event-metric-contract-v0.4.md)
- [Contract v0.4 migration guide](docs/contract-v0.4-migration.md)
- [Schema versioning policy](docs/schema-versioning.md)
- [Operator real-data validation checklist](docs/validation/real-data-checklist.md)
- [M2 device and provider validation checklist](docs/validation/m2-device-checklist.md)
- [M3 operator validation checklist](docs/validation/m3-operator-checklist.md)
- [M4 device and Apple-provider validation checklist](docs/validation/m4-device-checklist.md)
- [M5 integrity-service checklist](docs/validation/m5-integrity-checklist.md)
- [M5 production-operator checklist](docs/validation/m5-operator-checklist.md)
- [M5 synthetic load record](docs/validation/m5-load-results.md)
- [Backup and restore runbook](docs/operations/backup-restore.md)
- [Release runbook](docs/operations/release.md)
- [Current milestone status](docs/STATUS.md)

## Five-minute synthetic quickstart

Requirements: Docker with Compose, Node.js 22.18.0, and npm 11.6.2. From a clean clone, run:

```bash
docker compose up -d --wait
npm run demo:metrics
```

The bootstrap service generates local secrets, migrations run automatically, and the API and worker start only after PostgreSQL is healthy. `demo:metrics` prints tenant-scoped ledger counts plus a clearly labelled contract-synthetic preview. The preview is calculated from fixture 33 and does not claim that a real provider or campaign was queried. Its key values are:

The API and dashboard listen on `http://localhost:8080` (`/dashboard` for the login page), and the portable redirector listens on `http://localhost:8090`. `npm run bootstrap` prints the local admin key once; paste it into the dashboard login form. Dashboard reports are aggregate operator views, not data-subject exports. Tracking links are created through the authenticated management route; request query parameters and headers can never override their stored destinations. SDK enrollment and event delivery use the HMAC signing string fixed in [M2 Design Baseline](docs/design/m2-baseline.md).

```json
{
  "synthetic_contract_preview": [
    { "metric_name": "d7_roas", "value_unscaled": "1500000", "ratio_scale": 6 },
    { "metric_name": "retention_d1", "value_unscaled": "1000000", "ratio_scale": 6 }
  ]
}
```

To load all reviewed contract fixtures through the real PostgreSQL ingestion path and compare database artifacts with their immutable goldens, run:

```bash
docker compose --profile seed run --rm seed
npm run verify:parity
```

To exercise the operator CSV-to-metric path without committing a tabular file, create a synthetic CSV only under the gitignored `.openmasu/` directory and run the two explicit jobs:

```bash
mkdir -p .openmasu
printf 'network,campaign_id,country,date,cost_micros,currency,as_of\nsynthetic-cli-network,synthetic-cli-campaign,us,2026-08-20,2500000,USD,2026-08-20T12:00:00.000Z\n' > .openmasu/synthetic-cost.csv
npm run import:cost -- --file=.openmasu/synthetic-cost.csv --mapping=examples/mappings/synthetic-manual-cost.json
npm run metrics:run -- --date=2026-08-20 --definitions=examples/metrics/synthetic-d0-roas.json
```

The first command persists one immutable synthetic `cost_record`; the second runs the existing cohort SQL engine at the explicit day watermark and persists `d0_roas` with `value_state=present`. With no matching synthetic revenue loaded for that cohort, the reproducible ratio value is zero. Re-running the same metric definition intentionally refuses to overwrite the immutable metric-run ID.

This quickstart uses synthetic inputs only. Do not place provider exports, credentials, real user data, campaign values, or validation results in this public repository.

## Android, iOS, and Unity SDK development

Requirements: JDK 17 and Android SDK 36. The Android project uses a checksum-pinned Gradle 8.13 wrapper. From the repository root:

```bash
./sdk/android/gradlew -p sdk/android androidAcceptance verifySdkSbom
./sdk/android/gradlew -p sdk/android :sample:connectedDebugAndroidTest
dotnet run --project sdk/unity/tests/UnityCompileProbe.csproj --configuration Release
```

The second command requires a running API 36 emulator. The first command compiles every documented Install Referrer 2.2 accessor, tests queue/consent/Meta/MAX behavior, verifies the merged manifest and backup rules, builds the native sample, and writes `sbom/sdk-android.cdx.json`. The Unity command is a shim compile and callback-concurrency gate; an actual Unity export remains an operator procedure. M2 distributes source and local build instructions only, not Maven or UPM registry artifacts.

On macOS, run the Swift and Simulator gates:

```bash
swift test --package-path sdk/ios
cd sdk/ios
xcodebuild -scheme OpenMasuObjC -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -scheme OpenMasuSample -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

The pinned `sdk-ios` workflow additionally compiles the adapter against the exact AppLovin MAX Swift Package, audits the built product and privacy manifest, emits a dependency-empty iOS SDK SBOM, and runs the Unity iOS bridge probe. See the [iOS SDK guide](sdk/ios/README.md). Real Apple/MAX accounts, real devices, and Unity exports remain operator procedures.

## Contract validation

Use Node.js 22.18.0 from [`.nvmrc`](.nvmrc), npm 11.6.2 from `package.json#engines`, and Python 3.13.5 from [`.python-version`](.python-version). The repository enforces the Node.js and npm engines through [`.npmrc`](.npmrc). Then run:

```bash
npm ci
python -m pip install --require-hashes --requirement requirements-contract.txt
npm run validate
```

Validation is read-only. It checks 27 schemas, 8 registries, 47 reviewed synthetic fixtures, 611 golden output artifacts across 13 classes, 47 scenario assertions, 26 acceptance criteria, semantic and metamorphic mutations, deterministic TypeScript output, independent Python output, and RFC 8785 conformance. See the [fixture provenance note](fixtures/v0.4/README.md).
