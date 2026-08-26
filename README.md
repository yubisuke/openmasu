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

The current source and SDK release candidate is `v0.2.0-rc.1`. It packages the
post-M7 synthetic implementation while retaining Contract v0.4 identities;
the release number and contract version are intentionally independent. See
[the release-candidate notes](docs/releases/v0.2.0-rc.1.md).

This project contains the v0.4 contract, with additive metric and rule definitions through v0.4.9, and synthetic code milestones through M7: the Shadow ledger and import foundation, cohort metrics and difference audit, Android/Unity and Apple measurement paths, the server-rendered operator dashboard, production-control foundations, deterministic fraud controls, direct/deferred deep-link paths, settled purchase/refund net revenue, D30/D90 total-net ROAS and cohort LTV, and synthetic verified-commerce lifecycle paths for Google Play and the App Store. Real provider connectivity, real-device and campaign validation, Unity exports, App Store review, a production deployment, real backup operations, real production load, real integrity-service configuration, live purchase verification, and real link-domain verification have not been demonstrated. Immutable baselines are available at the `contract-v0.1`, `contract-v0.2.1`, and `contract-v0.3.6` Git tags. See [the current status](docs/STATUS.md) for the milestone-by-milestone boundary.

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
- [M6 fraud operator checklist](docs/validation/m6-fraud-checklist.md)
- [M7 deep-link device checklist](docs/validation/deeplink-device-checklist.md)
- [M5 synthetic load record](docs/validation/m5-load-results.md)
- [Backup and restore runbook](docs/operations/backup-restore.md)
- [Release runbook](docs/operations/release.md)
- [Current milestone status](docs/STATUS.md)

## Five-minute synthetic quickstart

Requirements: Docker with Compose, Node.js 22.18.0, and npm 11.6.2. The Node.js and npm versions must match exactly because `.npmrc` enables `engine-strict`; nearby versions are rejected. Use `.nvmrc` with nvm, fnm, or an equivalent version manager. From a clean clone, run:

```bash
npm ci
docker compose up -d --wait
npm run demo:metrics
```

The bootstrap service generates local secrets, migrations run automatically, and the API and worker start only after PostgreSQL is healthy. `demo:metrics` prints tenant-scoped ledger counts plus a clearly labelled contract-synthetic preview. The preview is calculated from fixture 33 and does not claim that a real provider or campaign was queried.

The API and dashboard listen on `http://localhost:8080` (`/dashboard` for the login page), and the portable redirector listens on `http://localhost:8090`. `npm run bootstrap` prints the local admin key once; paste it into the dashboard login form. Dashboard reports are aggregate operator views, not data-subject exports. Tracking links are created through the authenticated management route; request query parameters and headers can never override their stored destinations. SDK enrollment and event delivery use the HMAC signing string fixed in [M2 Design Baseline](docs/design/m2-baseline.md).

Subject access and portability are deliberately separate from dashboard reporting. An enrolled installation can sign `POST /v1/privacy/access` with its installation credential and a body containing its own `installation_id` plus `request_type: "access"` or `"portability"`. The response contains only allowlisted normalized facts and opaque scoped references; it is returned with `Cache-Control: no-store` and is not a raw-payload export. Deletion remains a separate operation at `POST /v1/privacy/on-device`.

An abridged clean-start output makes the two origins explicit:

```json
{
  "ledger_counts": {
    "origin": "postgresql_ledger",
    "raw_records": 0,
    "logical_events": 0
  },
  "synthetic_contract_preview": [
    { "origin": "contract_fixture", "fixture": "33-stage-b-cohort-metrics", "metric_name": "d7_roas", "value_unscaled": "1500000", "ratio_scale": 6 },
    { "origin": "contract_fixture", "fixture": "33-stage-b-cohort-metrics", "metric_name": "retention_d1", "value_unscaled": "1000000", "ratio_scale": 6 }
  ]
}
```

To load all reviewed contract fixtures through the real PostgreSQL ingestion path and compare database artifacts with their immutable goldens, run:

```bash
docker compose --profile seed run --rm seed
npm run verify:parity
```

Run the seed profile only on a synthetic instance with concurrent ingestion quiesced. Seed jobs serialize against each other with a PostgreSQL advisory lock and retry one `40P01` deadlock once; a second database deadlock is reported as a failure and should be investigated before rerunning.

To exercise the operator CSV-to-metric path without committing a tabular file, create a synthetic CSV only under the gitignored `.openmasu/` directory and run the two explicit jobs:

```bash
mkdir -p .openmasu
printf 'network,campaign_id,country,date,cost_micros,currency,as_of\nsynthetic-cli-network,synthetic-cli-campaign,us,2026-08-20,2500000,USD,2026-08-20T12:00:00.000Z\n' > .openmasu/synthetic-cost.csv
npm run import:cost -- --file=.openmasu/synthetic-cost.csv --mapping=examples/mappings/synthetic-manual-cost.json
npm run metrics:run -- --date=2026-08-20 --definitions=examples/metrics/synthetic-d0-roas.json
```

The first command persists one immutable synthetic `cost_record`; the second runs the existing cohort SQL engine at the explicit day watermark and persists `d0_roas` with `value_state=present`. With no matching synthetic revenue loaded for that cohort, the reproducible ratio value is zero. Re-running the same metric definition intentionally refuses to overwrite the immutable metric-run ID.

This quickstart uses synthetic inputs only. Do not place provider exports, credentials, real user data, campaign values, or validation results in this public repository.

## Create a tracking link in the dashboard

Custom HTTPS destinations fail closed unless their origins are explicitly allowed. Before the first bootstrap, export a comma-separated allowlist and start the stack:

```bash
export OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST=https://links.synthetic.example
docker compose up -d --wait
docker compose logs bootstrap
```

Open `http://localhost:8080/dashboard`, sign in with the generated admin key shown by the bootstrap log, select the application, and use **Create a tracking link**. The destination URL must use an origin in `OPENMASU_REDIRECTOR_DESTINATION_ALLOWLIST`; an unlisted origin remains rejected. An existing deployment must update its generated app runtime environment through its secret-management procedure and restart the API before a changed allowlist takes effect.

## Manage apps, SDK keys, and provider configuration

An administrator can use the same zero-JavaScript app page to issue a successor Android or iOS SDK key, retire the prior key, register a tenant link domain, and submit app-link, Apple app, conversion-schema, fraud-rule-bundle, and Google Data Manager configuration. A new SDK secret is shown exactly once; normal pages and list APIs expose only key metadata. Rotation permits at most two active keys, and the last active key cannot be retired. The overlap is an app-release-adoption window, not a short operations window: retire the old key only after the successor has reached the intended installed-app population.

Tracking-link lifecycle operations are append-only. An active link may be paused or archived, a paused link may be archived, and an archived link is terminal. Non-active links continue to use the documented safe fallback instead of their configured destination. Administrators can perform every operation, operators can create/pause/archive tracking links, and read-only identities cannot mutate configuration. Dashboard mutations require the bound session CSRF token and same-origin request checks.

## Backfill aggregate MAX revenue

OpenMasu can pull the AppLovin MAX Revenue Reporting API into a separate, append-only aggregate-revenue snapshot series. Set `OPENMASU_MAX_REPORT_KEY` or `OPENMASU_MAX_REPORT_KEY_FILE` in the private deployment environment, then run an inclusive UTC range within the provider's current 45-day request window:

```bash
npm run import:revenue:max -- --tenant=<tenant> --app=<app> --start=2026-08-23 --end=2026-08-23
```

The command requests only UTC day, country, MAX ad-unit ID, network, and estimated revenue. Repeating the same report snapshot is idempotent; a later provider restatement remains in history while `aggregate_revenue_snapshots_current` selects the latest observed row for each retained dimension key. Reporting API totals are deliberately separate from S2S impression facts because they may overlap. They are not added to installation-level D0/D7/D30/D90 cohort revenue, and no installation or advertising identifier is stored. Recent provider totals may still be incomplete, so a later snapshot is expected to restate them.

Live credentials, account access, provider availability, and private-dashboard reconciliation remain operator validation steps. Never commit a report key, response, or private validation result.

## Android, iOS, and Unity SDK development

### Deep-link capability boundary

OpenMasu delivers deterministic direct deep links on Android through App Links and on iOS through Universal Links. Deterministic deferred deep linking is available on Android only, carried by Google Play Install Referrer. On iOS, OpenMasu delivers deep links to users who already have the app, using Universal Links. It does not deliver a deep link to a user who installs the app after tapping a link. Every mechanism that would make that possible either requires deriving an identifier from device signals, which Apple's Developer Program License Agreement prohibits and which this project does not do, or requires a user-visible prompt on first launch. If Apple provides a channel that carries a destination through installation, OpenMasu will use it.

The SDK parses and reports a typed destination but never navigates. The host application remains responsible for validating the value again and selecting its own screen. Routing still reaches the host listener while measurement collection is disabled; no `deep_link_open` event is queued in that state. A direct `deep_link_open` is a device claim, not server-observed click evidence.

Requirements: JDK 17 and Android SDK 36. The Android project uses a checksum-pinned Gradle 8.13 wrapper. From the repository root:

```bash
./sdk/android/gradlew -p sdk/android androidAcceptance verifySdkSbom
./sdk/android/gradlew -p sdk/android :sample:connectedDebugAndroidTest
dotnet run --project sdk/unity/tests/UnityCompileProbe.csproj --configuration Release
```

The second command requires a running API 36 emulator. The first command compiles every documented Install Referrer 2.2 accessor, tests queue/consent/Meta/MAX behavior, verifies the merged manifest and backup rules, builds the native sample, and writes `sbom/sdk-android.cdx.json`. The Unity command is a shim compile and callback-concurrency gate; an actual Unity export remains an operator procedure.

The standard Unity Android bridge enables the Google Play reader by default. Set `OpenMasuOptions.EnablePlayReferrer=false` for an explicit unavailable fallback. Meta reading remains opt-in through the non-secret `OpenMasuOptions.MetaAppId`; blank or invalid values fail closed. The bridge package carries the provider module dependencies and keeps host-level reader injection available to native Android applications.

To generate the local, reproducible SDK distribution without publishing to a registry:

```bash
npm run sbom
./sdk/android/gradlew -p sdk/android :core:assembleRelease :installreferrer:assembleRelease :metareferrer:assembleRelease :max:assembleRelease :unitybridge:assembleRelease verifySdkSbom --no-daemon
python tools/build-sdk-release.py --reproducibility-check
```

`build/sdk-release/openmasu-sdk-0.2.0-rc.1/` contains Maven AAR/POM artifacts, a Unity UPM archive, an immutable Swift Package source archive, Android/iOS/Unity CycloneDX SBOMs, source and toolchain metadata, and a SHA-256 manifest. CI rebuilds and byte-compares the bundle. These are synthetic build artifacts only: no registry publication, Unity export, real provider read, device validation, or distribution signing is claimed.

### Google Play purchase verification

The Android SDK can submit a Play Billing one-time-product or initial-subscription token through the authenticated, encrypted ingestion path:

```kotlin
openMasu.trackGooglePlayProductPurchase(
  purchaseToken = purchase.purchaseToken,
  productId = "synthetic.product.example",
  transactionId = "transaction:host-owned-id",
  amountUnscaled = "12990000",
  amountScale = 6,
  currency = "USD",
)

openMasu.trackGooglePlaySubscriptionPurchase(
  purchaseToken = purchase.purchaseToken,
  productId = "synthetic.subscription.example",
  transactionId = "transaction:host-owned-subscription-id",
  amountUnscaled = "9990000",
  amountScale = 6,
  currency = "USD",
)
```

Register the application's Android package identity, provide a service-account JSON file through the deployment secret manager, and enable the worker only after completing the [Google Play product-verification checklist](docs/validation/google-play-product-verification-checklist.md):

```bash
OPENMASU_GOOGLE_PLAY_PRODUCT_VERIFICATION=on
OPENMASU_GOOGLE_PLAY_SUBSCRIPTION_VERIFICATION=on
OPENMASU_GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_FILE=/run/secrets/google-play-service-account.json
```

The initial client record stays `pending`. For one-time products, the worker requires a purchased ProductPurchaseV2 response and a matching processed order line. For an initial subscription, it requires one matching SubscriptionPurchaseV2 line with a latest successful order, then requires that order's subscription service period to start at the subscription start time. This prevents a later renewal from being mistaken for the initial order. In both paths, emitted money comes exactly from the matching Google order line total; client money is only an untrusted pending claim. Tokens, order IDs, buyer data, titles, and raw responses never enter public ledger artifacts. This proves a transaction, not entitlement or acknowledgement. Complete the [one-time-product checklist](docs/validation/google-play-product-verification-checklist.md) or [initial-subscription checklist](docs/validation/google-play-subscription-verification-checklist.md) before enabling the respective worker.

Authenticated Google Cloud Pub/Sub push can trigger the separate subscription-renewal slice:

```dotenv
OPENMASU_GOOGLE_PLAY_RTDN_RENEWAL_VERIFICATION=on
OPENMASU_GOOGLE_PLAY_RTDN_AUDIENCE=https://measure.example.invalid/v1/google-play/rtdn
OPENMASU_GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT_EMAIL=openmasu-rtdn@example-project.iam.gserviceaccount.com
```

Configure the Pub/Sub push endpoint as `https://<host>/v1/google-play/rtdn` with authentication enabled and the exact audience and user-managed service account above. The receiver verifies Google's OIDC signature and claims, resolves the registered package without trusting request tenant data, and records every supported subscription lifecycle signal separately from money. The worker re-reads SubscriptionPurchaseV2 for current state. A voided/full/partial-refund signal is reconciled against Orders history; only a processed exact provider amount creates one `refund` correction. Message, token, notification, and order digests make retry and redelivery idempotent. Enable authenticated read-back with `OPENMASU_COMMERCE_READBACKS=on`. RTDN remains a signal, not monetary truth, and a latest subscription snapshot cannot reconstruct every missed intermediate renewal. Complete the [verified-commerce operator checklist](docs/validation/verified-commerce-operator-checklist.md) before enabling it.

### App Store lifecycle notifications

Register the app's bundle ID and App Apple ID, configure App Store Server Notifications V2 at `https://<host>/v1/apple/app-store/notifications`, and use secret files for the App Store Server API key:

```dotenv
OPENMASU_APPLE_STORE_NOTIFICATIONS=on
OPENMASU_COMMERCE_READBACKS=on
OPENMASU_APPLE_ROOT_SHA256=<trusted-root-certificate-sha256>
OPENMASU_APP_STORE_API_ISSUER_ID=<issuer-id>
OPENMASU_APP_STORE_API_KEY_ID=<key-id>
OPENMASU_APP_STORE_API_PRIVATE_KEY_FILE=/run/secrets/app-store-api-private-key.p8
```

OpenMasu verifies the outer notification and nested transaction/renewal ES256 JWS material, exact environment and app scope, and replay UUID before retaining encrypted evidence. The worker verifies signed transaction/refund history again and stores only safe state and identifier digests. Notifications never create money directly. Live Apple credentials, roots, delivery, key rotation, quotas, installation-level transaction binding, and App Store behavior are not proven by CI; follow the [operator checklist](docs/validation/verified-commerce-operator-checklist.md).

For a bounded operator-authorized recovery, put one provider subject in a protected JSON file outside this repository and enqueue it with a half-open evidence window:

```bash
npm run commerce:backfill -- \
  --tenant=tenant-local --app=app-local \
  --provider=google_play --operation=google_order_refund \
  --subject-file=/run/secrets/synthetic-commerce-subject.json \
  --window-start=2026-08-01T00:00:00.000Z \
  --window-end=2026-08-25T00:00:00.000Z
```

Google subject files use the closed decoded-RTDN shape for `subscriptionNotification` or `voidedPurchaseNotification`; Apple subject files contain only `signedPayload`. The command encrypts the file before durable queuing, records an idempotent checkpoint, prints only safe status/digest metadata, and never copies it into repository fixtures. Cursor progress is encrypted and a successful terminal read marks the checkpoint complete.

### Verified conversion delivery to Google Data Manager

OpenMasu can optionally deliver a Play-verified, settled purchase to Google Data Manager only when its latest attribution is final and non-organic, the source click is explicitly `network=google_ads`, and `remote_click_ref` contains the source-qualified GCLID. Configure the redirector with `OPENMASU_REDIRECTOR_REMOTE_CLICK_PARAM=gclid`; internal click IDs and hashed reconciliation keys are never substituted. Register the non-secret destination with an administrator key:

```bash
curl -X POST http://localhost:8080/v1/admin/apps/app-local/google-data-manager \
  -H "Authorization: Bearer $OPENMASU_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"operating_account_id":"1234567890","conversion_action_id":"987654321","app_audience":"general","enabled":true}'
```

Then provide a dedicated credential, separate from Play verification, and opt in:

```dotenv
OPENMASU_GOOGLE_DATA_MANAGER_ENABLED=on
OPENMASU_GOOGLE_DATA_MANAGER_SERVICE_ACCOUNT_JSON_FILE=/run/secrets/google-data-manager-service-account.json
```

The request body is encrypted until dispatch, retries are idempotent by a stable transaction ID, and delayed diagnostics are polled for at most 24 hours. Child-directed destinations, withdrawn/redacted evidence, provisional/organic/unattributed decisions, unverified purchases, and precision-losing money are rejected before dispatch. Complete the [operator checklist](docs/validation/google-data-manager-conversion-checklist.md) first. Live Google access, destination acceptance, diagnostics timing, provider retention, and post-dispatch deletion/retraction are not proven by synthetic CI.

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

Validation is read-only. It checks 28 schemas, 8 registries, 56 reviewed synthetic fixtures, 728 golden output artifacts, 56 scenario assertions, 27 acceptance criteria, semantic and metamorphic mutations, deterministic TypeScript output, independent Python output, and RFC 8785 conformance. Purchase-net definitions cover D0/D1/D3/D7/D30/D90; D30/D90 total-net definitions add advertising revenue to settled purchase net for revenue, ROAS, and cohort LTV without changing the earlier ad-only series. Settled status is provider-neutral client evidence, not App Store, Play, or private-provider verification. See the [fixture provenance note](fixtures/v0.4/README.md).
