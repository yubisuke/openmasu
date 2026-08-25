# M4 Design Baseline

Status: **adopted (R-28) on 2026-08-20.** Every recommendation in the review draft is decided, and WO-8 implements this fixed design rather than redesigning it.

Repository location: `docs/design/m4-baseline.md`.

Adoption baseline: contract `0.3.1`; `main` at `7b42afd` includes M0.3, M1a, M1b, M2, and M3. The review draft was written on 2026-08-20 and adopted after M3 merged.

Decision numbering is `M4-D-01 … M4-D-32` and is identical in this document and in `m4-baseline-decisions.ja.md`. References of the form `M1 D-06` point at `docs/design/m1-baseline.md`; `M2-D-14` points at `docs/design/m2-baseline.md`; `M3-D-16` points at the M3 draft.

Acceptance criteria are numbered `M4-A-nn` (code gates) and `M4-V-n` (operator procedures) rather than the bare `A-nn` M1/M2 used, because M4 references M2's criteria by number in several places and the two sets must not be confused.

---

## Scope

### Who M4 is for

Unchanged from `docs/product-scope.md`. What changes is which half of their business they can measure. After M2 an operator can measure Android from first-party evidence and iOS not at all. M4 is the milestone after which the same operator can compute iOS cohort LTV and ROAS, and can see Apple's aggregate attribution series next to — never mixed into — the deterministic one.

### The honest headline, stated before the scope list

**On iOS there is no first-party deterministic install-attribution channel for any network other than Apple Ads, and this project will not manufacture one.**

Android gives us the Play Install Referrer: a platform-provided, server-timestamped channel that carries our own `click_id` through the store. iOS has no equivalent. The mechanisms the industry uses to fill that gap are (i) IDFA plus ATT, (ii) probabilistic device matching from IP and User-Agent, and (iii) pasteboard or deferred-deep-link matching. `docs/privacy-security.md` forbids the second outright ("Do not derive a device fingerprint from IP address, User-Agent, device configuration, network data, or similar signals"), `AGENTS.md` forbids the first by default, and the third is the second wearing a costume.

So M4's iOS attribution surface is exactly three things, and the design must say so on the first page rather than let an operator discover it in month two:

1. **Apple Ads**, deterministically, at installation level, through the AdServices attribution token (§M4-S-7). This is the only iOS channel that produces an `installation_level` attribution.
2. **SKAdNetwork and AdAttributionKit**, in aggregate, with no installation identity, through the advertiser copy of Apple's postbacks (§M4-S-1).
3. **Everything else — organic, Meta, TikTok, owned media, cross-promotion — is `unattributed` at installation level.** Not `organic`. `organic` means "required evidence shows no paid candidate" (spec, Attribution); on iOS the evidence shows only "no *Apple Ads* candidate", which is a different sentence. §M4-D-04 and handoff M4-H-2 exist because the contract cannot currently write that sentence down.

That is a smaller claim than every commercial MMP makes for iOS. It is also the only claim this project's own rules permit, and stating it plainly is the point of the milestone.

### What "usable" means for M4

After M4 an operator can:

1. measure iOS installs, sessions, custom events, purchases, and MAX ad revenue as first-party evidence, anchored on an `installation_id` that behaves exactly like the Android one;
2. compute iOS cohort LTV and retention from that evidence, which is M4a's actual product — LTV does not require attribution;
3. obtain Apple Ads campaign / ad-group / keyword / ad attribution deterministically, without ATT and without an MMP partnership, by forwarding the AdServices token to their own server;
4. receive, verify, and store the advertiser copy of SKAdNetwork and AdAttributionKit postbacks, reject replays, and read an aggregate series that is structurally incapable of being joined to the deterministic one.

### In scope for M4

- Swift SDK `sdk/ios`: installation identity, durable queue, HMAC-signed delivery, consent, collection disablement, identifier reset, on-device deletion — the same feature set and the same wire protocol as `sdk/android`.
- `install`, `session_start`, `custom_event`, `purchase`, `refund`, `ad_revenue`, `consent_changed` from iOS.
- AdServices token collection on device, server-side lookup, `adservices_context` population.
- SKAdNetwork and AdAttributionKit conversion-value updates from a versioned, bundled conversion schema.
- `packages/apple-postback`: pure SKAdNetwork concatenation-signature verification and pure AdAttributionKit JWS verification.
- Two public receiver routes in `apps/api` at Apple's fixed well-known paths, with transaction-level replay rejection.
- Aggregate reporting kept in its own metric series.
- Unity iOS bridge inside the existing `com.openmasu.sdk` UPM package.
- Apple Privacy Manifest and an App Privacy Details mapping for integrators.
- `docs/validation/m4-device-checklist.md`.

### Explicitly out of scope for M4

- **IDFA and App Tracking Transparency.** Not "deferred" — excluded by design (§M4-S-8).
- **AdAttributionKit re-engagement.** Apple gates it behind a separate impression flag (`eligible-for-re-engagement`), a separate publisher API (`AppImpression.handleTap(reengagementURL:)`, iOS 18+), and a separate developer-copy opt-in key. Contract v0.3 already restricts `adattributionkit_postback.conversion_type` to `download | redownload`, and the spec already says re-engagement is intentionally outside the work order. M4 keeps that boundary and does not set the opt-in key. Re-engagement measurement is M5 at the earliest.
- **Acting as a registered SKAdNetwork / AdAttributionKit ad network.** M4 receives the *advertiser* copy. Registering an ad network ID, signing impressions, and receiving the network copy (which alone contains losing postbacks) is a different product.
- **SKAdNetwork for Web Ads** (`source-domain`). The schema field exists; no M4 code path produces it.
- **AdAttributionKit conversion tags** (`conversionTag`, iOS 18.4+) and `AdAttributionKitConfigurations` attribution-window overrides.
- **App Attest and device integrity** — M5, exactly as Play Integrity is (§M4-S-12).
- **SDK distribution**: publishing to a package index, notarised signing, an XCFramework release. Same boundary as M2-D-31: a buildable, reproducible artifact plus a documented build.
- **Dashboard rendering of the aggregate series.** M3 does not exist yet. M4 produces the metric artifacts and the reporting rows; the screen is M3's or M5's.

### M4a / M4b split (M4-D-01)

- **M4b — server side, no Apple device required.** `packages/apple-postback`, both receiver routes, tenancy resolution, replay rejection, the aggregate worker path, the conversion-schema registry, aggregate metrics. Every acceptance criterion is a synthetic HTTP client plus generated key material, and **all of it runs on Linux** — the verification is TypeScript.
- **M4a — device side.** Swift SDK, AdServices, conversion-value updates, MAX iOS ILRD, Unity iOS bridge, sample app, simulator gate. Needs a macOS runner and Xcode.

This is the reverse of M2's ordering pressure and it matters: M2a had to land before M2b because the device had nowhere to send events. M4b depends on nothing in M4a — Apple sends postbacks to a URL, not to our SDK — so **M4b can be built and merged first, and should be**, because it is cheap, it is entirely testable on the existing CI, and it delivers a standalone operator capability (an existing iOS app can add one Info.plist key and start producing verified aggregate evidence with no SDK integration at all).

### Prerequisite state

Contract v0.3 already carries `skan_postback`, `adattributionkit_postback`, `install.adservices_context`, `producer` values `sdk-ios` and `postback:<kind>`, the `aggregate × skadnetwork|adattributionkit × aggregate` compatibility rows, and the six Apple reason codes. WO-3 stage C did that work against Apple documentation checked on 2026-08-18. This pass re-verified every one of those fields against Apple primary sources on 2026-08-20 and found the envelopes correct. It also found four things the contract cannot say; they are handoffs M4-H-1 … M4-H-4 and none of them blocks starting.

---

## Security baseline

### M4-S-1 (M4-D-03). The postback receivers, and why the signature *is* the authentication

Both receivers are **public, unauthenticated, POST endpoints at paths this project does not choose**. Apple fixes both:

| Series | Info.plist key | Path Apple POSTs to |
| --- | --- | --- |
| SKAdNetwork | `NSAdvertisingAttributionReportEndpoint` (String, `https://example.com`) | `https://example.com/.well-known/skadnetwork/report-attribution/` |
| AdAttributionKit | Xcode key "AdAttributionKit - Postback Copy URL" (String, `https://example.com`) | `https://example.com/.well-known/appattribution/report-attribution/` |

Two consequences follow, and the first one closes off a design that would otherwise be the obvious choice.

**There is no path secret and no per-tenant hostname.** Apple's own words: "The system uses only the registrable part of the domain name you provide and ignores any subdomains." So `https://t-a1b2c3.mmp.example.com` and `https://mmp.example.com` are the same endpoint to Apple, and the path is a constant. The M2 pattern — an unguessable path segment, as `max-receiver` uses (`/v1/ingest/max/<pathSecret>`) — **cannot be reproduced here.** Anyone can POST to the endpoint.

**Options**

- (a) Treat the endpoint as trusted because only Apple knows it. Impossible per the above.
- (b) Verify Apple's cryptographic signature on every postback before anything else, and treat verification as the authentication.
- (c) (b) plus a network allowlist of Apple egress ranges.

**Decided (R-28): (b).** It is not a compromise; it is a stronger control than the M2 path secret, because it is a per-message signature from a party whose public key is published, rather than a shared secret that leaks the first time a URL appears in a log. (c) is rejected because Apple publishes no postback egress range, an IP allowlist for device-originated traffic is meaningless (postbacks come from user devices, not from Apple's servers — the retry text says "the device… attempts to send the postback"), and a wrong allowlist silently drops evidence.

**The two verifications are different algorithms and must not share code.** This is the single most likely implementation error in M4b.

*SKAdNetwork* — a plain JSON body plus a detached signature over a **concatenation of a fixed ordered subset of fields joined by U+2063 INVISIBLE SEPARATOR**, UTF-8 encoded, ECDSA over NIST P-256 with SHA-256, signature base64, public key base64 X.509 SubjectPublicKeyInfo:

```
version ⁣ ad-network-id ⁣ source-identifier ⁣ app-id ⁣ transaction-id ⁣ redownload ⁣ source-app-id|source-domain ⁣ fidelity-type ⁣ did-win ⁣ postback-sequence-index     (v4.0)
version ⁣ ad-network-id ⁣ campaign-id ⁣ app-id ⁣ transaction-id ⁣ redownload ⁣ [source-app-id] ⁣ fidelity-type ⁣ did-win                                            (v3.0)
```

`redownload` and `did-win` are stringified as `"true"` / `"false"`. `source-app-id` is included **only if present in the postback**. `conversion-value` and `coarse-conversion-value` are **never** in the signature — which is why §M4-S-3's replay defence cannot rely on the signature covering the conversion value.

*AdAttributionKit* — the payload is a **compact JWS (RFC 7515)** in the `jws-string` field, header `{"alg":"ES256","kid":"…"}`, verified by RFC 7515 §5.2 with the key selected by `kid`. The top-level JSON around it carries `conversion-value`, `coarse-conversion-value`, `ad-interaction-type`, and `country-code` **outside the signature**.

Apple's published keys (base64 X.509, verified 2026-08-20):

| Purpose | `kid` | Key |
| --- | --- | --- |
| SKAdNetwork v2.1+ (no `kid`; single key) | — | `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWdp8GPcGqmhgzEFj9Z2nSpQVddayaPe4FMzqM9wib1+aHaaIzoHoLN9zW4K8y4SPykE3YVK3sVqW6Af0lfx3gg==` |
| AdAttributionKit production | `apple-cas-identifier/0` | the same string as above |
| AdAttributionKit development (E2E, Developer Mode) | `apple-development-identifier/0` | `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAELeEDzpJEP+/qRSE5hJVC1p1J0ssUnQGMzBBbvnACBok8OVGGLgxL0myrKiy6lvRtSlLRsWit87i+vftD8AEqeQ==` |
| AdAttributionKit development (developer settings) | `apple-development-identifier/1` | `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE8YzdO7eM97s/IJ25kdW5CZ3A14USE5IJ5Ha/vhWaxI6UBI1ZxCEvjrKxVluVGe6qWwF1BDFq+QHqKfH5u+wxHQ==` |

The production SKAdNetwork key and the AdAttributionKit production key are the same string. Ship all four as compiled-in constants with the fetch date in a comment; they are public keys, not secrets, and fetching them at runtime would add a boot-time network dependency to a verification path.

**The development keys are load-bearing and must be gated.** A postback signed with `apple-development-identifier/*` is a Developer Mode test postback. If a deployment accepts those in production, an operator can pollute a real aggregate series from any device with Developer Mode on. Recommendation: accept development `kid` values **only** when `OPENMASU_APPLE_ACCEPT_DEVELOPMENT_POSTBACKS=1`, default off, and record which key verified on the record. SKAdNetwork has no equivalent gate because its test path (a downloaded configuration profile) only shortens timing and still signs with the production key; the observable SKAdNetwork development marker is `source-app-id == 0`, which is evidence, not a control. Handoff M4-H-3 asks the contract for a typed place to record this.

**Acceptance:** M4-A-01, M4-A-02, M4-A-03.

### M4-S-2 (M4-D-04). Which tenant and app an unauthenticated postback belongs to

`docs/architecture.md` says the authenticated scope fixes tenant and app. A postback has no authenticated scope. Something in the payload must resolve it.

**Options**

- (a) One deployment, one app; take tenant/app from environment variables the way `max-receiver` does.
- (b) Resolve from the App Store numeric app identifier in the payload — `app-id` for SKAdNetwork, `advertised-item-identifier` for AdAttributionKit — against a control-plane registration.
- (c) A per-app hostname.

**Decided (R-28): (b).** (c) is impossible (Apple ignores subdomains). (a) is what `max-receiver` does and it is exactly the constraint M3-D-16 has to unpick — a second surface that hard-codes its scope from environment variables makes that cleanup larger, and it forecloses a second iOS app in the same deployment for no gain. (b) costs one table and one indexed lookup.

The registration is `control.apple_app_registrations` with `UNIQUE (apple_app_adam_id)` across the whole deployment. **The uniqueness is the security property**: an App Store app has exactly one owner, so two tenants claiming the same ADAM ID is a configuration error, and the unique constraint turns it into a registration-time failure rather than a run-time cross-tenant write. An unregistered ADAM ID is **not** an error to the caller: return `200` (see §M4-S-4), record an audit row with `reason_code=apple_app_not_registered`, and write nothing to the ledger. Returning an error would let a stranger enumerate which Apple apps a deployment measures.

**Acceptance:** M4-A-04.

### M4-S-3 (M4-D-05). Replay rejection, using machinery that already exists

Apple documents both identifiers as the deduplication key in the same breath:

- SKAdNetwork `transaction-id`: "A unique value for this validation; use it to deduplicate install-validation postbacks."
- AdAttributionKit `postback-identifier`: use it to detect and discard duplicates.

Apple also documents redelivery: if the device does not receive `200`, it retries the postback **up to nine times over a maximum of nine days**. So duplicates are not an attack case, they are the *normal* case, and the receiver must be idempotent to be correct, not merely to be safe.

**Options**

- (a) A new `ephemeral` dedup table with a TTL, mirroring the M2-S-3 nonce cache.
- (b) Map the Apple identifier onto `raw_record.event_id` and let M1 D-06's permanent `UNIQUE (tenant_id, app_id, producer, event_id)` constraint do it.
- (c) Both.

**Decided (R-28): (b), unmodified.** A nonce window is the wrong instrument: nonces expire, and Apple's retry window is nine days while a replayed postback is dangerous forever. The permanent constraint is already the project's answer to "the same logical event delivered twice", it already produces the right artifact (`duplicate_delivery`, not a rejection), and it needs no new table, no sweep, and no TTL to tune. A ninth-day retry and a two-year-old replay get the identical, correct treatment.

`event_id` therefore is `skan:<transaction-id>` and `aak:<postback-identifier>`. Both fit `control.identifier` (`^[A-Za-z0-9._:-]{1,128}$`) because both are UUIDs.

**The subtlety worth writing down.** SKAdNetwork 4 sends up to three postbacks per install with `postback-sequence-index` 0/1/2, and each carries a *different* `transaction-id`. They are three separate events, not one event delivered three times, and the aggregate series must count them as such. A design that keyed on install identity instead of transaction identity would silently collapse the second and third conversion windows.

**Acceptance:** M4-A-05.

### M4-S-4 (M4-D-06). Request shape, and the one place M4 must not copy M2

M2-S-4 returns `202`. `max-receiver` returns `204`. **Neither is acceptable here**: Apple retries for nine days unless it receives `200`. The receiver returns `200 OK` with an empty body.

**Options**

- (a) Verify, evaluate through `packages/attribution-core`, respond.
- (b) Verify, append one durable batch, respond `200`; the worker evaluates.
- (c) (b), but respond `200` before persisting.

**Decided (R-28): (b).** Same reasoning as M2-S-4, plus one that is specific to this surface: Apple's retry is our safety net *only if* `200` strictly implies durability. (c) turns a nine-day retry budget into silent loss on any crash between response and commit. (a) puts attribution evaluation inside a request from a user's device on a mobile network.

**The harder question is what to do with a postback that fails signature verification.** The contract models it as a first-class outcome (`signature_verified: boolean`, `unattributed/skan_signature_invalid`), so the ledger must be able to hold one. But writing to an append-only ledger on an *unauthenticated* request is a write-amplification vector.

Decided (R-28): **record verification failures durably up to a bounded quota, then audit-only.** Concretely — a per-(tenant, app) hourly quota (`OPENMASU_POSTBACK_INVALID_LEDGER_QUOTA_PER_HOUR`, default 100); inside the quota the failure becomes a real batch with `signature_verified=false` so an operator can inspect actual forged traffic and so `skan_signature_invalid` is reachable in a real deployment; beyond it, one `ledger.audit_logs` row with `outcome=failed` and a counter. Respond `200` in both cases: a signature failure is not a transport failure and retrying it nine times helps nobody.

Malformed bodies (non-JSON, missing `jws-string`, over the size cap) get `400` and no write. They will be retried for nine days; that is harmless at this volume and a `400` in a proxy log is how an operator discovers a misconfigured endpoint.

**Acceptance:** M4-A-06, M4-A-07.

### M4-S-5 (M4-D-07). Rate and size limits

Same instrument as M1 D-11 and M2-S-5: in-process token buckets, no Redis, refuse before any insert. The postback surfaces are the first public POST endpoints in the deployment, so the caps matter more than the numbers.

| Surface | Unit | Proposed default | Env variable |
| --- | --- | --- | --- |
| both postback paths | per source IP, memory only | 20 req/s, burst 100 | `OPENMASU_POSTBACK_RATE_RPS`, `_BURST` |
| both postback paths | per registered ADAM ID | 200 req/s, burst 1000 | `OPENMASU_POSTBACK_APP_RATE_RPS`, `_BURST` |
| both postback paths | body bytes | 16 KiB | `OPENMASU_POSTBACK_MAX_BYTES` |
| signature failures written to the ledger | per tenant/app per hour | 100 | `OPENMASU_POSTBACK_INVALID_LEDGER_QUOTA_PER_HOUR` |
| AdServices lookup fan-out | per app, outbound to Apple | 10 req/s, burst 50 | `OPENMASU_ADSERVICES_LOOKUP_RATE_RPS`, `_BURST` |

16 KiB is generous: a SKAdNetwork postback is a few hundred bytes and an AdAttributionKit one is a JWS of about a kilobyte. The source IP is held in memory only and never written or logged, identically to M2-S-10.

### M4-S-6 (M4-D-08). iOS SDK authentication is M2's, unchanged

The iOS SDK uses the **same** canonical signing string, the same headers, the same enrollment route, and the same per-installation credential as the Android SDK. `apps/api/src/sdk-auth.ts` already implements it:

```
openmasu-sdk-v1\n<METHOD>\n<path>\n<sdk_key_id>\n<installation_key_id or "-">\n<timestamp_ms>\n<nonce>\n<sha256-hex of raw body>
```

**No new authentication mechanism, no `sdk-ios`-specific route, no second verifier.** Every argument in M2-S-1 and M2-S-2 transfers verbatim, including the honest limit: the app-level secret ships inside the IPA and can be extracted, so HMAC buys integrity, revocability, and an authenticated `(tenant, app)` binding — not a defence against a determined attacker. App Attest is M5.

Two things are worth stating because they are the places symmetry can quietly break:

- **The canonical string must be byte-identical across three implementations** (TypeScript server, Kotlin client, Swift client). Recommendation: one checked-in JSON vector file exercised by `node --test`, the Gradle JVM test, and `swift test`. A shared vector file is cheap and it is the only thing that makes "the same protocol" mechanically true. M4-A-20.
- **`control.sdk_keys` has no `platform` column.** The M2 baseline proposed one (`platform text NOT NULL CHECK (platform IN ('android'))  -- 'ios' in M4a`); the shipped `db/schema.sql` does not have it. An iOS build and an Android build of the same app therefore share one key space with no way to say which is which, and nothing prevents an iOS-issued credential from enrolling an installation that then delivers `producer: sdk-android`. See the runtime handoff list; the fix is a nullable additive column, not a contract change.

Ed25519 (M2-S-1 option (c), rejected on Android platform-availability grounds) is genuinely available on iOS through CryptoKit's `Curve25519.Signing` from iOS 13. It is deliberately **not** adopted: a per-platform authentication scheme would mean two server verifiers, two sets of vectors, and a permanently asymmetric protocol, to buy a property the Android half cannot have. Record it as an M5 item to be taken on both platforms at once or not at all.

### M4-S-7 (M4-D-09). AdServices: who calls Apple

`AAAttribution.attributionToken()` (`class func attributionToken() throws -> String`, iOS 14.3+, `AAAttributionError` with `internalError | networkError | platformNotSupported`) returns a base64 token with a **24-hour TTL**. The token is exchanged at `POST https://api-adservices.apple.com/api/v1/` with `Content-Type: text/plain` and the raw token as the body. **No Apple credential of any kind is required** — the token is the whole authentication.

**Options**

- (a) The SDK calls Apple from the device and sends the parsed response to our server.
- (b) The SDK sends the raw token; the server calls Apple.
- (c) Both, with the server as a fallback.

**Decided (R-28): (b).** This is M2-D-11 (Meta decryption) applied to a different provider, and the decisive argument is the same one:

- **Under (a) the attribution input is a device claim.** Anyone holding the IPA can post `{"attribution": true, "campaignId": 1}` and it enters the ledger as Apple's judgment. Under (b) the input arrives at our server over TLS from `api-adservices.apple.com`. That is the difference between evidence and an assertion, and it is the difference this whole project exists to insist on.
- The raw token is retained as protected evidence, so a lookup that failed because of a server outage leaves an audit trail even though the token itself cannot be re-used after 24 hours.
- Apple's documented retry behaviour — `404` can mean "you called too soon", best practice is 5-second intervals with a maximum of 3 attempts — is a server-side policy that must not be re-implemented (differently) in Swift, Kotlin, and C#.
- `500` means Apple is down and the request should be retried later. On a device that means "hope the app is reopened"; on a server it means a bounded backoff queue.

**The honest cost of (b), stated once:** the deployment makes an outbound call to Apple, which some self-hosters will need to allow through egress policy, and a server outage longer than the token's 24-hour TTL loses Apple Ads attribution for the installs in that window. Ship `OPENMASU_ADSERVICES_LOOKUP=on|off` (default `on`; it is the only deterministic iOS channel) and `OPENMASU_ADSERVICES_ENDPOINT` so the operator checklist can point it at a recorder.

**A consequence of never calling ATT that must be written into the docs, not discovered.** Apple returns a *detailed* payload only when per-app tracking consent is **authorized**; in every other case — including `notDetermined`, which is where this project's SDK leaves every user — it returns the *standard* payload, which omits `clickDate` and `impressionDate`. Therefore `adservices_context.click_date` and `adservices_context.impression_date` **are unreachable for any deployment following this project's rules.** The fields stay in the schema (an operator who does call ATT in their own app will populate them) but no M4 code path depends on them, and `docs/privacy-security.md` should say so.

The second consequence: with no click date, Apple Ads attribution has **no server-authoritative click time**, so it is not window-evaluated. It is Apple's judgment, recorded as `method=apple_adservices, model=last_click` — structurally the same kind of claim as an imported provider judgment, and it must not be presented as first-party window-evaluated attribution.

**Acceptance:** M4-A-08, M4-A-09.

### M4-S-8 (M4-D-10). No IDFA, no ATT, no fingerprinting — enforced, not promised

The iOS SDK must never link `AppTrackingTransparency` or `AdSupport`, never reference `ASIdentifierManager`, `advertisingIdentifier`, `ATTrackingManager`, or `identifierForVendor`, and never collect a signal whose only use is matching: precise location, carrier, screen metrics, timezone offset at second granularity, installed-app probes, or the pasteboard.

**`identifierForVendor` deserves its own sentence** because it is the tempting one. It is stable across reinstalls while any app from the same vendor remains installed, and it is shared across a vendor's apps. That makes it a device-and-vendor identifier, not an installation identifier — the opposite of what `docs/privacy-security.md` says `installation_id` is ("Scoped to one app", "Resettable", "Never joined to a persistent device identifier"). Using it would make identifier reset (§M4-D-13) a lie.

**Options** for enforcing this

- (a) Documentation and code review.
- (b) A source-level deny-list test over `sdk/ios`.
- (c) (b) plus a symbol audit of the **built** binary (`nm -u` over the compiled object files) against the same list, so a transitive dependency cannot smuggle one in.

**Decided (R-28): (c).** (a) is what every SDK that ships an IDFA reader had. (b) misses a dependency. (c) is a dozen lines of shell in CI and it is the only version that is still true after someone adds a package. The same audit does double duty in §M4-S-9.

### M4-S-9 (M4-D-11). Privacy Manifest — the declaration that could break every integrator

`PrivacyInfo.xcprivacy` has four top-level keys. Two of them are a genuine decision.

**`NSPrivacyTracking` and `NSPrivacyTrackingDomains`.** Apple's behaviour, verified 2026-08-20: "If the user has not granted tracking permission through the App Tracking Transparency framework, network requests to these domains fail and your app receives an error", and `NSPrivacyTrackingDomains` may only be populated when `NSPrivacyTracking` is `true`.

Read that twice. **If this SDK declared its ingestion endpoint as a tracking domain, every integrating app that does not show an ATT prompt would find that the SDK cannot reach its own server.** For a project whose stated position is that it does not require ATT, declaring `true` would be self-defeating and would also be *false*.

**Options**

- (a) `NSPrivacyTracking = true` with the ingestion domain listed. Safe-looking, and it breaks the product.
- (b) `NSPrivacyTracking = false`, no tracking domains, with the conditions under which that is true stated in the integrator documentation.
- (c) Make it a build-time configuration the integrator chooses.

**Decided (R-28): (b), with the condition stated in bold in `sdk/ios/README.md` and in `docs/privacy-security.md`.** The SDK collects an app-scoped random `installation_id`, no advertising identifier, no cross-app data, and sends it to a server the operator runs. Under Apple's definition that is not tracking. **But the declaration is a property of the deployment, not of the source code**, and it stops being true in two cases the documentation must name:

1. the ingestion endpoint is operated by someone other than the app's own developer or publisher — that is a third party receiving user data, and the integrating app must decide its own declaration; or
2. the operator combines this data with third-party data for targeted advertising, or shares it with a data broker.

(c) is rejected because a build-time switch on this key would let an integrator flip it without understanding either branch, and the SDK's manifest cannot be right for a case the SDK cannot observe.

**`NSPrivacyAccessedAPITypes` — target: empty, proven by audit.** Apple's Required Reason categories and the symbols in each are fixed and small: `NSPrivacyAccessedAPICategoryUserDefaults` (`UserDefaults`), `…FileTimestamp` (`FileAttributeKey.creationDate`, `.modificationDate`, `URLResourceKey.creationDateKey`, `.contentModificationDateKey`, `UIDocument.fileModificationDate`, `stat`, `fstat`, `lstat`, `fstatat`, `getattrlist`, `fgetattrlist`, `getattrlistat`, `getattrlistbulk`), `…DiskSpace`, `…SystemBootTime` (`ProcessInfo.systemUptime`, `mach_absolute_time()`), `…ActiveKeyboards`.

The design avoids all of them *by construction*: no `UserDefaults` anywhere (the Android SDK's `SharedPreferences` analogue is a file, §M4-D-12); queue ordering from an explicit monotonic sequence in each record rather than a file timestamp; no disk-space check before enqueueing (bound the queue by record count and bytes we wrote ourselves); no `mach_absolute_time()` for backoff (`Date` and `DispatchTime` are not in the list — `DispatchTime.now()` uses the same clock but is not a listed symbol, which is **unverified as a safe reading** and is exactly why the audit, not the reading, is the gate).

So: **the manifest declares no accessed API types, and M4-A-24 proves it** by running the symbol audit from §M4-S-8 against Apple's exact symbol list over the built binary. If the audit finds one, the manifest declares the narrowest true reason for it (for a queue file inside the app container that is `C617.1`) and the test asserts the manifest and the audit agree. The rule that makes this robust is not "declare nothing" but **"the manifest is generated from the audit, so it cannot drift from the code"**.

`NSPrivacyCollectedDataTypes` is populated from what the SDK actually sends and is the input to the App Privacy Details mapping in `docs/`. Apple rejects manifests with custom values, so only documented type and purpose strings may appear.

**Placement, verified 2026-08-20:** for a Swift package the manifest lives at `Sources/<Target>/PrivacyInfo.xcprivacy` **and must be declared explicitly** — "Xcode doesn't recognize privacy manifest files as resources by default" — as `resources: [.process("PrivacyInfo.xcprivacy")]`. For a framework it goes at the bundle root. Since February 12, 2025 App Store Connect requires valid manifests for commonly used third-party SDKs.

**Acceptance:** M4-A-23, M4-A-24, M4-A-25.

### M4-S-10 (M4-D-12). `installation_id` storage, backup exclusion, and why not the Keychain

The requirement is M2-D-19's, restated for iOS: storage holding `installation_id` must not reappear on another device, and a fresh install must be a fresh installation.

**Options**

- (a) Keychain, with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
- (b) A file under `Library/Application Support/dev.openmasu/`, `isExcludedFromBackup = true` on the directory, `FileProtectionType.completeUntilFirstUserAuthentication`.
- (c) `identifierForVendor`.

**Decided (R-28): (b).** (c) is forbidden by §M4-S-8. (a) is the iOS idiom and it is wrong here for a specific reason: **Keychain items are not deleted when the app is deleted.** An operator's "delete the app and reinstall to test a fresh install" would return the same `installation_id`, so a reinstall would be indistinguishable from a continuing installation, and a user who deleted the app to remove their data would find it re-attached. `…ThisDeviceOnly` fixes the backup half of the problem and not the deletion half. *(Keychain persistence across app deletion is long-standing observed iOS behaviour but was **not found stated on any Apple documentation page read in this pass** — flagged as unverified, and V-3 observes it.)*

`Library/Application Support` is inside the backup set by default (only `tmp` and `Library/Caches` are excluded automatically), so the exclusion must be explicit:

```swift
var values = URLResourceValues()
values.isExcludedFromBackup = true
try directoryURL.setResourceValues(&values)
```

**The trap, and it is Apple's own warning:** "Because certain file operations can reset resource values, make sure you set an excluded file's resource values each time you save it." A one-time call at first launch is the natural implementation and it is the wrong one. The SDK re-asserts the flag on the directory after every queue segment rotation and on every launch, and **M4-A-26 asserts the flag after a write cycle, not after initialisation** — testing it at initialisation would pass on the broken implementation.

Everything persistent lives under one directory — `installation_id`, the installation credential, the queue segments, consent state, the collection-disabled flag, the conversion-schema state — so the exclusion targets one path, exactly as M2-D-19 uses one Android subtree.

`FileProtectionType.completeUntilFirstUserAuthentication` rather than `.complete`: the SDK writes from background callbacks, and under `.complete` those writes fail on a locked device. The weaker protection is a deliberate, stated trade, not an oversight.

**Acceptance:** M4-A-26, M4-A-27; V-3.

### M4-S-11 (M4-D-13). Deletion, disablement, and identifier reset

Identical in structure to M2-S-2, M2-S-12, M2-D-22, M2-D-23, and deliberately so: the same server routes, the same credential-bound authorisation (`403` when installation A's credential names installation B), the same `sdk_auth:<audit_log_id>` audit reference, the same purpose-scoped queue purge on consent withdrawal, the same reset sequence (delete first, then a new `installation_id`, then `install_type=first_install`, `install_origin=identifier_reset`).

Three iOS-specific notes:

- There is no Play Install Referrer to avoid re-reading after a reset, so M2-D-22's "referrer consumed" flag has no analogue. The AdServices token **is** the analogue and behaves the same way: after a reset the SDK must not fetch a new attribution token, because Apple would re-attribute the same acquisition to the same campaign a second time. The consumed flag lives in the same excluded directory.
- The Android SDK uses `PRAGMA secure_delete=ON` and M2-S-12 describes precisely what that does and does not mean. The same pragma applies here (§M4-D-16 keeps SQLite), and the same precise wording must be reused rather than reinvented.
- Collection disablement must be honoured **before** any initialisation, including before the AdServices token fetch and before the first `updateConversionValue` call. The Android SDK reads a manifest meta-data key for this; the iOS analogue is an `Info.plist` key (`OpenMasuCollectionEnabledDefault`, Boolean). Without it, a consent-gated app performs an Apple Ads lookup on first launch before the user has said anything.

### M4-S-12 (M4-D-14). What M4 does *not* claim

Stated once, plainly, in `docs/threat-model.md` under the new components:

- **M4 does not prevent an attacker who possesses the IPA from enrolling installations and delivering fabricated installs and events.** Identical to M2-S-13. App Attest is M5.
- **M4 cannot compute an impression-share or win-rate metric from postbacks.** Apple sends the developer only *winning* postbacks ("Developers opt in to get copies of winning postbacks"; the SKAdNetwork copy is "an exact copy of the winning install-validation postback"). Losing copies go to the registered ad network and nowhere else. So `did_win=false` should never be observed, `unattributed/postback_not_winner` is unreachable in an advertiser-copy deployment, and any denominator built from postbacks is wrong. This is handoff M4-H-3 and it is the sort of thing that gets built by accident three milestones later.
- **A verified postback proves the message came from Apple; it does not prove the install was not fabricated.** Aggregate fraud detection is not in this milestone.
- **The aggregate series and the deterministic series measure different populations and cannot be reconciled to each other.** Their difference is not a bug and must never be presented as one (§M4-D-19).

---

## Architecture

### Repository layout additions

```text
apps/
  api/                    # + POST /.well-known/skadnetwork/report-attribution/
                          # + POST /.well-known/appattribution/report-attribution/
                          # + app registration and conversion-schema routes
  worker/                 # + postback inbox drain, AdServices lookup queue
packages/
  apple-postback/         # NEW: pure SKAN concatenation verify + pure AAK JWS verify, no I/O
sdk/
  ios/                    # NEW: Swift Package — OpenMasuCore, OpenMasuAppleAds,
                          #      OpenMasuApplePostback, OpenMasuMax, Sample
  unity/com.openmasu.sdk/  # + Runtime/Plugins/iOS/, OpenMasuiOSPlatform.cs, build post-processor
docs/validation/
  m4-device-checklist.md  # NEW
```

`sdk/ios` sits outside the npm workspace globs for the same reason `sdk/android` does.

### M4-D-15. Where the receivers live

**Options:** (a) routes in `apps/api`; (b) a new `apps/postback-receiver` service; (c) `packages/apple-postback` (pure) plus routes in `apps/api`.

**Decided (R-28): (c).** The core must be a pure package regardless — that is what makes M4-A-01's synthetic vectors possible and what keeps Apple's public keys and the concatenation order in one auditable file. Given that, the shell question is placement, and unlike M2-D-14's redirector this surface has **no availability argument for a separate process**: a postback arrives long after the user has left, Apple retries for nine days, and nothing on a user's critical path depends on it. A separate service would add a Compose entry and a port to protect for no benefit. Routes in `apps/api`.

`packages/apple-postback` exports two pure functions and one discriminated result each — `verified`, `signature_invalid`, `unknown_key`, `malformed` — with no I/O, no clock, and no database, exactly like `packages/meta-install-referrer`.

### M4-D-16. Do not reuse `ledger.ingest_inbox`

`max-receiver.ts` is the closest existing shape and copying it wholesale is the obvious move. It should not be copied, for a mechanical reason: `ledger.ingest_inbox.token_mode` is `CHECK (token_mode IN ('all','event','reporting_api'))` — a MAX-specific column that a postback has no value for, so reuse would mean either widening a CHECK constraint with a meaningless value or writing a lie.

`ledger.ingest_batches` and `appendDurableBatch(pool, payloadStore, {producer, body, eventCount, receivedAt, …})` already do exactly what is needed: `producer` is a free `control.identifier` that accepts `postback:<kind>`, `sdkKeyId` and `installationKeyId` are optional, the body is envelope-encrypted into the payload store, and the drain index `(tenant_id, app_id, received_at, inbox_seq)` already exists. `event_count` is `1`.

The receiver therefore does: rate-limit → size check → parse → verify signature → resolve ADAM ID → `appendDurableBatch` with `producer = postback:skadnetwork` or `postback:adattributionkit` → `200`.

### M4-D-17. The worker path reuses `ingestRuntimeBatch` unmodified

Same decision and the same reason as M2-D-15: the shipped decision code is the code the goldens test. `makeAggregatePostbackAttribution` in `packages/attribution-core/src/evaluator.ts` already implements the whole aggregate branch — signature, winner, crowd anonymity, conversion-value-null — and already emits `subject_scope: "aggregate"` with an `aggregate:` subject reference. The worker's only job is to turn a stored postback body into a `CandidateAttempt` whose `record.event_name` is `skan_postback` or `adattributionkit_postback` and whose `payload` is the normalised envelope. **No evaluator change.** If one turns out to be needed, that is a finding to report, not a patch to slip in.

Normalisation is the whole of the mapping and it is mechanical:

| Apple | Contract field | Note |
| --- | --- | --- |
| `version` | `version` | rejected unless `3.0` or `4.0` — see M4-H-4 |
| `ad-network-id` | `ad_network_id` | |
| `source-identifier` / `campaign-id` | `source_identifier` / `campaign_id` | v4 vs v3; the schema's `allOf` already forbids mixing them |
| `app-id` | `app_id` | also the tenancy key |
| `transaction-id` | `transaction_id` and `record.event_id` | |
| `redownload`, `source-app-id`, `source-domain`, `fidelity-type`, `did-win`, `postback-sequence-index`, `conversion-value`, `coarse-conversion-value`, `country-code` | same names, snake_cased | |
| `attribution-signature` | `attribution_signature` | stored; the private key is Apple's, so nothing here is a secret |
| verification outcome | `signature_verified` | |
| `jws-string` | `jws_string` | AAK; the schema's pattern already requires three base64url segments |
| JWS claims | `postback_identifier`, `impression_type`, `ad_network_identifier`, `advertised_item_identifier`, `conversion_type`, `did_win`, `postback_sequence_index`, `source_identifier`, `publisher_item_identifier`, `marketplace_identifier` | |
| outer AAK JSON | `conversion_value`, `coarse_conversion_value`, `ad_interaction_type`, `country_code` | **outside the signature** — see M4-A-03 |
| `kid` | *(no field)* | M4-H-3 |

`occurred_at` is the receiver's `received_at` with `occurred_at_source` recorded accordingly: Apple's postback carries **no event timestamp at all**, and inventing one from the conversion window would be a fabricated time. `processing_purpose_id` is `attribution`; `producer_version` is the receiver version string.

### M4-D-18. AdServices lookup placement

**Options:** (a) synchronous inside the ingestion request; (b) a worker step reading tokens from the durable batch; (c) a separate service.

**Decided (R-28): (b).** Apple's own guidance makes (a) untenable — a `404` immediately after install is expected and the documented response is to retry at 5-second intervals up to 3 times, which is 15 seconds inside a device's HTTP request. (b) puts it where the retry budget, the backoff, and the `500` handling already belong, and it means an Apple outage delays attribution rather than failing ingestion. The lookup is bounded by the token's 24-hour TTL: a token older than 23 hours is not attempted and is recorded as unavailable.

The install record is written on arrival with the token as protected evidence and **no** `adservices_context`; the worker adds the context and supersedes the attribution when Apple answers. That reuses `supersedes_attribution_id` exactly as M2-D-16's late-click re-evaluation does, so there is one supersession mechanism in the runtime, not two.

### M4-D-19. Keeping the two series apart, mechanically

The roadmap's M4b gate is "Aggregate reporting that never mixes the aggregate series with deterministic installation-level attribution." Three layers already exist and one is new:

1. **Schema.** `subject_scope` selects the `aggregate:` / `installation:` subject namespace and the evaluator already rejects an aggregate record carrying `installation_id` with `aggregate_installation_join_forbidden`.
2. **Compatibility registry.** `aggregate × skadnetwork × aggregate` and `aggregate × adattributionkit × aggregate` are their own rows.
3. **Metric names.** `metric_name` is an open pattern with no registry (`^[a-z][a-z0-9_]{2,127}$`), so the aggregate series gets its own names — `skan_attributed_installs`, `skan_conversion_value_distribution`, `aak_attributed_installs` — rather than a `platform` dimension inside the deterministic metrics. **This is the decision**: adding a dimension would put the two series in one artifact and make "do not mix" a discipline. Separate metric names make a mixed row unconstructible. The implementation review found that the distribution still needed a typed scalar-row bucket, so additive contract patch v0.3.3 binds these three names to aggregate events and adds the closed `apple_conversion_bucket` grouping without changing any existing metric.
4. **New: a gate.** M4-A-12 asserts that no metric run's `grouping` combines an aggregate metric name with `attribution_status`, and that no metric definition references both series.

Reconciliation between the series belongs to the difference audit as a *labelled, expected* difference, never as a discrepancy to close.

### M4-D-20. The conversion-value schema

A conversion value is 6 bits whose meaning is a deployment policy. The postback carries the number; nothing carries the meaning. Whatever assigns it on device must be reproducible on the server months later, or the aggregate series is uninterpretable.

**Options**

- (a) The integrator writes Swift code that returns a number.
- (b) A versioned declarative mapping file bundled in the app and evaluated by a pure function in the SDK, with the same file registered server-side.
- (c) The SDK fetches the mapping from the server at launch.

**Decided (R-28): (b).** (a) makes the mapping unversioned and unauditable, and it guarantees that the server's decode and the client's encode drift. (c) puts a network round trip in front of the most time-critical call in the whole framework — the first `updateConversionValue`, which must happen on first launch to register the install — and a launch with no network would then register no conversion at all.

Under (b): `openmasu-conversion-schema.json` carries a `schema_version` and a list of rules over first-party event keys and cumulative revenue thresholds; the SDK evaluates it locally; the operator registers the identical file in `control.conversion_schemas`; the SDK sends the file's SHA-256 as evidence on `install` so a mismatch between the shipped app and the registered schema is *observable* rather than silent.

**No contract change.** The decode is a server-side join from `(tenant, app, schema_version, postback_sequence_index, conversion_value)` to meaning, using an append-only registry. Putting `conversion_schema_version` into the postback envelope would be wrong on its face — Apple's postback cannot know our schema version — and putting it on `install` as a typed field would be a contract change to carry a deployment-private value. The digest goes in `install.extensions`, which the contract permits for non-attribution evidence. This is a deliberate decision **not** to change the contract; it is recorded in the decisions memo so it is not re-opened.

### M4-D-21. Does the SDK report its own conversion-value updates?

The SDK calls Apple locally. Our server learns the value only when Apple's postback arrives, days later, in aggregate.

**Options:** (a) never report; (b) report as a first-party event, default on; (c) report as a first-party event, default off.

**Decided (R-28): (c)** — a `custom_event` with the reserved `event_key` `openmasu.conversion_value_updated`, gated by `conversionValueLoggingEnabled` (default `false`).

(a) makes debugging a conversion schema nearly impossible: an operator who sees no `conversion-value` in postbacks cannot tell whether the SDK never called Apple, called with 0, or was suppressed by crowd anonymity. (b) is wrong as a *default* for the reason `docs/privacy-security.md` states first: data that is never collected is the safest data. And there is a second reason specific to M4: an installation-level record of "this installation set conversion value 24 at 14:02" is precisely the join key that would let someone reconstruct installation identity from an aggregate postback. The join is impossible inside a contract artifact (§M4-D-19) but the temptation should not be created by default. Default off, documented as a diagnostic to enable while validating a schema and to disable afterwards.

### Runtime shape

No new Compose service and no new port. `api` gains two public routes; `worker` gains two steps. The default topology stays `postgres`, `migrate`, `api`, `worker`, `redirector`.

---

## Contract touchpoints

Contract v0.3's Apple envelopes were re-verified field by field against Apple primary sources on 2026-08-20. **The envelopes are correct and M4 can be built against them.** Four things the contract cannot currently express are recorded as handoffs; the first two change what a deployment can honestly report, the last two are hygiene.

### What M4 produces against contract v0.3

| Artifact | Producer | Notes |
| --- | --- | --- |
| `install` | `sdk-ios` | `referrer_status` — **the problem, see M4-H-2**; `install_type`, `install_origin`, `country`, `app_version`, `os_version`, `sdk_version`; `adservices_context` added by the worker |
| `session_start`, `custom_event`, `purchase`, `refund`, `consent_changed` | `sdk-ios` | unchanged from the Android shapes |
| `ad_revenue` | `sdk-ios` | `subject_scope=installation_level`, `revenue_source=client_estimated`, `mediation_provider=applovin-max`; the M2-D-24 mapping table verbatim |
| `skan_postback` | `postback:skadnetwork` | aggregate |
| `adattributionkit_postback` | `postback:adattributionkit` | aggregate |
| `privacy-request` | control plane | `requested_via=on_device_sdk`, as M2 |

### M4-H-1 — `adservices_context.status` has no value for Apple's most common answer

`status` is closed to `attributed | token_expired`, with `attributed ⇒ attribution=true` and `token_expired ⇒ attribution=false`.

Apple's API returns **HTTP 200 with `{"attribution": false}`** for a token that resolved perfectly well and simply is not an Apple Ads install — which on any real app is the large majority of installs. There is no `status` for it. There is also no status for "we asked and could not get an answer": `400` (invalid token), `500` (Apple down), or exhausted retries.

Today the runtime's only options are to omit `adservices_context` entirely — discarding the evidence that Apple was asked and answered, which is exactly the evidence an operator needs to know their Apple Ads coverage — or to misuse `token_expired`, which asserts something false.

**Proposal:** add `not_attributed` (requires `attribution=false`) and `lookup_unavailable` (requires `attribution=false`) to the enum, plus reason codes `adservices_not_attributed` and `adservices_lookup_unavailable`. Two enum values and two registry strings; no existing fixture changes. `not_attributed` must **not** map to `organic` — see M4-H-2.

**Severity: blocks honest iOS coverage reporting.**

### M4-H-2 — no `referrer_status` for a platform that has no referrer

`referrer_status` is required on `install` and closed to `available | third_party | none | unsupported | unavailable`. Trace the evaluator with each on an iOS install:

- `none` → `organic / no_referrer`. **False.** It asserts no paid candidate when we looked for exactly one network's candidate.
- `unsupported` → `unattributed / install_referrer / last_click / install_referrer_unsupported`. Not false, but it says an Android device-capability sentence under a method that does not exist on iOS, and it pollutes the Android diagnostic "how many devices cannot use Install Referrer" for any deployment where one `app_id` covers both platforms.

The consequence of shipping `unsupported`: every iOS install lands under `method=install_referrer`, and the organic bucket for iOS is permanently empty while the unattributed bucket is permanently 100%. The first is arguably honest; the second is arguably honest; the *method* is not.

**Proposal:** add `referrer_status = not_applicable` and reason code `platform_referrer_not_available`, mapping to `unattributed / none / none / platform_referrer_not_available`. The compatibility registry already contains `installation_level × none × none × [organic, unattributed]`, so no registry row is needed there. One enum value, one reason code, no fixture changes.

**Severity: blocks honest iOS attribution-method reporting.** Mitigation if it does not land: ship `unsupported` and document the mislabelling; the ledger is append-only and attribution is supersedable, so a later contract version can re-derive it. That makes the damage recoverable, not avoided.

### M4-H-3 — no typed place for the postback signing environment

An AdAttributionKit postback's JWS `kid` is the only reliable marker distinguishing a production postback (`apple-cas-identifier/0`) from a Developer Mode test postback (`apple-development-identifier/0` or `/1`). The contract has no field for it, so a deployment that accepts development postbacks — which it must, in order to test — cannot separate them in the ledger, and a Developer Mode session left on for two weeks silently enters production aggregates.

**Proposal:** add a closed `signing_key_environment = production | development` to `adattributionkit_postback`. The SKAdNetwork envelope needs nothing: its test path signs with the production key, and the development marker (`source-app-id == 0`) is already an existing field.

The same handoff should carry a **spec sentence** for §M4-S-12: in an advertiser-copy deployment `did_win` is always `true`, `postback_not_winner` is unreachable, and no impression-share or win-rate metric may be derived from postbacks. Two implementations reading only the schema would both build that metric.

**Severity: P1.**

### M4-H-4 — `skan_postback.version` is a two-value enum

`enum: ["3.0", "4.0"]`. Apple's `version` field is absent in v1, present from v2.0, and has taken the values `2.0`, `2.1`, `2.2`, `3.0`, `4.0`. The spec says legacy v1/v2 are outside the contract, which is a defensible scope decision — but the *runtime* behaviour of a v2.2 postback arriving is currently a generic schema-validation failure with no named reason, and a hypothetical `4.1` would be rejected identically to a forgery.

**Decided (R-28):** widen to `pattern: "^(3|4)\\.[0-9]+$"` with the v3-vs-v4 `allOf` branches keyed on the major version. The existing conditionals already handle major versions correctly, so a later supported-minor release does not require an enum edit while unknown major versions remain rejected.

**Severity: P2.**

---

## Data model additions

Same conventions as M1 and M2: `control.identifier`, `control.canonical_timestamp`, `FORCE`d RLS, append-only `*_states` plus a `*_current` view.

```sql
-- Tenancy resolution for unauthenticated postbacks (M4-S-2)
CREATE TABLE control.apple_app_registrations (
  tenant_id             control.identifier NOT NULL,
  app_id                control.identifier NOT NULL,
  apple_app_adam_id     bigint NOT NULL,      -- SKAN app-id / AAK advertised-item-identifier
  apple_bundle_id       text,
  registered_at         control.canonical_timestamp NOT NULL,
  artifact              jsonb NOT NULL,
  PRIMARY KEY (tenant_id, app_id),
  UNIQUE (apple_app_adam_id),                 -- deployment-wide: one App Store app, one owner
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);

-- Versioned conversion-value policy (M4-D-20)
CREATE TABLE control.conversion_schemas (
  conversion_schema_id  control.identifier PRIMARY KEY,
  tenant_id             control.identifier NOT NULL,
  app_id                control.identifier NOT NULL,
  schema_version        text NOT NULL,
  schema_digest         text NOT NULL CHECK (schema_digest ~ '^[a-f0-9]{64}$'),
  definition            jsonb NOT NULL,
  created_at            control.canonical_timestamp NOT NULL,
  artifact              jsonb NOT NULL,
  UNIQUE (tenant_id, app_id, schema_version),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);
-- plus control.conversion_schema_states (active | retired) and control.conversion_schemas_current

-- Pending AdServices lookups (M4-D-18); not evidence, so it lives where deletion is allowed
CREATE TABLE ephemeral.adservices_lookups (
  lookup_id             uuid PRIMARY KEY,
  tenant_id             control.identifier NOT NULL,
  app_id                control.identifier NOT NULL,
  token_ref             text NOT NULL,        -- protected object; the token itself is never a column
  install_record_id     control.identifier NOT NULL,
  attempts              integer NOT NULL DEFAULT 0,
  next_attempt_at       timestamptz NOT NULL,
  token_created_at      timestamptz NOT NULL  -- 24 h TTL is enforced against this
);

-- Runtime handoff, not a contract change (M4-S-6)
ALTER TABLE control.sdk_keys ADD COLUMN platform text CHECK (platform IN ('android','ios'));
```

`ephemeral.adservices_lookups` belongs in `ephemeral` for M2-S-3's exact reason: it needs `DELETE`, and `ephemeral` is the schema whose name says it holds no evidence. The *token* is protected evidence in the payload store and stays there; only the pointer is deletable.

### Threat-model rows

`npm run check:threat-model` requires a row per `docs/architecture.md` component. M4 adds `apple-postback-receiver` and `sdk-ios`, and extends the existing `unity-bridge` row to cover both platforms rather than adding a third bridge component.

---

## SDK design

### Swift module layout — deliberately isomorphic to `sdk/android`

```text
sdk/ios/
  Sources/
    OpenMasuCore/            # queue, delivery, HMAC signing, consent, identity — no Apple ad frameworks
      PrivacyInfo.xcprivacy #   declared as .process(...) in Package.swift
    OpenMasuAppleAds/        # AdServices token only
    OpenMasuApplePostback/   # SKAdNetwork + AdAttributionKit conversion-value updates
    OpenMasuMax/             # MAAdRevenueDelegate → ad_revenue
    OpenMasuObjC/            # extern "C" surface for the Unity bridge
  Tests/
  Sample/
  Package.swift
```

The module split is the Android split with the same rule: `OpenMasuCore` links nothing but Foundation, so an app that wants first-party LTV and no Apple ad frameworks pulls one product. `OpenMasuApplePostback` is the only module that links StoreKit and AdAttributionKit; `OpenMasuMax` is the only one that links AppLovin.

| Android | iOS | Same file, same tests |
| --- | --- | --- |
| `OpenMasuStorage.kt` | `OpenMasuStorage.swift` | identity, credential, consent, flags |
| `QueueDatabase.kt` (Room) | `OpenMasuQueue.swift` (system SQLite) | durable queue |
| `HmacHttpTransport.kt` | `HmacHttpTransport.swift` | **shared canonical-string vectors** |
| `EventFactory.kt` | `EventFactory.swift` | envelope construction |
| `Ports.kt` | `Ports.swift` | reader/transport protocols |
| `MaxRevenueAdapter.kt` | `MaxRevenueAdapter.swift` | **shared mapping table** |
| `GooglePlayReferrerReader.kt` | *(no analogue)* | §Scope |
| *(no analogue)* | `AdServicesTokenReader.swift` | §M4-S-7 |

### M4-D-22. Queue storage

**Options:** (a) Core Data; (b) system SQLite through `libsqlite3`; (c) GRDB; (d) hand-rolled append-only file segments.

**Decided (R-28): (b).** M2-D-17 rejected its own option (c) — a hand-rolled append-only file — with the sentence "reimplements crash-consistent truncation, which is where hand-rolled queues actually break". That reasoning does not become wrong on a different operating system, so (d) is out for consistency as much as for merit. (c) puts a third-party package inside an artifact that ships in other people's apps — the same supply-chain objection M2-S-1 used to reject a bundled crypto provider, and it applies harder here because an SPM dependency becomes the integrator's dependency too. (a) is a full object-graph framework with a migration model and a concurrency model far larger than a queue needs.

(b) is the option with zero dependencies and a real database. It is also the closest analogue of Room's on-disk behaviour, which lets both SDKs make **the same durability claim in the same words**: process death (SIGKILL, jetsam, force-quit) loses nothing because committed pages are in the OS page cache; abrupt power loss can lose the most recent commits under WAL with `synchronous=NORMAL`. Keep the default, document the boundary, and let M4-A-21 test the case that actually happens.

`PRAGMA secure_delete=ON` as on Android, described with M2-S-12's exact wording.

### M4-D-23. Delivery, and the honest statement about background work

**Options:** (a) `URLSessionConfiguration.background(withIdentifier:)`; (b) a foreground `URLSession` with a coalescing timer, plus a `beginBackgroundTask` grace window at backgrounding; (c) (b) plus an optional `BGAppRefreshTask` the host app opts into.

**Decided (R-28): (c), with (b) as what ships enabled by default.** A background session is the wrong tool: uploads must come from a file, a session identifier is process-global so two SDK instances or an integrator re-using the identifier is a hard failure, `isDiscretionary` lets the system defer indefinitely, and delivery requires the host app to implement `application(_:handleEventsForBackgroundURLSession:)` — a host-app change an SDK cannot make.

`BGTaskScheduler` is the honest analogue of WorkManager, and it has the same host-app dependency: identifiers must be declared in the *host's* `Info.plist` under `BGTaskSchedulerPermittedIdentifiers` and registered before `application(_:didFinishLaunchingWithOptions:)` returns. So it is offered as a documented two-line opt-in and is not required.

**The consequence must be stated rather than implied, because it is a real asymmetry with Android:** an iOS SDK cannot guarantee background drain. Events queued when the app is killed are delivered on the next launch. The durable queue is the whole answer, exactly as M2-D-18's last paragraph says for a different reason, and M4-A-21 is the proof.

### M4-D-24. Which Apple conversion API the SDK calls

Apple's interoperability page says: if integrated with both, call APIs from both. It also says SKAdNetwork bridges conversion-value updates into AdAttributionKit by mirroring the call. And crucially: the system sorts AdAttributionKit and SKAdNetwork impressions **together** and picks one winner across both frameworks.

**Options:** (a) SKAdNetwork only, relying on the bridge; (b) both, gated by `#available`; (c) AdAttributionKit only.

**Decided (R-28): (b).** (a) relies on an undertaking Apple describes but does not version, and it would leave alternative app marketplaces — which AdAttributionKit covers and SKAdNetwork does not — unmeasured. (c) abandons every device below iOS 17.4.

So: `SKAdNetwork.updatePostbackConversionValue(_:coarseValue:lockWindow:completionHandler:)` on iOS 16.1+, and `AdAttributionKit.Postback.updateConversionValue(_:coarseConversionValue:lockPostback:)` on iOS 17.4+, both driven from one evaluated schema result so the two can never disagree.

**Double counting is impossible at the source** because Apple picks one winner across both frameworks, so at most one postback family arrives per install. This should be written into the spec text alongside M4-H-3, because "we call two frameworks, do we count twice" is the first question anyone asks.

State machine, from primary sources:

- Call once on first launch **to register the install**; a launch that never calls it produces no attribution at all.
- Fine value is `0…63`; out of range is `SKANError.Code.invalidConversionValue`.
- **SKAdNetwork 4 and later: values need not increase**, and the system ignores the fine value after the first conversion window. SKAdNetwork 3 and earlier: the 24-hour timer restarts only on a value *greater* than the previous one. The SDK targets 4, so it does not implement the monotonic rule — but it must not *rely* on non-monotonicity either, because the ad network signs the ad and a v3-signed ad can still arrive.
- Windows are days 0–2 / 3–7 / 8–35, with a 24–48 h delay on the first postback and 24–144 h on the second and third. `lockWindow: true` finalises the current window immediately and ignores later updates in it.
- Under a data tier of 0 only the first postback is sent at all.

The SDK exposes `lockPostback` to the integrator rather than choosing for them, and defaults it to `false`.

### M4-D-25. MAX iOS impression-level revenue

Objective-C callback `- (void)didPayRevenueForAd:(MAAd *)ad;` / Swift `func didPayRevenue(for ad: MAAd)`. `MAAd` exposes `revenue` (Double, USD, `-1` on error), `revenuePrecision` (`"publisher_defined" | "exact" | "estimated" | "undefined"`, `""` when disabled), `networkName`, `adUnitIdentifier`, `placement`, `networkPlacement`, `format`.

**The mapping to `ad_revenue` is M2-D-24's table, unchanged**, including the `-1` drop-and-count rule, half-even scaling to integer micros, `currency=USD` with `currency_source=reported`, `mediation_provider=applovin-max`, and a client-generated UUIDv7 reused as both `impression_id` and `event_id`. Recommendation: the two SDKs share one checked-in mapping fixture so a change on one platform fails the other's test. That is the cheapest possible defence against the two SDKs' revenue numbers drifting.

The delegate **protocol name and the property used to register it** (`MAAdRevenueDelegate`, `ad.revenueDelegate = self`) could not be confirmed from AppLovin's iOS page in this pass. Handle it exactly as M2 handled `ReferrerDetails` (A-09b): the SDK compiles against the pinned AppLovin iOS SDK while conforming to the protocol and setting the property, and **the build failing is the verification** (M4-A-28). Do not assert the names in prose until that build is green.

### M4-D-26. Unity iOS packaging and the bridge

**Options:** (a) a prebuilt `.xcframework` in the UPM package; (b) Swift + Objective-C **source** under `Runtime/Plugins/iOS/` in the existing package; (c) a CocoaPods dependency added to the generated `Podfile`.

**Decided (R-28): (b), with (a) as the fallback decided by building.** This is M2-D-25 repeated with the same reasoning: `.androidlib` was chosen because it keeps Kotlin sources visible and buildable inside the Unity project, "which matters for an open-source SDK whose selling point is that you can audit it". Shipping a binary framework for iOS while shipping sources for Android would be an inconsistency with no justification. (c) reintroduces CocoaPods for integrators who have escaped it.

Unity does not consume Swift Packages, so the package vendors the same Swift sources the SPM package builds, plus a thin `OpenMasuObjC` layer. **Whether Unity 6 compiles Swift source plugins without a build post-processor setting `SWIFT_VERSION`, `CLANG_ENABLE_MODULES`, and the bridging header is unverified**; it is the exact analogue of M2-D-25's unresolved `.androidlib`-under-UPM question and gets the same treatment — WO-8's first Unity task is to build the sample and record what actually worked, falling back to (a) built in CI from the same sources.

**Callbacks:** a C function pointer registered from C# with `[MonoPInvokeCallback]`, not `UnitySendMessage`. `UnitySendMessage` requires a named GameObject to exist, is string-only, and silently no-ops if the object is renamed. The pointer is marshalled onto the Unity main thread through the **existing** `OpenMasuDispatcher.cs`, which M2b already built for the Android bridge — so the Unity layer gains a platform, not a second architecture.

**Info.plist injection:** an `OnPostProcessBuild` step using `UnityEditor.iOS.Xcode.PlistDocument` and `PBXProject` writes `NSAdvertisingAttributionReportEndpoint` and `AttributionCopyEndpoint` from UPM package settings, so an integrator does not hand-edit a generated project. Apple's current AdAttributionKit verification and advertised-app configuration pages explicitly publish the literal `AttributionCopyEndpoint`; this was rechecked on 2026-08-20.

**Privacy manifest under Unity:** whether a UPM package's `PrivacyInfo.xcprivacy` reaches the built Xcode project, or whether the post-processor must copy it, is unverified. Same resolution: build and record.

### M4-D-27. Minimum deployment target

**Options:** (a) iOS 14.3 (the AdServices floor); (b) iOS 15.0; (c) iOS 16.0; (d) iOS 17.4 (the AdAttributionKit floor).

**Decided (R-28): (c) iOS 16.0.** The `#available` gates sit at 16.1 (SKAdNetwork 4 conversion values) and 17.4 (AdAttributionKit) regardless of the floor, so (a) and (b) cost no extra branches — the argument for 16.0 is not code, it is honesty about what a deployment gets. Below 16.1 an install produces aggregate attribution with **no conversion value**, which is an aggregate series that cannot support LTV or ROAS and is therefore a configuration this milestone should not claim to support. 16.0 rather than 16.1 so that a host app whose own floor is 16.0 can still link the SDK and still get first-party measurement. (d) discards every device below iOS 17.4 for a framework that has a working fallback.

Choosing 16.0 also puts the floor at or above any plausible current-Xcode minimum, so this decision cannot be invalidated by the toolchain floor, which this pass did **not** verify.

### M4-D-28. SDK versioning

`producer` is closed and a Unity iOS app is still `sdk-ios`. Apply M2-D-27 unchanged: `producer_version` carries the **Swift core** version; `install.sdk_version` carries the **outermost** package version the integrator installed. No delimiter inside `producer_version`. The residual gap — `session_start` has no `sdk_version` — is M2's H-8 and is still open.

### M4-D-29. Distribution and SBOM

Swift Package Manager, `Package.swift` at `sdk/ios/`, `PrivacyInfo.xcprivacy` declared as `resources: [.process("PrivacyInfo.xcprivacy")]` on `OpenMasuCore`. Publishing to a package index, an XCFramework release, and code signing are **out of M4**, exactly as M2-D-31 puts Maven Central out of M2 — those are release-engineering decisions with their own credentials.

SBOM: `npm sbom` does not see SPM, and the Gradle CycloneDX plugin does not either. The SDK has **no third-party runtime dependencies by design** (§M4-D-22), so `sbom/sdk-ios.cdx.json` is generated from `Package.resolved` — which will be empty of runtime dependencies — and CI fails if the file is missing. **An empty dependency list is the strongest possible SBOM and the gate exists to prove it stays empty.**

---

## Local runtime and CI additions

### Compose and configuration

No new service. New variables, all in `.env.example` with a generator command because `npm run test:env-coverage` fails otherwise: `OPENMASU_APPLE_ACCEPT_DEVELOPMENT_POSTBACKS`, `OPENMASU_POSTBACK_MAX_BYTES`, `OPENMASU_POSTBACK_RATE_RPS`/`_BURST`, `OPENMASU_POSTBACK_APP_RATE_RPS`/`_BURST`, `OPENMASU_POSTBACK_INVALID_LEDGER_QUOTA_PER_HOUR`, `OPENMASU_ADSERVICES_LOOKUP`, `OPENMASU_ADSERVICES_ENDPOINT`, `OPENMASU_ADSERVICES_LOOKUP_RATE_RPS`/`_BURST`.

Bootstrap prints both well-known URLs alongside the admin key, the redirector URL, and the MAX template, so an operator can paste them straight into Xcode.

### M4-D-30. CI

**`runtime.yml` extended** — this is where **all of M4b** lives. Postback verification, tenancy resolution, replay, limits, and the aggregate worker are TypeScript and run on the existing Linux job. No macOS runner is involved in M4b at all.

**New `sdk-ios.yml`** on `macos-26` (generally available since 2026-02-26, Apple silicon, free for public repositories), Xcode pinned with `sudo xcode-select -s` rather than a third-party action so the repository's "only `actions/*`, pinned by SHA" rule is unchanged.

- (a) `swift test` only.
- (b) `xcodebuild test` on an iOS Simulator destination.
- (c) (b) plus a real-device farm.

**Decided (R-28): (b).** `swift test` cannot host a target that imports UIKit or StoreKit, so it cannot run the tests that matter. (c) is an operator procedure, not a code gate — the same principle as M1 D-30 and M2-D-29.

**What the Simulator cannot do, stated so nobody writes a test that silently passes:** `AAAttribution.attributionToken()` does not return a usable token, SKAdNetwork and AdAttributionKit do not produce postbacks, and StoreKit Test's SKAdNetwork support requires a real device on iOS 16.4 or later. Every Apple-side behaviour is therefore either server-side TypeScript (verified in `runtime.yml` against synthetic vectors) or operator-verified. The Simulator job verifies the queue, the transport, the signing vectors, the conversion-schema evaluation, the MAX mapping, backup exclusion, the privacy manifest, and the symbol audit.

The Unity C# shim keeps using the existing `dotnet` compile probe (M2-D-30), extended with the iOS platform class.

---

## Acceptance criteria

Written as commands and observable outcomes. The M1 D-30 principle applies: **anything requiring a real Apple device, a real App Store install, a real Apple Ads campaign, or a real MAX account is an operator procedure, never a code gate.**

### M4b — synthetic, code gates, Linux

**M4-A-01 — SKAdNetwork signature verification against generated vectors.** A P-256 key pair is generated *inside the test*; a v4.0 and a v3.0 postback are signed over the documented concatenation; both verify. Flipping one byte of any signed field, reordering two fields, substituting `"True"` for `"true"`, or replacing the separator with U+0020 each fail. A vector signed with the generated key fails against **Apple's real published key**, proving the key is actually consulted rather than the verification being a no-op. A vector with `source-app-id` absent verifies under the shortened order.

**M4-A-02 — AdAttributionKit JWS verification.** A compact JWS is generated in the test with `alg: ES256` and each of the three `kid` values; production verifies always, development verifies only when `OPENMASU_APPLE_ACCEPT_DEVELOPMENT_POSTBACKS=1` and is rejected with `development_postback_rejected` otherwise. An unknown `kid`, a two-segment JWS, an `alg: none` JWS, and an `alg: HS256` JWS whose signature is an HMAC under the public key all fail.

**M4-A-03 — unsigned fields do not become evidence.** A verified postback whose `conversion-value` (SKAdNetwork) or whose outer `conversion-value` / `country-code` (AdAttributionKit) is modified after signing still verifies — Apple does not sign them — and the test asserts that the code path *records* this rather than treating those fields as authenticated. The documentation string asserted by this test is the one an operator reads.

**M4-A-04 — tenancy resolution and enumeration.** A postback for a registered ADAM ID lands in the right tenant/app. A postback for an unregistered ADAM ID returns `200`, writes zero ledger rows, and writes one audit row. Registering an ADAM ID already registered to another tenant fails at registration with a named error. Responses for registered and unregistered IDs are byte-identical.

**M4-A-05 — replay rejection.** The same `transaction-id` delivered nine times yields one logical event and nine deliveries, eight classified `duplicate_delivery`. Three SKAdNetwork 4 postbacks with distinct `transaction-id` values and `postback-sequence-index` 0/1/2 yield **three** logical events. A different payload under the same `transaction-id` yields `event_id_conflict`.

**M4-A-06 — response codes.** Success, signature failure, and unregistered app all return `200`. A body over `OPENMASU_POSTBACK_MAX_BYTES`, a non-JSON body, and a body with no `jws-string` return `400` with no ledger write. A forced database failure returns `500` so Apple's retry can recover it. `curl -w '%{time_total}'` is under 0.2 s on the success path.

**M4-A-07 — invalid-signature quota.** With the quota set to 3, the first three forged postbacks produce ledger batches with `signature_verified=false`; the fourth through hundredth produce audit rows only; all one hundred return `200`; the counter reads 100.

**M4-A-08 — AdServices lookup policy.** Against a local fake: `200 {"attribution":true,…}` populates `adservices_context` and supersedes the attribution to `adservices_attributed`; `404` is retried at 5-second intervals a maximum of 3 times before being recorded as unavailable; `500` backs off and is retried later; `400` is terminal; a token older than 23 hours is never attempted. **No Apple credential appears anywhere in the request.**

**M4-A-09 — the token never becomes a claim.** A batch whose `install` payload carries a *parsed* AdServices response rather than a token is rejected; only the raw token is accepted, and it is stored as a protected object, never as a column.

**M4-A-10 — evaluator untouched.** Every aggregate outcome — `skan_postback_verified`, `skan_signature_invalid`, `crowd_anonymity_suppressed`, `conversion_value_null` — is produced end to end through `ingestRuntimeBatch` with **zero changes** to `packages/attribution-core`. `git diff --stat -- packages/attribution-core/` is empty for WO-8b.

**M4-A-11 — aggregate never carries installation identity.** A postback record with an injected `installation_id` is rejected with `aggregate_installation_join_forbidden`. Every attribution produced by the postback path has `subject_scope=aggregate` and a `subject_ref` matching `^aggregate:`.

**M4-A-12 — the two series cannot be mixed.** No metric definition references both an aggregate metric name and a deterministic one; no metric run groups an aggregate metric by `attribution_status`; a test that constructs such a definition fails at definition time with a named error.

**M4-A-13 — contract gate untouched.** `npm run validate` prints its unchanged summary line and `git diff --stat -- fixtures/` is empty. (If the M4-H handoffs land first, the line changes exactly once, in the contract work order, never in WO-8.)

**M4-A-14 — configuration and threat-model coverage.** `npm run test:env-coverage` and `npm run check:threat-model` pass with the new components.

### M4a — synthetic, code gates, macOS Simulator

**M4-A-20 — cross-implementation signing parity.** One checked-in vector file of `(method, path, sdk_key_id, installation_key_id, timestamp_ms, nonce, body)` tuples with expected canonical strings and HMACs is consumed by `node --test`, the Gradle JVM test, and `swift test`. All three produce byte-identical canonical strings. Adding a vector without updating all three fails all three.

**M4-A-21 — queue survives process death.** 1,000 events enqueued with the network unavailable; the child process holding the database is killed with `SIGKILL`; on restart exactly 1,000 events are present with no duplicates. Repeated with the kill during a write. The documented boundary (M4-D-22: power loss is not covered) is stated in the test's own comment.

**M4-A-22 — consent, disablement, and reset.** The M2 A-15 and A-17 assertions, transliterated: withdrawal purges exactly the consent-required purposes and delivers `consent_changed`; `setCollectionEnabled(false)` performs **no** network call and **no** AdServices token fetch, asserted by a strict fake that fails the test on any call; the `Info.plist` default-disabled key is honoured before `initialize()`; reset issues the deletion request first, produces a new `installation_id`, does not re-fetch an attribution token, and emits `install_type=first_install` with `install_origin=identifier_reset`.

**M4-A-23 — privacy manifest exists and is well-formed.** `PrivacyInfo.xcprivacy` is present in the built product; it parses; `NSPrivacyTracking` is `false`; `NSPrivacyTrackingDomains` is absent.

**M4-A-24 — the manifest matches the binary.** `nm -u` over the built objects finds none of Apple's Required Reason symbols (the file-timestamp, disk-space, boot-time, active-keyboard, and `UserDefaults` lists, checked in as a constants table). If any is found, the test fails unless the manifest declares that exact category with a reason. **This test, not the manifest file, is the source of truth.**

**M4-A-25 — forbidden symbols.** The same audit finds no `ASIdentifierManager`, `advertisingIdentifier`, `ATTrackingManager`, `identifierForVendor`, `UIPasteboard`, or `CLLocationManager`, and `sdk/ios` links neither `AdSupport` nor `AppTrackingTransparency`.

**M4-A-26 — backup exclusion survives a write cycle.** After initialisation, ten queue segment rotations, and one credential rewrite, the SDK directory still reports `isExcludedFromBackup == true`. The assertion is made **after** the write cycle, because Apple documents that file operations can reset the value.

**M4-A-27 — nothing persists outside the excluded directory.** After an end-to-end run the app container is listed and every SDK-written file is under the one excluded path. No `UserDefaults` domain contains an SDK key.

**M4-A-28 — MAX and AdServices symbols exist.** `sdk/ios` compiles while conforming to the AppLovin revenue delegate protocol, assigning the revenue delegate, and reading every `MAAd` property in the mapping table; and while calling `AAAttribution.attributionToken()`, `SKAdNetwork.updatePostbackConversionValue(_:coarseValue:lockWindow:completionHandler:)`, and `AdAttributionKit.Postback.updateConversionValue(_:coarseConversionValue:lockPostback:)` under their `#available` gates. **The build is the verification** for every name this pass could not confirm.

**M4-A-29 — MAX mapping parity.** The shared mapping fixture from M4-D-25 produces byte-identical `ad_revenue` payloads from the Kotlin and Swift adapters. `revenue == -1` produces no event and increments a counter. Each precision value round-trips.

**M4-A-30 — conversion schema is a pure function.** A table of schema versions × event sequences produces a fixed `(fineValue, coarseValue, lockPostback)` triple; a fine value outside `0…63` is rejected before the Apple call; the schema digest reported on `install` equals the SHA-256 of the bundled file; a schema whose version is not registered server-side produces a named operational error and **not** a silent default.

**M4-A-31 — conversion-value logging is off by default.** With default configuration no `openmasu.conversion_value_updated` event is produced; with it enabled exactly one is produced per update.

**M4-A-32 — Unity bridge round trip.** A C# call reaches Swift and a Swift callback raised on a background queue reaches C# with intact values, observed on the Unity main thread; 10,000 round trips leak nothing (asserted by an allocation counter); the post-processor writes both Info.plist keys into a generated project fixture.

**M4-A-33 — SBOM.** `sbom/sdk-ios.cdx.json` exists and its runtime dependency list is empty; CI fails if the file is missing or the list is non-empty.

### Operator-verified — `docs/validation/m4-device-checklist.md`, not code gates

Recording a dated pass/fail summary and an opaque private reference is the deliverable; values, campaign identifiers, and payloads stay outside the public repository, exactly as `docs/validation/real-data-checklist.md` requires.

**M4-V-1 — AdAttributionKit Developer Mode (the roadmap M4b evidence gate).** With Developer Mode on (Settings → Developer → Ad Attribution Testing, iOS 18+, production Apple ID, auto-off after two weeks), configure Development Postbacks with a bundle ID and the deployment URL and transmit. Confirm a verified postback with `kid = apple-development-identifier/0`, one aggregate attribution, and rejection when the development flag is off. Record the observed windows (documented as 0–3 / 3–6 / 6–9 minutes with a 5–10 minute delay).

**M4-V-2 — SKAdNetwork with a downloaded test profile (the roadmap M4b evidence gate).** With the test profile installed and a production Apple Account, confirm a real postback arrives at the well-known path, verifies against Apple's production key, and dedupes when redelivered. Record the observed `version`, whether `source-app-id` was `0`, the observed data tier effects, and — the open question — **whether the developer copy includes the second and third conversion-window postbacks or only the first**.

**M4-V-3 — identity, backup, and reinstall.** Delete and reinstall the app: confirm a **new** `installation_id`. Back up to iCloud and restore onto a second device: confirm the `installation_id`, credential, and queue are **not** restored. Repeat with Quick Start device-to-device transfer. Record OS versions.

**M4-V-4 — Apple Ads live campaign (the roadmap M4a evidence gate).** With one live Apple Ads campaign, confirm the token resolves server-side and the returned `campaignId` reconciles privately against Apple Ads reporting. Record which payload shape arrived (**expected: standard, without `clickDate`**, since the SDK never requests ATT), the observed `404` retry behaviour, and the attribution coverage rate.

**M4-V-5 — App Store review.** Submit the sample app. Record whether the privacy manifest and App Privacy Details passed review unchanged, and any reviewer question about `NSPrivacyTracking = false`. **This is the real test of §M4-S-9** and no synthetic gate can substitute for it.

**M4-V-6 — MAX live account on iOS.** Confirm the client revenue callback fires on every enabled format, record the precision distribution, and record the difference between client ILRD totals and the S2S series for the same UTC day.

**M4-V-7 — Unity iOS export.** Export the sample from a UPM reference on each supported Unity version. Record whether Swift source plugins compiled without a post-processor, whether the package's `PrivacyInfo.xcprivacy` reached the built project, and **the literal AdAttributionKit postback-copy Info.plist key** as observed in the generated file.

**M4-V-8 — series separation in practice.** Over four weeks with both series live, record the ratio of aggregate to deterministic installs and confirm that no report presents a number derived from both. A rising unexplained gap is an input to M5, not a bug to close.

---

## Decided design

| # | Decision | Decided (R-28) |
| --- | --- | --- |
| M4-D-01 | M4a / M4b split and ordering | M4b first (Linux-only, standalone operator value); M4a second (macOS toolchain) |
| M4-D-02 | What M4 claims for iOS | Apple Ads deterministic; SKAN/AAK aggregate; everything else `unattributed`, never `organic` |
| M4-D-03 | Postback endpoint authentication | Apple's signature *is* the authentication; no path secret is possible; development `kid` gated off by default (M4-S-1) |
| M4-D-04 | Tenancy for an unauthenticated postback | Resolve the App Store ADAM ID against `control.apple_app_registrations`, unique deployment-wide (M4-S-2) |
| M4-D-05 | Replay rejection | `transaction-id` / `postback-identifier` → `event_id`; the existing permanent unique constraint, no new TTL cache (M4-S-3) |
| M4-D-06 | Response and failure shape | `200` on anything durably handled (Apple retries 9× over 9 days otherwise); bounded ledger quota for signature failures (M4-S-4) |
| M4-D-07 | Rate and size limits | In-process buckets, 16 KiB cap, memory-only IP (M4-S-5) |
| M4-D-08 | iOS SDK authentication | M2's scheme unchanged; shared canonical-string vectors across three languages; no Ed25519 asymmetry (M4-S-6) |
| M4-D-09 | AdServices lookup location | Device sends the raw token, **server** calls Apple; parsed device responses are refused (M4-S-7) |
| M4-D-10 | IDFA / ATT / fingerprinting | Excluded by design; enforced by a built-binary symbol audit, not by review (M4-S-8) |
| M4-D-11 | Privacy Manifest | `NSPrivacyTracking = false`, no tracking domains, conditions documented; accessed-API list generated from the audit (M4-S-9) |
| M4-D-12 | Identity storage | File under `Application Support`, backup exclusion re-asserted after every write; **not** Keychain, **not** `identifierForVendor` (M4-S-10) |
| M4-D-13 | Deletion, disablement, reset | M2's routes and semantics unchanged; the AdServices token is the "consumed" analogue of the Play referrer (M4-S-11) |
| M4-D-14 | What M4 does not claim | No fabricated-install defence; **no win-rate metric is derivable** from advertiser-copy postbacks (M4-S-12) |
| M4-D-15 | Receiver placement | `packages/apple-postback` (pure) + routes in `apps/api`; no new service |
| M4-D-16 | Durable write path | `ledger.ingest_batches` via `appendDurableBatch`; do **not** reuse `ledger.ingest_inbox` |
| M4-D-17 | Worker path | Reuse `ingestRuntimeBatch` and `makeAggregatePostbackAttribution` unmodified; normalisation only |
| M4-D-18 | AdServices lookup shape | Worker step with Apple's documented retry policy; supersede the attribution when Apple answers |
| M4-D-19 | Series separation | Separate metric names, not a dimension; plus a gate that makes a mixed definition unconstructible |
| M4-D-20 | Conversion-value schema | Versioned bundled JSON + server-side registry + digest as evidence; **deliberately no contract change** |
| M4-D-21 | Reporting conversion-value updates | `custom_event` with a reserved key, **default off** |
| M4-D-22 | Queue storage | System SQLite through `libsqlite3`; zero dependencies; same durability sentence as Android |
| M4-D-23 | Delivery | Foreground session + coalescing timer + background-task grace window; optional host-opt-in `BGAppRefreshTask`; no background session |
| M4-D-24 | Which Apple conversion API | Both, `#available`-gated; one winner across frameworks means no double count |
| M4-D-25 | MAX iOS ILRD | M2-D-24's mapping table verbatim, shared fixture; names verified by compiling |
| M4-D-26 | Unity iOS packaging | Swift + ObjC **source** in the existing UPM package; function-pointer callbacks through the existing dispatcher; `.xcframework` fallback decided by building |
| M4-D-27 | Minimum deployment target | iOS 16.0, gating 16.1 and 17.4 |
| M4-D-28 | SDK versioning | `producer_version` = Swift core, `install.sdk_version` = outermost package; no string pipe |
| M4-D-29 | Distribution and SBOM | SPM in-repo; publishing and signing out of M4; empty-dependency SBOM as a gate |
| M4-D-30 | CI | M4b entirely on Linux in `runtime.yml`; `sdk-ios.yml` on `macos-26` with `xcodebuild test` |
| M4-D-31 | Data model | `apple_app_registrations`, `conversion_schemas`, `ephemeral.adservices_lookups`, nullable `sdk_keys.platform` |
| M4-D-32 | Acceptance numbering and boundaries | `M4-A-nn` / `M4-V-n`; anything needing a real device, campaign, or App Store install is an operator procedure |

---

## Handoffs

### To the contract (recommended before WO-8a; WO-8b needs none of them)

| # | Severity | Item |
| --- | --- | --- |
| M4-H-1 | **Blocks honest iOS coverage reporting** | `adservices_context.status` is closed to `attributed \| token_expired` and cannot express Apple's `200 {"attribution": false}` — the majority answer — or a failed lookup. Add `not_attributed` and `lookup_unavailable` (both requiring `attribution=false`) plus reason codes `adservices_not_attributed` and `adservices_lookup_unavailable`. Two enum values, two registry strings, no fixture changes. |
| M4-H-2 | **Blocks honest iOS attribution-method reporting** | `referrer_status` has no value for a platform with no referrer channel. `none` asserts `organic`, which is false; `unsupported` routes every iOS install through `method=install_referrer` and pollutes the Android device-capability diagnostic. Add `referrer_status = not_applicable` and reason `platform_referrer_not_available` mapping to `unattributed / none / none`. The compatibility row already exists. |
| M4-H-3 | P1 | `adattributionkit_postback` has no field for the JWS `kid`, so a Developer Mode test postback is indistinguishable from a production one in the ledger. Add a closed `signing_key_environment = production \| development`. In the same change, add the spec sentence that in an advertiser-copy deployment `did_win` is always `true`, `postback_not_winner` is unreachable, and **no impression-share or win-rate metric may be derived from postbacks** — verified from Apple: developers receive copies of winning postbacks only. |
| M4-H-4 | P2 | `skan_postback.version` is `enum ["3.0","4.0"]`; Apple's field has taken `2.0 … 4.0` and could take `4.1`. The existing `allOf` branches already key on the major version. Widen to `pattern: "^(3\|4)\\.[0-9]+$"`, or add a named rejection reason for an unsupported postback version. |

### To the runtime and the repository (not contract changes)

| Target | Change | Why |
| --- | --- | --- |
| `db/schema.sql` — `control.sdk_keys` | Add nullable `platform text CHECK (platform IN ('android','ios'))` | The M2 baseline specified this column; the shipped DDL does not have it. Without it an iOS-issued key can enroll an installation that delivers `producer: sdk-android`, and per-platform key rotation is impossible. Nullable and additive, so no backfill and no behaviour change for existing rows. |
| `db/schema.sql` — `ledger.ingest_inbox` | Leave alone | Its `token_mode` CHECK is MAX-specific. M4-D-16 uses `ledger.ingest_batches` instead. Recorded so WO-8 does not copy `max-receiver.ts` wholesale and then widen a CHECK constraint with a meaningless value. |
| `docs/design/m2-baseline.md` | Correct two data-model statements | The document specifies `control.sdk_keys.platform` and a `control.installation_keys` table holding a plaintext `installation_id`. The shipped schema has neither: there is no `platform` column, and the table is `control.installation_credentials` with an HMAC `installation_id_digest`. The shipped design is **better** and M4 follows it; the baseline text should be corrected so the next milestone does not reintroduce a plaintext identifier column from a design document. |
| `docs/architecture.md` | Add `apple-postback-receiver` and `sdk-ios` component identifiers; extend `unity-bridge` to both platforms; document both well-known routes | `check:threat-model` fails without matching rows |
| `docs/privacy-security.md` — Apple section | State: the SDK never calls ATT and therefore always receives Apple's **standard** AdServices payload, so `click_date` / `impression_date` are unreachable; `NSPrivacyTracking = false` and the two conditions under which it stops being true; why the Keychain is not used for `installation_id` | These are the statements an integrator needs before shipping, and two of them are non-obvious |
| `docs/roadmap.md` M4 | State that M4b's evidence gate is met by Apple's *testing* procedures (Developer Mode, downloaded profile) and that live-campaign evidence stays operator-recorded | Keeps milestone names byte-identical across roadmap, project-plan, privacy-security, threat-model |
| `docs/project-plan.md` Phase 4 | Keep the crosswalk in step | `AGENTS.md` |
| `docs/references.md` | Add the AdAttributionKit, AdServices, privacy-manifest, and SKAdNetwork verification pages with 2026-08-20 dates | The current Apple section has four links and none of the pages M4 depends on |

### To M5

- App Attest, alongside Play Integrity (§M4-S-12).
- Ed25519 client credentials, taken on both platforms at once or not at all (§M4-S-6).
- AdAttributionKit re-engagement and conversion tags.
- Acting as a registered ad network, which is the only way to see losing postbacks.
- Aggregate-series fraud signals.

---

## References

All Apple URLs fetched and checked on **2026-08-20** through `https://developer.apple.com/tutorials/data/documentation/….json`, because the rendered pages return only a title to automated fetching. Items marked **unverified** are stated as unverified and are never the basis for a design that would break if they turn out otherwise.

| Topic | URL | What was confirmed |
| --- | --- | --- |
| SKAdNetwork postback parameters | `https://developer.apple.com/documentation/storekit/identifying-the-parameters-in-install-validation-postbacks` | Exact keys and versions: `version` (2+), `ad-network-id` (1+), `attribution-signature` (2+), `app-id`, `source-identifier` (4+, 2–4 digits), `campaign-id` (1–3), `source-app-id` (2+), `source-domain` (4+, web only), `conversion-value` (2+, 6-bit), `coarse-conversion-value` (4+, `low`/`medium`/`high`), `did-win` (3+), `fidelity-type` (2.2+, `0` view-through / `1` StoreKit-rendered), `postback-sequence-index` (4+, 0/1/2), `redownload` (2+), `transaction-id` (1+), `country-code`. `transaction-id` is "a unique value for each validation; use it to deduplicate". Conversion values are **not** in the signature and are mutually exclusive. Postback data tier governs `source-identifier` digits, both conversion values, `source-app-id`, `source-domain`, `country-code`. |
| SKAdNetwork signature verification | `https://developer.apple.com/documentation/storekit/verifying-an-install-validation-postback` | Separator `'⁣'`; UTF-8; ECDSA P-256 with SHA-256; base64 signature; base64 X.509 public key `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWdp8GPcGqmhgzEFj9Z2nSpQVddayaPe4FMzqM9wib1+aHaaIzoHoLN9zW4K8y4SPykE3YVK3sVqW6Af0lfx3gg==` for v2.1+. v4.0 order verbatim; `redownload`/`did-win` as `"true"`/`"false"`; `source-app-id` included only when present; losing postbacks omit it. Respond `200 OK` or the device retries up to nine times over nine days. |
| SKAdNetwork conversion windows | `https://developer.apple.com/documentation/storekit/receiving-postbacks-in-multiple-conversion-windows` | Windows days 0–2 / 3–7 / 8–35. First postback delay 24–48 h; second and third 24–144 h. Fine conversion value only in the first window. Tier 3/2 fine, Tier 1 coarse, Tier 0 first postback only and `source-identifier` 2 digits. `lockWindow` finalises immediately and ignores later updates in that window. |
| SKAdNetwork conversion-value API | `https://developer.apple.com/documentation/storekit/skadnetwork/updatepostbackconversionvalue(_:coarsevalue:lockwindow:completionhandler:)` | iOS 16.1+. `fineValue` 0–63, else `SKANError.Code.invalidConversionValue`. **SKAdNetwork 4+: values need not increase**, and the fine value is ignored after the first window. SKAdNetwork ≤3: the 24-hour timer restarts only on a greater value. Call on first launch to register the install. |
| SKAdNetwork advertised-app configuration | `https://developer.apple.com/documentation/storekit/configuring-an-advertised-app` | `NSAdvertisingAttributionReportEndpoint`, String, `https://example.com`. Apple POSTs to `https://example.com/.well-known/skadnetwork/report-attribution/`. "The system uses only the registrable part of the domain name you provide and ignores any subdomains." Valid SSL certificate required. Developers opt in to copies of **winning** postbacks. |
| AdAttributionKit postback parameters | `https://developer.apple.com/documentation/adattributionkit/identifying-the-parameters-in-a-postback` | Top level `jws-string`, `ad-interaction-type` (`view`/`click`), `country-code`, optional `conversion-value`, `coarse-conversion-value`. JWS header `{"kid": …, "alg": "ES256"}`. Claims `postback-identifier` (UUID), `impression-type` (`app-impression`), `ad-network-identifier`, `advertised-item-identifier`, `conversion-type` (`download`/`redownload`/`re-engagement`), `did-win`, `postback-sequence-index`, optional `publisher-item-identifier`, `marketplace-identifier`, `source-identifier`. There is **no** `version`, `attribution-signature`, `redownload`, or `source-domain` field. |
| AdAttributionKit verification | `https://developer.apple.com/documentation/adattributionkit/verifying-a-postback` | Compact JWS per RFC 7515 §5.2, NIST P-256, key selected by `kid`. `apple-cas-identifier/0` (production, same key string as SKAdNetwork), `apple-development-identifier/0`, `apple-development-identifier/1` with the two development keys quoted in §M4-S-1. Reject any postback that fails verification. Deduplicate on `postback-identifier`. Retries up to nine times over nine days on a `500`. |
| AdAttributionKit advertised-app configuration | `https://developer.apple.com/documentation/adattributionkit/configuring-an-advertised-app` | Apple POSTs to `https://example.com/.well-known/appattribution/report-attribution/` — a **different** path from SKAdNetwork's. The key is added in Xcode as "AdAttributionKit - Postback Copy URL" (String) with a separate Boolean "AdAttributionKit - Opt in for Reengagement Postback Copies". Winning postbacks only. When using both frameworks, both Info.plist keys are required. |
| AdAttributionKit Developer Mode | `https://developer.apple.com/documentation/adattributionkit/testing-adattributionkit-with-developer-mode` | Settings → Developer → Ad Attribution Testing → AdAttributionKit Developer Mode, iOS 18+, production Apple ID, auto-off after two weeks. Windows become 0–3 / 3–6 / 6–9 minutes and the delay 5–10 minutes. Development postbacks are signed with `apple-development-identifier/0`. Development impressions are marked by publisher item identifier `0` (AdAttributionKit) and source App Store identifier `0` (SKAdNetwork). Postbacks route through a configured Wi-Fi HTTP proxy. |
| AdAttributionKit / SKAdNetwork interoperability | `https://developer.apple.com/documentation/adattributionkit/adattributionkit-skadnetwork-interoperability` | Call APIs from both when integrated with both. SKAdNetwork conversion-value calls are mirrored into AdAttributionKit. Impressions from both frameworks are sorted together and **one** winner is chosen. |
| AdServices attribution token | `https://developer.apple.com/documentation/adservices/aaattribution/attributiontoken()` | `class func attributionToken() throws -> String`, iOS 14.3+, macOS 11.1+. 24-hour TTL. `POST https://api-adservices.apple.com/api/v1/`, `Content-Type: text/plain`, raw token body, **no credential**. Response keys `attribution`, `orgId`, `campaignId`, `conversionType`, `claimType`, `adGroupId`, `countryOrRegion`, `keywordId`, `adId`, `supplyPlacement`, plus `clickDate`/`impressionDate` in the detailed payload only. `400` invalid token; `404` not found or TTL exceeded, retry at 5-second intervals up to 3 times; `500` retry later. **The detailed payload is returned only when per-app tracking consent is authorized**; otherwise the standard payload, without `clickDate` / `impressionDate`. |
| Privacy manifest — tracking | `https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacytrackingdomains` | `NSPrivacyTracking` Boolean, `NSPrivacyTrackingDomains` array of strings, iOS 17+. "If the user has not granted tracking permission through the App Tracking Transparency framework, network requests to these domains fail and your app receives an error." Domains may be listed only when `NSPrivacyTracking` is `true`. |
| Privacy manifest — required reason APIs | `https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacyaccessedapitypes/nsprivacyaccessedapitype` | Categories and their symbols: `…FileTimestamp` (`FileAttributeKey.creationDate`, `.modificationDate`, `UIDocument.fileModificationDate`, `URLResourceKey.contentModificationDateKey`, `.creationDateKey`, `getattrlist`, `getattrlistbulk`, `fgetattrlist`, `stat`, `fstat`, `fstatat`, `lstat`, `getattrlistat`; reasons `DDA9.1`, `C617.1`, `3B52.1`, `0A2A.1`), `…SystemBootTime` (`ProcessInfo.systemUptime`, `mach_absolute_time()`; `35F9.1`, `8FFB.1`, `3D61.1`), `…DiskSpace` (`…volumeAvailableCapacity*`, `volumeTotalCapacityKey`, `FileAttributeKey.systemFreeSize`, `.systemSize`, `statfs`, `statvfs`, `fstatfs`, `fstatvfs`, `getattrlist`, `fgetattrlist`, `getattrlistat`; `85F4.1`, `E174.1`, `7D9E.1`, `B728.1`), `…ActiveKeyboards` (`UITextInputMode.activeInputModes`; `3EC4.1`, `54BD.1`), `…UserDefaults` (`UserDefaults`; `CA92.1`, `1C8F.1`, `C56D.1`, `AC6B.1`). |
| Privacy manifest — placement | `https://developer.apple.com/documentation/bundleresources/adding-a-privacy-manifest-to-your-app-or-third-party-sdk` | Framework bundle root on iOS; `Sources/<Target>/PrivacyInfo.xcprivacy` for a Swift package, and "Xcode doesn't recognize privacy manifest files as resources by default" — declare `resources: [.process("PrivacyInfo.xcprivacy")]`. One manifest per platform variant in an XCFramework. Since 2025-02-12 App Store Connect requires valid manifests for commonly used third-party SDKs. |
| iCloud backup and exclusion | `https://developer.apple.com/documentation/foundation/optimizing-your-app-s-data-for-icloud-backup` | `tmp` and `Library/Caches` are excluded by default; other container directories are not. Exclude with `URLResourceValues.isExcludedFromBackup` via `setResourceValues`. "Because certain file operations can reset resource values, make sure you set an excluded file's resource values each time you save it." |
| AppLovin MAX ILRD (iOS) | `https://support.applovin.com/en/max/ios/overview/advanced-settings` | `didPayRevenueForAd:` / `didPayRevenue(_:)`. `ad.revenue` in USD with `-1` on error; `ad.revenuePrecision` in `"publisher_defined" \| "exact" \| "estimated" \| "undefined"` or `""`; `ad.networkName`, `ad.adUnitIdentifier`, `ad.placement`, `ad.networkPlacement`, `ad.format`. The delegate **protocol name and the registration property are not stated in this section — unverified**. |
| GitHub Actions macOS runners | `https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/` | `macos-26` generally available since 2026-02-26, Apple silicon by default, multiple Xcode 26.x toolchains preinstalled and selectable with `xcode-select`. |

Repository facts used as premises, read on 2026-08-20 from `main` at `e5df088`:

- `apps/api/src/sdk-auth.ts` — `sdkCanonicalString` is the exact eight-line string reproduced in §M4-S-6; `installationIdDigest` is an HMAC over `tenant\0app\0installation_id`.
- `apps/api/src/max-receiver.ts` — the existing verify → one durable insert → respond shape, and the `ledger.ingest_inbox` write it uses.
- `apps/runtime/src/ingest-batch.ts` — `appendDurableBatch` takes a free-form `producer`, optional key identifiers, and enforces `1 ≤ event_count ≤ 100`.
- `packages/attribution-core/src/evaluator.ts` — `makeAggregatePostbackAttribution` already implements the whole aggregate branch, and `adservices_context.status` is read at two places only.
- `db/schema.sql` — `control.sdk_keys` has **no** `platform` column; the credential table is `control.installation_credentials` with `installation_id_digest`; `ledger.ingest_inbox.token_mode` is `CHECK (token_mode IN ('all','event','reporting_api'))`; `ledger.ingest_batches` has the drain index M4-D-16 relies on; `control.identifier` is `^[A-Za-z0-9._:-]{1,128}$`.
- `schemas/events/skan-postback.schema.json`, `adattributionkit-postback.schema.json`, `install.schema.json` — the field sets quoted throughout §Contract touchpoints.
- `registries/compatibility-v0.4.json` — contains `installation_level × none × none × [organic, unattributed]`, so M4-H-2 needs no compatibility row.
- `sdk/android/` and `sdk/unity/com.openmasu.sdk/` — the module layout and `OpenMasuDispatcher.cs` that M4a mirrors and reuses.
- `.github/workflows/sdk-android.yml` — the CI shape `sdk-ios.yml` follows, including SHA-pinned `actions/*` only.

## Not verified

Stated as unverified rather than assumed. None of these blocks starting WO-8, and each one names how it gets settled.

The former plist-key uncertainty is resolved: Apple primary documentation now explicitly names `AttributionCopyEndpoint` (rechecked 2026-08-20).

1. **Whether the developer copy includes the second and third SKAdNetwork 4 conversion-window postbacks or only the first.** Apple says only that developers receive copies of *winning* postbacks. If only the first arrives, the aggregate series has no window-2/3 coarse values and the operator's expectations must be set accordingly. M4-V-2 observes it.
2. **The exact AdServices response key list.** `developer.apple.com` documents the token API but not a structured response schema; the key list here comes from Apple's own example plus `ads.apple.com` help pages. Confirmed by M4-V-4 against a live token.
3. **The documented meaning of `attribution: false`.** No primary definition was found. The design treats it as "not an Apple Ads install" and deliberately does **not** treat it as organic (M4-H-2).
4. **Whether Unity compiles Swift source plugins without a build post-processor**, and whether a UPM package's `PrivacyInfo.xcprivacy` reaches the built project. Both are the exact analogue of M2-D-25's `.androidlib` question and are settled by building (M4-V-7), with the `.xcframework` fallback already designed.
5. **The AppLovin iOS revenue delegate protocol name and registration property.** Settled by compiling (M4-A-28).
6. **Whether Keychain items survive app deletion on current iOS.** Long-standing observed behaviour, but not found stated on any Apple page read in this pass. §M4-S-10 avoids the Keychain entirely, so the design does not depend on it; V-3 observes it.
7. **Whether `isExcludedFromBackup` is honoured by Quick Start device-to-device transfer.** Apple's page describes iCloud backup. This is the iOS analogue of the Android OEM device-transfer gap M2-D-19 had to handle with two attributes, and it is the reason M4-V-3 tests transfer separately rather than assuming backup exclusion covers it.
8. **Whether the system `libsqlite3`'s internal `stat` calls count as SDK use of a Required Reason API.** §M4-S-9 removes the dependency on the answer by generating the manifest from a symbol audit of the built binary rather than from a reading of the rule.
9. **Whether `DispatchTime.now()` is outside the system-boot-time category.** It uses the same clock as `mach_absolute_time()` but is not a listed symbol. Same resolution as (8): the audit decides, not the reading.
10. **The minimum deployment target the current Xcode accepts.** Not verified. M4-D-27 chooses iOS 16.0, which is at or above any plausible floor, so the decision cannot be invalidated by the answer.
11. **Rate limits on `api-adservices.apple.com`.** Not documented. `OPENMASU_ADSERVICES_LOOKUP_RATE_RPS` is a proposed default and a self-imposed courtesy limit, not a measurement.
12. **Every number in the M4-S-5 limits table.** Proposed defaults and thresholds, not measurements — the same status as M2-S-5's table.
13. **Whether App Store review accepts `NSPrivacyTracking = false` for this SDK.** The reasoning in §M4-S-9 is sound and follows Apple's definition, but only M4-V-5 settles it, and a rejection would be a design-level finding rather than a documentation fix.
