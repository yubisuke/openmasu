# Commercial MMP Gap Summary

Checked on 2026-08-21 and corrected against the repository on 2026-08-23.

## Purpose

This is a short decision sheet, not a parity roadmap. It shows which broad
capabilities are common in commercial MMPs, what OpenMasu currently provides,
and whether the project should keep, build, or skip the difference now.

OpenMasu states have only four meanings:

- **Ready**: source and synthetic automated evidence exist. This does not mean
  live-provider, real-device, production, or operator validation is complete.
- **Partial**: a useful core or a limited adapter set exists.
- **Missing**: no implementation exists for the stated capability.
- **Not planned**: the capability conflicts with the product boundary or
  depends on access unavailable to a public self-hosted implementation.

Decisions are deliberately limited to **Keep**, **Build**, and **Skip**.
`Skip` means no current work; it can be reconsidered only after a real need is
observed.

## Capability summary

| Capability | Commercial MMPs | OpenMasu | Decision |
| --- | --- | --- | --- |
| Deterministic mobile install attribution | Common | **Ready** — first-party, Meta Install Referrer, Google Play Install Referrer, and Apple Ads through AdServices exist | **Keep** |
| Shadow comparison, recalculation, and difference audit | Varies | **Ready** — versioned evidence, neutral difference reasons, JSON/CSV audit, and replay exist | **Keep** |
| Android, iOS, and Unity SDKs | Common | **Ready** — Kotlin, Swift, and Unity surfaces exist with synthetic build evidence | **Keep** |
| SKAdNetwork and AdAttributionKit receipt and aggregate reporting | Common or emerging | **Ready** — protected receipt, verification, replay resistance, and separate aggregate series exist | **Keep** |
| Direct deep links and Android deferred deep links | Common | **Ready** — deterministic direct links and Play Install Referrer delivery exist | **Keep** |
| Re-engagement measurement | Common | **Ready** for engagement-scope direct opens; OpenMasu intentionally does not re-credit the install | **Keep** |
| Media cost import and ROAS | Common | **Partial** — manual cost import, synthetic Meta/Google and MAX normalization, D0/D1/D3/D7 ROAS, and a non-zero synthetic install/revenue/cost path exist; live adapter entrypoints and connectivity are unverified | **Keep** |
| Verified purchase and subscription revenue | Common | **Partial** — provider-neutral settled purchase/refund SDK ingestion and net-revenue metrics exist; store verification and subscription lifecycle handling do not | **Skip** |
| Impression-level ad revenue mediation | Common | **Partial** — MAX mapping exists; other mediation providers do not | **Skip** |
| Operational alerts and notification routing | Common | **Partial** — bounded authenticated Prometheus metrics now include durable fixed job success/failure counts and latest-completion timestamps; scheduler and notification routing do not exist | **Keep** — consume the fixed signals through private monitoring, and add no public receiver or threshold before a pilot establishes ownership |
| Deterministic fraud and device-integrity evidence | Common | **Partial** — transparent rules and provider boundaries exist; live projects and threshold calibration remain operator work | **Keep** |
| Dashboard, reporting API, and raw-data access | Common | **Ready** for the current scope — dashboard, audit exports, and self-hosted PostgreSQL access exist | **Keep** |
| Conversion-value policy management | Common | **Partial** — versioned schemas, digests, validation, and iOS evaluation exist; no-code authoring and deployment UX do not | **Keep** |
| Longer cohorts and tenant-configurable windows | Common | **Partial** — fixed D0/D1/D3/D7 cohorts and D1/D7 retention exist | **Skip** |
| SKAN-to-cost reporting | Common | **Missing** — Apple source identifiers and media campaign IDs need an explicit mapping design first | **Skip** |
| Link management, QR codes, templates, and smart banners | Common | **Partial** — link creation and destination handling exist; product-management extras do not | **Skip** |
| Web, React Native, Flutter, and additional game SDKs | Common | **Missing** beyond the existing native and Unity surfaces | **Skip** |
| Managed S3, GCS, BigQuery, or streaming delivery | Common | **Missing** — operators can use the self-hosted database and audit export today | **Skip** |
| Funnels, predictive LTV, geo lift, and MMM | Offered by some | **Missing** — current geography is country-level only; city and causal-analysis products do not exist | **Skip** |
| Audience activation | Common | **Missing** — audience targeting is outside the current MVP | **Skip** |
| Outbound network conversion postbacks | Common | **Missing** — provider contracts and a concrete pilot requirement are not defined | **Skip** |
| SSO, agency access, and cross-app administration | Common in enterprise tiers | **Partial** — minimum RBAC and tenant isolation exist | **Skip** |
| Uninstall estimation | Offered by some | **Not planned** — platform signals do not provide a sufficiently reliable cross-platform measurement | **Skip** |
| Probabilistic attribution, device-matched view-through, CTV household matching, and probabilistic iOS deferred links | Common in some products | **Not planned** — these conflict with the no-fingerprinting and deterministic-evidence boundary | **Skip** |
| Partner-only SRN user-level attribution | Common for approved MMP partners | **Not planned** — the required status or non-public interface is unavailable to this public self-hosted project | **Skip** |

## Next three actions

1. Run `npm run test:integration` and confirm the test named `WO11 carries an
   attributed install, revenue, and cost through to non-zero D0 ROAS` passes;
   then run one controlled shadow pilot. Do not replace the existing production
   MMP.
2. Make the private scheduler notify on non-zero exits and consume the fixed
   job outcome/count and latest-completion series. Keep receivers and thresholds
   private; do not invent public production thresholds yet.
3. After the pilot, promote exactly one observed input gap to **Build**: one
   cost adapter, one mediation adapter, or verified store revenue. Do not select
   a provider before the pilot identifies the need.

No other capability should become an implementation issue until one of these
three actions produces concrete evidence.

## Corrections from the longer draft

- Conversion-value schema management is **Partial**, not absent. The API stores
  a versioned definition and digest, and the iOS SDK validates and evaluates the
  rules.
- An inactivity window is not a missing switch in the current re-engagement
  design. OpenMasu measures engagement separately and does not re-credit an
  install.
- SKAN cost reporting is not a small report-only change. Apple source
  identifiers and media campaign identifiers need a deliberate mapping.
- A browser cookie cannot deterministically connect a web click to an iOS
  install. Web collection and iOS deferred linking must not be presented as one
  solved path.
- Existing reporting supports country, not city. Geo-lift work therefore cannot
  assume city-level input already exists.

## Repository evidence

- [Project status](../STATUS.md)
- [Canonical roadmap](../roadmap.md)
- [Product scope and non-goals](../product-scope.md)
- [Real-data checklist](../validation/real-data-checklist.md)
- [Production operator checklist](../validation/m5-operator-checklist.md)
- [Deep-link and re-engagement design](../design/deeplink-baseline.md)
- [`registerConversionSchema`](../../apps/api/src/apple-admin.ts)
- [iOS conversion-schema evaluation](../../sdk/ios/Sources/OpenMasuApplePostback/ConversionSchema.swift)
- [Current metric windows](../../packages/contracts/src/m1b-metric-definitions.ts)
- [Current import adapters](../../apps/worker/src/import/adapters.ts)

Commercial-side labels are a dated comparison summary, not a vendor contract.
Recheck the relevant provider's current primary documentation before promoting
any `Skip` row to `Build`.
