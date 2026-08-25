# Open MMP

Open MMP is an early-stage project for a self-hostable, open-source Mobile Measurement Partner whose measurement evidence can be audited and reproduced.

## Why this project exists

Independent measurement systems can produce totals that need transparent evidence to reconcile: raw events, attribution decisions, metric definitions, attribution logic, and pricing or cost assumptions. Open MMP starts in complementary shadow mode alongside an existing MMP, so neutral measurement differences can be explained before any primary migration.

The project focuses on auditable, open event and metric contracts that independent implementations can reproduce from synthetic fixtures. Deployment-specific data, credentials, and live fraud defenses remain private. It is designed to make measurement more transparent without enabling device fingerprinting or cross-app tracking.

This is an early design-stage project, not a production-ready MMP.

## License

This project is licensed under the [Apache License 2.0](LICENSE); attribution is recorded in [NOTICE](NOTICE). The project maintainer must complete a name and trademark clearance before the first public release; this is a release prerequisite, not a claim of trademark rights. Security reporting follows [SECURITY.md](SECURITY.md).

## Current status

This project contains the v0.1 contract schemas, registries, synthetic fixtures, and executable reference evaluators. M0.1 contract hardening is complete, the local validation gate passes, and M1 Shadow Ledger is next. It is not production-ready runtime ingestion software or a runtime release.

The first product entry point is a Shadow MMP that runs alongside an existing provider. It normalizes first-party events, existing MMP exports, media cost, and revenue into a common contract, then explains neutral differences through candidate evidence, exclusion reasons, attribution windows, ID joins, and recalculation history. Difference reasons describe measurement semantics, not provider quality. It must not be treated as the primary MMP until a real shadow pilot has produced sufficient evidence.

The first native attribution vertical slice targets Android:

1. A user opens a measurement link.
2. The redirector passes a click ID to Google Play through Install Referrer.
3. The Android SDK reads Install Referrer on first launch.
4. The SDK sends an install record to the ingestion API.
5. The attribution engine deterministically matches the click and install.
6. Reporting separates organic and non-organic installs and groups results by campaign.

## Principles

- Privacy by default
- No device fingerprinting
- Raw evidence, normalized records, decisions, and aggregates remain traceable
- Deterministic and aggregate privacy-preserving measurement remain distinct
- Received evidence is append-only; corrections are new records, and valid deletion requests produce redacted tombstones
- The measurement core is open; deployment secrets and live fraud policy remain private
- SDK, ingestion, attribution, and reporting are loosely coupled
- Start with PostgreSQL and add analytical infrastructure only when measured load requires it

## Planned layout

```text
apps/
  api/                 # Management and reporting API
  redirector/          # Measurement links and redirects
  worker/              # Attribution and recalculation jobs
  dashboard/           # Management UI, later in the MVP
packages/
  contracts/           # API schemas and shared types
  attribution-core/    # Pure attribution logic
sdks/
  android/             # Kotlin SDK and Unity bridge
  ios/                 # Swift SDK, Phase 2
docs/
```

This is a proposed implementation layout, not generated code.

## Current layout (v0.1 contract artifacts)

- `schemas/` — Draft 2020-12 artifact schemas, including event payloads under `schemas/events/`
- `registries/` — versioned closed vocabularies and compatibility definitions
- `fixtures/v0.1/` — reviewed synthetic inputs and immutable golden outputs
- `spec/` — normative contract behavior and serialization rules
- `tools/` — TypeScript and Python reference evaluators and contract validation
- `issue-drafts/` — historical design and acceptance records

## Documents

- [Product scope](docs/product-scope.md)
- [Architecture](docs/architecture.md)
- [Privacy and security](docs/privacy-security.md)
- [Initial threat model](docs/threat-model.md)
- [Roadmap](docs/roadmap.md)
- [Project plan](docs/project-plan.md)
- [Issue #1 draft](issue-drafts/001-event-metric-contract-v0.1.md)
- [Primary references](docs/references.md)
- [Event & Metric Contract v0.1](spec/event-metric-contract-v0.1.md)

## Contract validation

Use Node.js 22.18.0 from [`.nvmrc`](.nvmrc), npm 11.6.2 from `package.json#engines`, and Python 3.13.5 from [`.python-version`](.python-version). The repository enforces the Node.js and npm engines through [`.npmrc`](.npmrc). Then run:

```bash
npm ci
python -m pip install --require-hashes --requirement requirements-contract.txt
npm run validate
```

Validation is read-only. It checks schemas, registries, 19 reviewed synthetic fixtures, golden output artifacts, semantic and metamorphic mutations, deterministic TypeScript output, independent Python output, and RFC 8785 conformance. See the [fixture provenance note](fixtures/v0.1/README.md).
