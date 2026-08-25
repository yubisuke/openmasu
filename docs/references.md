# Primary References

Checked on 2026-08-17.

## Apple

- [AdAttributionKit](https://developer.apple.com/documentation/AdAttributionKit)
- [Measuring ad performance with AdAttributionKit](https://developer.apple.com/app-store/ad-attribution/)
- [SKAdNetwork](https://developer.apple.com/documentation/storekit/skadnetwork)
- [App Tracking Transparency](https://developer.apple.com/documentation/apptrackingtransparency)

Primary M4 verification recorded on 2026-08-20:

- [Verifying an SKAdNetwork install-validation postback](https://developer.apple.com/documentation/StoreKit/verifying-an-install-validation-postback) defines the P-256 signature check and signed field order.
- [Identifying SKAdNetwork postback parameters](https://developer.apple.com/documentation/storekit/identifying-the-parameters-in-install-validation-postbacks) defines version 3 and 4 fields.
- [Verifying an AdAttributionKit postback](https://developer.apple.com/documentation/adattributionkit/verifying-a-postback) defines ES256 compact JWS verification, production/development `kid` values, permanent postback identifiers, success/retry behavior, and the literal `AttributionCopyEndpoint` configuration property.
- [Configuring an AdAttributionKit advertised app](https://developer.apple.com/documentation/adattributionkit/configuring-an-advertised-app) defines the advertised-app developer copy endpoint.
- [AdServices attribution token](https://developer.apple.com/documentation/AdServices/AAAttribution/attributionToken%28%29) defines raw token acquisition; the server sends that token to Apple's attribution endpoint.
- [Adding a privacy manifest to an SDK](https://developer.apple.com/documentation/bundleresources/adding-a-privacy-manifest-to-your-app-or-third-party-sdk) defines Swift Package placement and resource declaration.
- [Optimizing data for iCloud backup](https://developer.apple.com/documentation/foundation/optimizing-your-app-s-data-for-icloud-backup) defines the backup-exclusion resource value used by the iOS SDK storage subtree.
- [AdAttributionKit Postback](https://developer.apple.com/documentation/adattributionkit/postback) and its [conversion-value update method](https://developer.apple.com/documentation/adattributionkit/postback/updateconversionvalue%28_%3Acoarseconversionvalue%3Alockpostback%3A%29) define the exact async Swift API used by the SDK.
- [Privacy collected-data type](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype) and [collection purposes](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatypepurposes) define the exact manifest vocabulary used by the SDK.
- [AppLovin MAX iOS advanced settings](https://developers.applovin.com/en/max/ios/overview/advanced-settings/) and the [pinned 13.6.4 Swift Package manifest](https://raw.githubusercontent.com/AppLovin/AppLovin-MAX-Swift-Package/13.6.4/Package.swift) define the impression-revenue fields and exact compile-only provider dependency.

Primary M5 verification recorded on 2026-08-20:

- [Apple DeviceCheck](https://developer.apple.com/documentation/devicecheck) defines App Attest as app-integrity evidence and cautions that no single policy eliminates fraud.
- [Validating apps that connect to your server](https://developer.apple.com/documentation/devicecheck/validating-apps-that-connect-to-your-server) defines server challenge, attestation, and assertion verification. The public repository reserves evidence fields only; live key/project setup remains an operator task.

Design implications:

- Use AdAttributionKit as the primary direction for Apple privacy-preserving app attribution while accounting for SKAdNetwork interoperability.
- Never present privacy-preserving aggregate results as deterministic installation-level attribution.
- Distinguish tracking that requires ATT from AdAttributionKit measurement that does not require ATT by itself.
- Device fingerprinting is outside the project scope.
- M4 does not collect IDFA, request ATT permission, or infer an identifier from device signals.

## Google

- [Google Play Install Referrer](https://developer.android.com/google/play/installreferrer)
- [Install Referrer API fields](https://developer.android.com/google/play/installreferrer/igetinstallreferrerservice)
- [Android Auto Backup](https://developer.android.com/identity/data/autobackup)
- [Update on plans for Privacy Sandbox technologies](https://privacysandbox.google.com/blog/update-on-plans-for-privacy-sandbox-technologies)
- [Privacy Sandbox enrollment](https://privacysandbox.google.com/private-advertising/enrollment)
- [Advertising ID policy](https://support.google.com/googleplay/android-developer/answer/6048248)
- [Google Play User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311)

Design implications:

- M2 Android, Unity, and redirector uses the referrer URL and timing evidence from Install Referrer.
- Google announced the retirement of Attribution Reporting (Android) on 2025-10-17 and no longer accepts enrollment; this project does not adopt it.
- The initial MVP does not collect Advertising ID.
- SDK providers and app developers remain responsible for identifier and user-data policy compliance.

Primary M2 verification recorded on 2026-08-19:

- [Install Referrer AIDL response bundle](https://developer.android.com/google/play/installreferrer/igetinstallreferrerservice) lists the server click/install timestamps and install-version fields used by the v0.3 contract.
- [Google Play Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en) requires operators to account for SDK collection and location derived from IP; the default redirector does not derive location.
- [Meta Install Referrer](https://developers.facebook.com/documentation/app-ads/meta-install-referrer) exposes `install_referrer`, `is_ct`, and `actual_timestamp`. Live value semantics remain operator-verified, and synthetic crypto vectors do not establish campaign behavior.

Primary M5 verification recorded on 2026-08-20:

- [Play Integrity overview](https://developer.android.com/google/play/integrity/overview) defines app/device verdicts, request-hash or nonce binding, replay considerations, gradual enforcement, and the requirement to combine integrity evidence with other anti-abuse signals. Live Play project setup remains outside the code gate.

## Operations

Primary M5 verification recorded on 2026-08-20:

- [PostgreSQL 17 SQL dump](https://www.postgresql.org/docs/17/backup-dump.html) defines custom-format `pg_dump` archives and restoration with `pg_restore`.
- [PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) documents restore into a new database, `--exit-on-error`, archive portability, and the security boundary of executing dump contents.
- [Prometheus exposition formats](https://prometheus.io/docs/instrumenting/exposition_formats/) defines the UTF-8 line-oriented `text/plain; version=0.0.4` format used by the authenticated `/metrics` route.

## Licensing and consent

- [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt)
- [GDPR Article 7](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng)

Design implications:

- Keep the official Apache-2.0 text unchanged and maintain attribution separately in `NOTICE`.
- Withdrawal does not invalidate processing completed before withdrawal. For a consent-required purpose, new server processing after withdrawal recognition requires a documented legal basis; `occurred_at` alone does not authorize ingestion.

## Contract standards and reference libraries

- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
- [Trail of Bits rfc8785 for Python](https://pypi.org/project/rfc8785/0.1.4/)

Design implications:

- Contract schemas declare Draft 2020-12 explicitly.
- Both reference evaluators must produce the same RFC 8785 UTF-8 bytes for shared conformance vectors.
- The Python dependency is version- and hash-pinned; fixture validation does not contact a live provider.

## Optional Cloudflare redirector

- [Workers](https://developers.cloudflare.com/workers/)

Design implications:

- M1 through M3 use Docker Compose, Node.js, and PostgreSQL without Cloudflare services.
- A Cloudflare Worker is an optional M2 redirector adapter only. The portable Node.js redirector remains available, and no contract behavior depends on Workers.
- Queues, R2, and D1 are not adopted by the current roadmap. A later infrastructure decision requires measured evidence, an explicit port, and contract-equivalence tests.
- Recheck Workers product status, limits, data-location behavior, and pricing immediately before implementing the optional adapter.

## Media integration

- [Google Ads App Conversion Tracking API](https://developers.google.com/app-conversion-tracking/api)
- [AppLovin MAX S2S Impression Revenue API](https://support.applovin.com/en/max/advanced-features/s2s-impression-level-api/)

These references demonstrate possible integration paths, not completed approval or production support.

Before starting the Google Ads third-party provider flow, verify whether a provider ID/Link ID and partner approval are required and whether self-service configuration is sufficient. Before starting Apple privacy-preserving measurement, verify that developer postback copies available without ad-network registration are adequate for the intended tests. The Milestone 5 adapter owner records the primary-source result and revises the adapter order only with that evidence.

## Change warning

Google announced the retirement of Attribution Reporting (Android) on 2025-10-17 and no longer accepts enrollment; this project does not adopt it. Recheck the cited retirement and enrollment pages before changing this decision.
