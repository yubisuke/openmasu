# Primary References

Checked on 2026-08-17.

## Apple

- [AdAttributionKit](https://developer.apple.com/documentation/AdAttributionKit)
- [Measuring ad performance with AdAttributionKit](https://developer.apple.com/app-store/ad-attribution/)
- [SKAdNetwork](https://developer.apple.com/documentation/storekit/skadnetwork)
- [App Tracking Transparency](https://developer.apple.com/documentation/apptrackingtransparency)

Design implications:

- Use AdAttributionKit as the primary direction for Apple privacy-preserving app attribution while accounting for SKAdNetwork interoperability.
- Never present privacy-preserving aggregate results as deterministic installation-level attribution.
- Distinguish tracking that requires ATT from AdAttributionKit measurement that does not require ATT by itself.
- Device fingerprinting is outside the project scope.

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
