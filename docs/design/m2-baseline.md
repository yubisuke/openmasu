# M2 Design Baseline

Status: **decided by R-24.** Every option set adopts the recorded recommendation. WO-6 implements this fixed design rather than redesigning it.

Repository location when adopted: `docs/design/m2-baseline.md`.

Baseline: contract `0.3.0`; `main` includes M1a, M1b, and the contract v0.3 prerequisites merged through PR #21. This document was adopted on 2026-08-19 for WO-6.

Decision numbering is `M2-D-01 … M2-D-32` and is identical in this document and in `m2-baseline-decisions.ja.md`. References of the form `M1 D-06` point at `docs/design/m1-baseline.md`.

---

## Scope

### Who M2 is for

The users are unchanged from `docs/product-scope.md`: developers operating their own mobile apps, growth operators validating campaign-level installs, and data teams reconciling an existing MMP against first-party data. New Story is the development team, not the reference customer.

M1 gave those users a ledger they can only fill from **somebody else's** exports. Review finding F13 in `docs/review/lab-findings-public.md` states the consequence precisely: with provider export only, "reconciliation is a self-join within the import". **M2 is the first milestone that produces first-party evidence, and therefore the first milestone after which the difference audit compares two independent measurements rather than one measurement against itself.** That is the point of M2, and it is the sentence the scope should be judged against.

### What "usable" means for M2 — stage L2a

The review's stage table (`docs/review/2026-08-17-review.md` §3.2) defines L2a as "first-party paths become primary on Android/Unity". Concretely, after M2 an operator can:

1. measure cross-promotion, owned media, web-to-app, and referral **as primary**, through their own redirector plus Google Play Install Referrer;
2. obtain Meta's Android installs at campaign / ad-set / ad granularity **independently**, by decrypting the Meta Install Referrer with a key they fetch themselves from the Meta App Dashboard — no MMP partnership, no approval;
3. join MAX impression-level ad revenue to a real installation anchor, which closes the gap M1 D-22 had to leave open (`installation_id` NULL, aggregate-only revenue);
4. therefore compute Android cohort LTV and ROAS entirely from first-party evidence.

L2a explicitly does **not** include Google App campaigns (review F-4: third-party click measurement is excluded by Google), TikTok / AppLovin / Unity Ads / Mintegral user-level attribution (F-6, F-11), or iOS (M4a/M4b).

### In scope for M2

- Portable Node.js redirector: `GET /r/{slug}`, CSPRNG `click_id`, click evidence, Play referrer construction, safe fallback.
- An optional Cloudflare Workers redirector adapter over the **same** core, as R-14 requires.
- Ingestion API `POST /v1/events/batch` with SDK authentication, replay defence, and limits.
- Android Kotlin SDK: `installation_id`, Install Referrer read, Meta Install Referrer read and decryption, `install` / `session_start` / `ad_revenue` / `consent_changed` delivery, durable queue, retry, batching, event-level idempotency, consent withdrawal purge, collection disablement, identifier reset, Auto Backup and device-transfer exclusion.
- MAX impression-level ad revenue **client** callback wiring (Android listener and Unity per-format events).
- Unity C# package (UPM) over an Android Kotlin bridge.
- On-device privacy-request path — the route M1 deliberately answered with `501 on_device_path_not_implemented` (M1 D-07).
- Sample application, Play internal-testing procedure, and an operator device-validation checklist.

### Explicitly out of scope for M2

- iOS of any kind (M4a Swift SDK, M4b SKAN/AdAttributionKit receipt).
- Dashboard and login (M3).
- Play Integrity and App Attest (M5). §M2-S-11 states what M2 does instead and what it does not claim.
- Deferred deep linking, re-engagement/retargeting attribution, and view-through measurement other than what Meta Install Referrer itself reports.
- Media postbacks to networks (M5, and limited to first-party links, Meta, and Apple Ads).
- Purchases and refunds through the SDK. The contract has `purchase` and `refund` schemas; the roadmap does not put them in M2. Adding them is cheap and should be a deliberate decision, not a drift (M2-D-28 note).

### Prerequisite completed: contract v0.3

The project's contract-first pattern was applied before WO-6. Contract v0.3 now provides typed places for the device observations M2 requires.

1. `meta_referrer_context` contains the verified, measurement-relevant decrypted Meta fields while free-form names remain protected evidence.
2. `referrer_status=third_party` and the v0.3 reason vocabulary distinguish foreign referrers from unresolved first-party click IDs.
3. `custom_event` provides the bounded, closed envelope promised by `docs/product-scope.md`.

All twelve handoffs recorded below were completed by WO-5.5 before WO-6. The migration evidence is in `docs/contract-v0.3-migration.md`.

### M2a / M2b split

M2 is larger than M1a or M1b. Splitting it keeps each work order verifiable (M2-D-32):

- **M2a — server side, no device required.** Redirector core and Node shell, tracking links, ingestion API, SDK/installation authentication, replay defence, limits, worker ordering, on-device privacy route, and every acceptance criterion that a synthetic HTTP client can drive.
- **M2b — device side.** Kotlin SDK, Meta Install Referrer decryption, MAX ILRD wiring, Unity package, sample app, and the emulator gate.

M2a is fully testable with `node --test` and Compose; M2b needs a JVM/Android toolchain. Keeping them in one work order means the whole thing is blocked on the Android toolchain being right.

---

## Security baseline

### M2-S-1 (M2-D-01). Ingestion API authentication

M1 D-01 recorded the handoff verbatim: "SDK key as public identifier + HMAC-SHA256 over `(method, path, sdk_key_id, body_sha256, timestamp_ms, nonce)` with the shared secret provisioned at SDK build time; replay window; key rotation with two live keys." That is the starting point, and it needs one honest qualification before it is adopted.

**The qualification.** The signing secret ships inside the APK. Anyone who can read the APK can extract it. So HMAC here is **not** a defence against a determined attacker fabricating installs; that is Play Integrity's job in M5. What it does buy, and what the threat model must claim and no more:

- integrity of the request against on-path modification and against replay of a captured batch;
- a revocable, per-app-build credential, so a leaked secret is a rotation and not a rebuild of the whole scheme;
- an authenticated `(tenant_id, app_id)` binding, which is what the contract's "authenticated server context assigns `tenant_id` and `app_id`" clause requires from a runtime.

**Options**

- (a) SDK key as a plain bearer token.
- (b) SDK key ID + HMAC-SHA256 over a canonical signing string (the M1 handoff).
- (c) (b) plus an Ed25519 signature with a device-generated private key, so the server stores only public keys.
- (d) mTLS.

**Decided (R-24): (b), with (c) recorded as the better-in-principle option rejected on platform grounds.** (a) has no integrity at all and makes every field in the batch attacker-controlled after one observation, which is precisely the F-03 hole. (c) is genuinely better — a database compromise would not let an attacker forge any installation's events, because the server holds no signing secret — but Ed25519 through the Android platform provider is not available across the minSdk range a measurement SDK must support without bundling a crypto provider, which adds SDK size and a supply-chain dependency to the one artifact that ships inside other people's apps. *(Ed25519 platform availability by API level is **unverified** in this pass; if it turns out to be available at the chosen minSdk, (c) should be reconsidered, because it removes a whole class of server-side secret handling.)* (d) requires shipping and rotating client certificates inside an APK, which is (b)'s problem plus TLS plumbing.

**Signing string.** One canonical string, newline-separated, with every component length-unambiguous:

```
open-mmp-sdk-v1\n
<http-method>\n
<path>\n
<sdk_key_id>\n
<installation_key_id or "-">\n
<timestamp_ms>\n
<nonce>\n
<sha256-hex of the raw request body>
```

The header carries `sdk_key_id`, `installation_key_id`, `timestamp_ms`, `nonce`, and the signature. The body digest, not the body, is signed, so the server can verify before parsing JSON — an important ordering property, because it means malformed or hostile JSON is rejected by an authenticated path rather than by the parser.

**Server-side secret storage.** HMAC verification needs the secret in recoverable form, unlike the admin key's scrypt verifier. Store the SDK secret **envelope-encrypted with the existing `OPENMMP_PAYLOAD_MASTER_KEY` mechanism** (`apps/runtime/src/payload-store.ts`), not in plaintext, and record the residual risk explicitly in `docs/threat-model.md`: a compromise of both the database and the KEK permits forgery. Do not invent a second key-management mechanism for this.

**Rotation.** Two active SDK keys at a time, mirroring `control.admin_keys` exactly (`active` / `retired` through a `*_states` table and a `*_current` view). An app build pins one `sdk_key_id`; a rotation therefore has to overlap for as long as the old build is in the field, which is longer than an operator expects. Say that in the documentation: the overlap window is an app-release-adoption window, not an operations window.

**Acceptance:** M2a A-05, A-06.

### M2-S-2 (M2-D-02). Per-installation credential, and the on-device deletion path

M1 answered `requested_via=on_device_sdk` with `501` for one reason (M1 D-07): "there is no device to authenticate". M2's whole job here is to create one. Lane F F-02 states the failure to avoid in one line — a design where knowing an `installation_id` is enough to delete somebody's data.

**Options**

- (a) App-level SDK key only. A deletion request is authenticated as "some copy of this app", and the `installation_id` in the body decides whose data is erased.
- (b) Per-installation credential: on first launch the SDK calls `POST /v1/installations` signed with the app key; the server generates a random 32-byte `installation_secret`, returns it once, and stores it envelope-encrypted with an opaque `installation_key_id`. Every later batch and every privacy request is signed with that secret, and the server erases only the installation bound to the presented key.
- (c) An out-of-band verification (email/one-time code) as consumer DSAR flows do.

**Decided (R-24): (b).** (a) is F-02 restated: the request is authenticated but not *authorised*, and the whole point of opening the route in M2 is that the device proves possession of something only that installation received. (c) requires collecting an identifier the SDK is forbidden to collect, so it is not available to this project by construction.

(b) pays for itself several times over beyond deletion. It gives per-installation rate limiting (§M2-S-5) without ever putting the `installation_id` on a hot path; it gives per-installation revocation; and it makes the identifier reset (§M2-D-22) a credential operation rather than a bare local file delete.

**Honest limit, to be stated in the threat model, not buried.** Enrollment itself is authenticated only by the app key, so an attacker holding the APK can enroll arbitrarily many fake installations. (b) does not prevent fabricated installs. It prevents one compromised installation from forging or deleting another's data, and it makes revocation possible. Fabrication defence is Play Integrity in M5.

**Non-identifying audit reference.** `privacy-request.requester_auth_ref` forbids installation identifiers by schema description. Use `sdk_auth:<audit_log_id>` — an opaque pointer to the runtime `ledger.audit_logs` row that recorded the authentication decision. The audit row, not the contract artifact, carries the `installation_key_id`.

**Deletion semantics.** An on-device request has `deletion_scope=installation` and `deletion_subject_ref` matching `^installation:` — the schema already enforces both under `if requested_via = on_device_sdk`. The server must additionally verify that the `installation_id` named in `deletion_subject_ref` is the one bound to the presented `installation_key_id`, and return `403` otherwise. That check is the entire security value of this section; it gets its own test (A-22).

**Acceptance:** M2a A-22.

### M2-S-3 (M2-D-03). Replay window and where the nonce lives

M1 D-06 chose permanent DB uniqueness on `(tenant_id, app_id, producer, event_id)` and explicitly reserved the time-window cache "for M2's SDK surface". Both are needed and they defend different things:

- the permanent unique constraint deduplicates **events** — a retried delivery creates a second `event_delivery` and no second logical event;
- the nonce window defends the **transport signature** — a captured, correctly signed HTTP request replayed verbatim by a third party. Without it, an observer can replay a batch indefinitely; the events dedupe, but the request itself is a free authenticated write and an amplification vector.

**Parameters.**

- Timestamp skew tolerance: **±5 minutes**. Not an arbitrary number — the contract already fixes 5 minutes as the point at which client time becomes `clock_skew_suspected`. Reusing the same constant means one number to explain.
- Nonce retention: **15 minutes** (window + margin). A nonce older than the window is rejected by the timestamp check before the cache is consulted, so retention beyond window+margin buys nothing.
- Nonce: 16 random bytes, base64url.

**Where it lives — this is the structural question.** The nonce cache needs eviction, and the M1 ledger revokes `UPDATE`, `DELETE`, and `TRUNCATE` from `openmmp_app` on **both** `control` and `ledger` (`db/schema.sql`). At 300k DAU this table takes on the order of 10^6 rows per day; keeping it forever is not an option.

- (a) A new `ephemeral` schema with RLS enabled and `SELECT, INSERT, DELETE` granted to `openmmp_app`, documented as explicitly *not* evidence and outside the append-only guarantee.
- (b) A time-partitioned table in `ledger` whose old partitions are dropped by an owner-privileged maintenance job.
- (c) Redis.

**Decided (R-24): (a).** It is the only option that keeps "the application role can never delete evidence" literally true — the deletable table is in a schema whose name says it holds no evidence — while costing one migration. (b) breaks the equally important M1 property that the application never holds DDL rights, or else needs a second privileged process on the hot path. (c) re-adds the service M1 D-11 deliberately kept out of Compose.

**Acceptance:** M2a A-06.

### M2-S-4 (M2-D-04). Request shape: durable inbox, not synchronous evaluation

**Options**

- (a) Verify, evaluate through `packages/attribution-core`, persist, and return per-event results synchronously.
- (b) Verify, append the batch to a durable inbox in one `INSERT`, return `202` with a receipt; the worker evaluates.
- (c) (b) for events, (a) for a small "control" subset (consent, privacy).

**Decided (R-24): (b).** The MAX receiver already proves the shape works (`apps/api/src/max-receiver.ts`: verify → one durable insert → 204), and the reasons transfer:

- the contract's ingestion decisions are **stateful across records** — `duplicate_delivery`, `event_id_conflict`, click candidacy — so synchronous evaluation puts candidate lookups and a multi-table write inside the request, and puts lock contention between concurrent devices;
- the client does not need per-event verdicts. Its contract is at-least-once delivery with a stable `event_id`; rejections are recorded server-side as `rejections` artifacts and are the operator's business, not the device's. Returning verdicts would also tell an attacker which forged `event_id` values collided, which is a small but free information leak;
- a mobile client on a slow network holds its queue for the duration of the request. A 20 ms `202` is a materially better client than a 200 ms `200`.

(c) is tempting for `consent_changed`, because withdrawal ought to take effect immediately. It does not need synchronous *evaluation*, only synchronous *recognition*: the API writes the withdrawal recognition into a small control table inside the same transaction as the inbox append, so any later batch is evaluated against it regardless of worker lag. That is (b) plus one row, and it keeps a single ingestion path. **Adopt (b) with synchronous withdrawal recognition.**

**Acceptance:** M2a A-08, A-15.

### M2-S-5 (M2-D-05). Rate and size limits

Same instrument as M1 D-11: in-process token buckets, no Redis, refuse **before** any insert.

| Surface | Unit | Proposed default | Env variable |
| --- | --- | --- | --- |
| `POST /v1/events/batch` | per `installation_key_id` | 1 req/s, burst 20 | `OPENMMP_INGEST_RATE_RPS`, `_BURST` |
| `POST /v1/events/batch` | per `sdk_key_id` | 500 req/s, burst 1000 | `OPENMMP_INGEST_APP_RATE_RPS`, `_BURST` |
| `POST /v1/events/batch` | body bytes | 256 KiB | `OPENMMP_INGEST_MAX_BYTES` |
| `POST /v1/events/batch` | events per batch | 100 | `OPENMMP_INGEST_MAX_EVENTS` |
| `POST /v1/installations` | per `sdk_key_id` | 20 req/s, burst 100 | `OPENMMP_ENROLL_RATE_RPS`, `_BURST` |
| `POST /v1/privacy/on-device` | per `installation_key_id` | 1 req/min, burst 3 | `OPENMMP_DEVICE_PRIVACY_RATE_RPM` |
| `GET /r/{slug}` | per source IP, in memory only | 20 req/s, burst 100 | `OPENMMP_REDIRECT_RATE_RPS`, `_BURST` |
| `GET /r/{slug}` | per slug | 2000 req/s, burst 5000 | `OPENMMP_REDIRECT_SLUG_RATE_RPS` |

The enrollment bucket is the one that matters for abuse: it is the rate at which fake installations can be created. Deliberately generous relative to a real app's install rate and deliberately finite.

The redirector's per-IP bucket key is an IP address held **in memory only**, never written to the database, never logged by the application, consistent with `docs/privacy-security.md`. Horizontally scaled deployments move it to the proxy; document that, exactly as M1 does.

### M2-S-6 (M2-D-06). Redirector: open redirect

Lane F F-16: `docs/architecture.md` says "approved destination" and "safe configured destination" without specifying what approves one.

**Options**

- (a) Follow a destination supplied as a query parameter, validated against a scheme/domain allowlist.
- (b) Resolve the destination **only** from the stored tracking-link row; no request input can influence it.
- (c) (b) plus a registration-time allowlist on what a link may point at.

**Decided (R-24): (c).** (b) alone removes the classic open redirect by construction — there is no attacker-controlled destination — but it does not stop a tenant operator from creating a link that points at an attacker's page and lending it the deployment's domain reputation. (c) adds a boot-configured allowlist (`https` scheme only, plus `market://details` and `https://play.google.com/store/apps/details`, plus explicitly configured tenant domains) checked when the link is **created**, so the failure surfaces at configuration time with a clear message rather than at click time.

(a) is the option that produces a CVE. There is no requirement in `docs/product-scope.md` that needs it.

**Fallback.** An unknown slug, a disabled link, or an internal error all return the **same** response: a `302` to the boot-configured fallback URL, with no body and no error detail. This is both the F-17 enumeration defence and the "falls back to a safe configured destination without exposing internal errors" requirement in `docs/architecture.md`.

**Acceptance:** M2a A-02, A-03.

### M2-S-7 (M2-D-07). Slug generation and enumeration

Lane F F-17: unspecified.

**Options**

- (a) Operator-chosen human-readable slugs.
- (b) CSPRNG slugs, 12 base64url characters (72 bits).
- (c) (b) with an optional operator-chosen alias.

**Decided (R-24): (c).** Random by default makes enumeration useless; the alias exists because printed and spoken campaign links are a real requirement and forbidding them just moves the problem into a URL shortener the operator controls less well. The alias is opt-in per link, its risk is documented (an alias is guessable and therefore enumerable), and it is disabled by a single deployment-level flag for operators who do not want it. Combined with the indistinguishable fallback in M2-S-6 and the per-IP bucket in M2-S-5, enumeration yields no signal even when aliases are enabled.

### M2-S-8 (M2-D-08). `click_id` integrity — and why it decides the referrer's length

`docs/privacy-security.md` requires `click_id` to be "protected by server-side lookup **or** an integrity mechanism that detects tampering". Contract v0.2 already fixes the value: CSPRNG, ≥128 bits, ≥22 base64url characters (`common.schema.json#/$defs/clickId`).

**Options**

- (a) Server-side lookup only: the referrer carries the `click_id` and nothing else; an unknown value yields `unknown_click_id`.
- (b) A self-authenticating referrer: `click_id` plus an HMAC over the campaign dimensions, so the redirector's evidence can be reconstructed from the referrer alone.
- (c) Both.

**Decided (R-24): (a).** The redirector writes the click into the same ledger the install lands in, so the lookup is always available and the referrer never needs to carry campaign data. Tampering is detected structurally: a modified `click_id` is a `click_id` that does not exist, and 128 bits of CSPRNG output is not guessable. (b) buys the ability to attribute a click whose evidence row was lost — but it does so by trusting the device's copy of the campaign assignment, which is exactly the "synthesised join presented as evidence" the project exists to refuse. It also puts campaign identifiers into a string that leaves the deployment.

**The consequence is the important part.** Under (a) the referrer is roughly `omv=1&cid=<22–43 chars>` — under 64 bytes before percent-encoding. **The undocumented Play referrer length limit therefore stops being a design risk.** Lane D flagged that unknown (F-15) as something that "affects click_id length design and needs measurement before implementation"; choosing (a) removes the dependency instead of measuring it. The operator checklist still measures it (V-5), but nothing blocks on the result.

The referrer is percent-encoded exactly once when the Play URL is built and decoded exactly once by the SDK; a round-trip test fixes the convention (A-04) because "how many times is this encoded" is the classic way this breaks.

### M2-S-9 (M2-D-09). Click injection, click flooding, and where a verdict can go

Lane F's table already records that contract v0.2 makes click injection **detectable**: `redirector_click_at` is server-recorded click time and `install_begin_at_server` is Google's server-recorded install-begin time, so click-to-install time is computable from two server clocks with no device input. Injection shows up as a CTIT close to zero — the click fired from the install broadcast.

**Options**

- (a) Detect nothing in M2; the fields exist and M5 adds detection.
- (b) Compute CTIT in the worker, record it as an operational metric, and surface a report; take no attribution action.
- (c) (b) plus a `fraud_decision` artifact, and exclusion from attribution above a configured threshold.

**Decided (R-24): (c), enabled by contract v0.3.** M2 computes CTIT from the two server-authoritative timestamps, preserves the distribution for threshold review, and emits the public `click_injection_suspected` fraud envelope when the deployment policy threshold is crossed. Live thresholds and identifying signals remain private.

Click flooding is the same shape: the redirector's per-slug bucket (M2-S-5) is the immediate control, and rate-based verdicts are M5.

### M2-S-10 (M2-D-10). Redirector IP handling and `click.country`

`click` has an optional `country`. The only source the redirector has is the source IP.

**Options**

- (a) Never populate `click.country` from the redirector.
- (b) Populate it from a bundled offline GeoIP database; store only the two-letter code; never store or log the IP.
- (c) (b) always on.

**Decided (R-24): (b), defaulting to off** (`OPENMMP_REDIRECTOR_GEO=off|country`). Two facts drive it. First, `docs/privacy-security.md` forbids deriving a **fingerprint** from IP; a country code is not a fingerprint, so the principle does not forbid (b) — but it is close enough to the line that it should be the operator's decision and not a default. Second, and decisively for a self-hosting operator: Google Play's Data safety guidance states that where developers use IP addresses to determine location, that data type must be declared. **Defaulting to off means the default deployment's Data safety mapping does not have to declare location.** Turning it on is a documented, one-line change with a documented disclosure consequence. Shipping (c) would silently change every operator's Play declaration.

The same page's ephemeral-processing exception ("stored in memory and retained for no longer than necessary to service the specific request in real-time... will not be disclosed in your app's Data safety section") is the reason the *rate limiter's* in-memory use of the IP needs no declaration. Cite it in `docs/privacy-security.md` rather than asserting the conclusion.

**Acceptance:** M2a A-24.

### M2-S-11 (M2-D-11). Meta Install Referrer decryption key

Verified on 2026-08-19 from the primary page: the key is a 64-character hex string (256-bit), obtained by the developer from App Dashboard → Settings > Basic → Android → **Install Referrer Decryption Key**, requiring Business Manager admin rights. The payload is AES-256-GCM through libsodium; the nonce is a hex string; the tag is 16 bytes; the ciphertext and nonce require hex→binary conversion before decryption; the AAD is empty. Meta's documentation **does not describe key rotation**.

**Options for where the key lives and who decrypts**

- (a) Ship the key in the app and decrypt on the device.
- (b) Ship the encrypted blob to the server as protected evidence and decrypt on the server.
- (c) Decrypt on the device with a key delivered at runtime.

**Decided (R-24): (b).** It is not close. (a) puts a Business-Manager-scoped secret in every APK, where it is extractable, and it makes key rotation an app release. (c) is (a) with an extra fetch and the same end state on a rooted device. (b) keeps the key in the same `SecretStore` port as every other deployment secret, makes rotation a restart, and — the property that matters most — **makes decryption failure recoverable**: the encrypted blob is retained as protected raw evidence, so if the operator configured the wrong key, fixing the key and re-running attribution recovers the campaigns. Under (a) or (c) the payload is lost on the device forever.

The device therefore reads the ContentProvider, extracts `install_referrer` / `is_ct` / `actual_timestamp` verbatim, and sends them as protected payload. The device never sees a decryption key and never parses Meta's structure.

**Rotation.** Not documented by Meta, so design for it defensively: accept `OPENMMP_META_IR_DECRYPTION_KEY` and `OPENMMP_META_IR_DECRYPTION_KEY_PREVIOUS`, try the current key first and the previous key on authentication-tag failure, and record which key succeeded on the raw record. Cost is a dozen lines; the alternative is an unrecoverable gap on the day the key is rotated.

**A trap worth naming.** The `<queries>` package names and the ContentProvider authorities do not match, and mixing them silently yields "no Meta app" on every device:

| Meta app | `<queries>` package | Provider authority |
| --- | --- | --- |
| Facebook | `com.facebook.katana` | `com.facebook.katana.provider.InstallReferrerProvider` |
| Instagram | `com.instagram.android` | `com.instagram.contentprovider.InstallReferrerProvider` |
| Facebook Lite | `com.facebook.lite` | `com.facebook.lite.provider.InstallReferrerProvider` |

Instagram's authority is not `com.instagram.android.provider.*`. A-12 asserts all six strings from the merged manifest and the source.

### M2-S-12 (M2-D-12). Consent withdrawal on the device

`docs/product-scope.md` and `docs/privacy-security.md` both require it: on withdrawal the SDK stops delivery and **purges or immediately redacts** queued events for consent-required purposes.

**Options**

- (a) Stop delivery; leave the queue for a later grant.
- (b) Delete queued rows for consent-required purposes immediately; deliver the `consent_changed` event itself (which remains processable per the contract).
- (c) (b) plus overwrite the freed database pages.

**Decided (R-24): (b).** (a) is a documented violation of the project's own text. (c) is not achievable through Room/SQLite in any way that can be honestly asserted — SQLite reuses pages and the filesystem may be copy-on-write — so claiming it would be an unverifiable promise. `PRAGMA secure_delete=ON` is a cheap partial measure worth enabling and worth describing precisely as "zeroes freed pages inside the database file", not as "erases the data from the device".

Purpose is per-event and comes from the SDK's own purpose mapping (`attribution`, `analytics`, and `revenue_measurement` are consent-required; `fraud_prevention` is not). The authenticated server reassigns the same mapping rather than trusting a client-supplied purpose. The withdrawal test asserts the exact set that survives, and the server gate proves that a client cannot relabel a later event to bypass withdrawal.

**Acceptance:** M2b A-15.

### M2-S-13 (M2-D-13). What M2 does *not* claim about fabricated installs

Stated once, plainly, in `docs/threat-model.md` under the new `sdk-ingestion` component: **M2 does not prevent an attacker who possesses the APK from enrolling installations and delivering fabricated installs and events.** The controls that exist are the enrollment bucket, the per-installation bucket, the permanent `event_id` uniqueness constraint, the signature and nonce window, and the fact that every fabricated install is anchored, counted, and visible in the same reports as the real ones. Play Integrity is M5.

Writing this down is not pessimism; it is the difference between a threat model and marketing, and Lane F F-03's complaint was precisely that the plan left "three milestones with real data and no abuse controls" without saying so.

---

## Architecture

### Repository layout additions

```text
apps/
  api/                    # + POST /v1/events/batch, /v1/installations, /v1/privacy/on-device
  redirector/             # NEW: Node HTTP shell over packages/redirector-core
  worker/                 # + inbox draining for SDK batches, CTIT report, late-click re-evaluation
packages/
  redirector-core/        # NEW: pure link resolution, click_id issuance, referrer construction
  meta-install-referrer/  # NEW: pure parse + AES-256-GCM decrypt, no I/O
sdk/
  android/                # NEW: Gradle project — :core (Kotlin), :installreferrer, :max, :sample
  unity/                  # NEW: UPM package + .androidlib + sample scene
adapters/
  redirector-workers/     # NEW, optional: Cloudflare Workers shell over redirector-core
docs/validation/
  m2-device-checklist.md  # NEW: operator/device procedures (not a code gate)
```

`sdk/` and `adapters/` sit outside the npm workspace globs (`apps/*`, `packages/*`) and must not be added to them; a Gradle project inside an npm workspace breaks `npm ci` expectations for no benefit.

### M2-D-14. Redirector deployment shape

**Options**

- (a) A route inside `apps/api`.
- (b) A separate `apps/redirector` service.
- (c) `packages/redirector-core` (pure) plus a thin Node shell and a thin Workers shell.

**Decided (R-24): (c), with the Node shell as its own Compose service.** R-14 requires that the Workers redirector, if offered, keep the same behavior available through the portable Node interface. Two shells over one core is the only arrangement that makes "same behavior" mechanically true rather than a promise — the same test suite runs against the core and both shells resolve the same links the same way.

Given a core package exists regardless, the remaining question is whether the Node shell is a route in `apps/api` or a process. Recommend a process, for one reason that outweighs the extra Compose service: **the redirector is the only surface that is hammered by the open internet and the only one whose availability is on the user's critical path to the Play Store**. A click flood, a slow database, or a bug in the admin API should not be able to take down redirects or vice versa. It also lets the redirector run with a database role that can write click evidence and read link configuration and nothing else.

Cost: one Compose service. The M1 first-run experience (`docker compose up`, no configuration) is preserved as long as the bootstrap prints the redirector base URL alongside the admin key and the MAX template.

### M2-D-15. Ingestion API placement and reuse of the M1 ingestion path

`apps/worker/src/ingestion.ts` already exposes `ingestRuntimeBatch(attempts, appPool, historicalAttempts)`, which runs the real evaluator with an `IndexedCandidateProvider` and persists every artifact. The three import families already go through it, and `verify:parity` proves it reproduces the contract goldens.

**Options**

- (a) A new SDK-specific ingestion path.
- (b) Reuse `ingestRuntimeBatch`, with the API converting an authenticated batch into `CandidateAttempt[]` and the worker supplying historical candidates.
- (c) (b) plus a separate fast path for `install`.

**Decided (R-24): (b), unmodified.** This is the project's central claim applied to M2: the shipped decision code is the code the goldens test. (a) guarantees eventual divergence between how an imported install is classified and how a first-party install is classified — which would be devastating, because the difference audit's whole job in M2 is to compare exactly those two. (c) optimises the one path whose correctness matters most.

The only change `ingestRuntimeBatch` needs is that its `historicalAttempts` must be able to include **click candidates loaded from `ledger.click_facts`** rather than only from the current batch, since the click arrives through the redirector minutes earlier and through a different producer. That is a candidate-provider concern, which M1 D-23 already refactored `decide()` to accept.

### M2-D-16. Worker ordering, and the click-before-install race

The failure mode is specific and expensive: an `install` is evaluated while its `click` is still sitting in the inbox, so the click is not a candidate, and the install is permanently recorded as `unattributed / unknown_click_id`. Every attributed install lost this way is a silent revenue misallocation — the exact failure this product exists to prevent.

**Options**

- (a) Drain the inbox in strict `(received_at, inbox_seq)` order per `(tenant_id, app_id)`.
- (b) (a) plus a bounded re-evaluation pass: any install whose attribution is `unknown_click_id` and whose `click_id` appears in `click_facts` afterwards produces a **superseding** attribution.
- (c) Hold installs in the inbox for a fixed delay before evaluating.

**Decided (R-24): (b).** (a) is correct in the normal case and cheap — the click is written seconds to days before the install, so ordering by `received_at` resolves it — but it is not sufficient, because the redirector and the SDK are different processes writing through different paths, and a redirector outage, a retried SDK batch, or a clock difference breaks the ordering assumption at exactly the moments when the numbers matter. (b) costs one bounded query per re-evaluation window and uses machinery the contract already has: `supersedes_attribution_id` and immutable prior rows. (c) trades a guaranteed latency penalty on every install for a partial fix.

Bound the re-evaluation lookback at the attribution window (7 days) plus a margin, and record how many attributions it corrected — a non-zero and rising count is an operational signal that the redirector is dropping clicks.

**Acceptance:** M2a A-16b.

### Runtime shape

Five services in the default Compose topology: `postgres`, `migrate`, `api`, `worker`, and the new `redirector`; the optional `proxy` / `s3` / `seed` profiles are unchanged. No queue broker, no Redis, no new managed dependency.

---

## Contract touchpoints resolved by v0.3

This section preserves the pre-v0.3 gap analysis that motivated WO-5.5. Every C- and H-item described here is now resolved in the active contract; it is rationale, not an open implementation choice.

### What M2 produces against contract v0.2

| Artifact | Producer | Notes |
| --- | --- | --- |
| `click` | `redirector` | `tracking_link_id`, `campaign_id`, `redirector_click_at`, `redirector_time_status`; optional `ad_group_id`, `creative_id`, `network`, `country`, `site_id` from the link row. |
| `install` | `sdk-android` | `referrer_status`, `install_begin_at_server(_status)`, `referrer_click_at_server`, device timestamps as evidence, `click_id`, `protected_referrer_evidence_ref`, `country`, `app_version`, `os_version`, `sdk_version`, `meta_referrer_status`, `meta_referrer_context`. |
| `session_start` | `sdk-android` | `installation_id`, `session_id`. Feeds M1b retention, which M1b could only emit as `undefined / no_activity_events`. |
| `ad_revenue` | `sdk-android` | `subject_scope=installation_level` with a real `installation_id`; `revenue_source=client_estimated`; `ad_network`, `mediation_provider=applovin-max`, `ad_unit_id`, `country`, `currency_source`. `anchor_source` is **not** set — the spec restricts it to `postback:<kind>` producers, and an SDK-delivered impression needs no synthesised anchor. |
| `consent_changed` | `sdk-android` | `consent_state`, `effective_at`, `consent_policy_version`. |
| `privacy-request` | control plane | `requested_via=on_device_sdk`, `deletion_scope=installation`, `requester_auth_ref=sdk_auth:<audit_log_id>`. |

**No contract change is required for any of the above.** That is a good result and worth stating: v0.2 absorbed M2's normal path.

### What contract v0.2 cannot express, in severity order

**C-1 (blocks the M2 evidence gate) — Meta Install Referrer decrypted fields.** `install.meta_referrer_context` contains exactly one field, `attribution_model`, and `spec/event-metric-contract-v0.2.md` states why: "Because the Meta primary documentation was unavailable at verification time... Exact decrypted Meta campaign, ad-group, ad, Instagram, and publisher-platform fields, plus failure and retry semantics, are unverified and therefore are not contract fields. They MUST NOT be smuggled through `extensions` to create attribution semantics."

The premise has changed. The page was retrieved on 2026-08-19 and the decrypted payload's fields are verified (see [References](#references)). The roadmap's own M2 evidence gate requires obtaining `campaign_id` from a decrypted payload and reconciling it against Meta Ads Manager — which contract v0.2 cannot represent, and which `extensions` is explicitly forbidden to carry. **M2 cannot meet its stated gate without this.**

**C-2 (highest severity for measurement quality) — a Play referrer that is present but not ours.** `referrer_status` is `available | none | unsupported | unavailable`. Trace the evaluator (`packages/attribution-core/src/evaluator.ts`): `none` → `organic / no_referrer`; `available` with a `click_id` that resolves to nothing → `unattributed / unknown_click_id`.

Now consider what actually arrives on a real device. Google Play supplies a referrer for organic installs too — the classic `utm_source=google-play&utm_medium=organic` shape — and any other network's referrer will be present when that network drove the install. Under v0.2 the SDK's only honest options are to report `available` with no `click_id`, which yields `unattributed / unknown_click_id` for a large share of **organic** installs, or to report `none`, which discards evidence and asserts something false.

Neither is acceptable. `unknown_click_id` means "a click ID was presented and did not resolve"; it does not mean "no click ID was presented". A deployment shipping this would report a badly inflated unattributed bucket and a badly deflated organic bucket, and the difference audit against an existing MMP would show a large unexplained gap whose cause is our own reason code. Contract v0.3 needs to separate the cases (H-2).

**Mitigation if H-2 does not land:** the raw referrer string is retained as protected evidence under `protected_referrer_evidence_ref`, the ledger is append-only, and attribution is supersedable — so a later contract version can re-derive the correct classification without re-collecting anything. That makes the damage recoverable, not avoided. It should not be treated as a reason to defer.

**C-3 (blocks a `docs/product-scope.md` promise) — no custom event envelope.** Phase 1 requires "install, session_start, and custom event delivery". `registries/event-names-v0.2.json` is closed and contains no generic event. There is no way to deliver an in-app event through this SDK. Either v0.3 adds an envelope (H-3) or `docs/product-scope.md` must be amended — and amending it silently would be exactly the drift `AGENTS.md` forbids.

**C-4 (P1) — Meta referrer failure taxonomy.** `meta_referrer_status` has three values. The device can distinguish at least five states: no Meta app installed; a Meta app installed but below the minimum version, so no provider resolves; a provider resolved but returned an empty cursor (not a Meta-driven install); the payload decrypted but was malformed; and authentication-tag failure (wrong or rotated key). Today the first three collapse to `absent` and the last two to `decrypt_failed`. Coverage — "what fraction of installs could we even have attributed to Meta?" — is therefore not measurable, and coverage is precisely the number the M2 gate and Meta's own version requirements make an operator ask (H-4).

**C-5 (P1) — Install Referrer client response codes have no evidence field.** `DEVELOPER_ERROR` (an integration bug) and a `SERVICE_DISCONNECTED` that never recovers (a transient platform state) both land as `referrer_status=unavailable` → `install_referrer_unavailable`. The attribution outcome is right in both cases; the diagnosis is destroyed. An operator whose integration is broken sees the same number as one whose users' Play Store is flaky (H-5).

**C-6 (P1) — no vocabulary for a click-injection verdict.** See M2-S-9. `fraud_public_categories` is closed to `bot_prefetch` and `replay_suspected` (H-6).

**C-7 (P2) — identifier reset has no marker.** See M2-D-22. A reset produces a new installation anchor that is indistinguishable from a genuine first install, so install counts include resets with no way to net them out (H-7).

**C-8 (P2) — no typed place for a wrapper SDK version.** `raw-record.producer_version` is a single string and `producer` is closed, so a Unity app is `sdk-android` with one version string covering two artifacts. M2 works around it (`install.sdk_version` carries the Unity package version, `producer_version` carries the Kotlin core version), but `session_start` has no `sdk_version` field, so the workaround is partial (H-8).

**Contract changes are complete.** They are recorded in [Handoffs completed by contract v0.3](#handoffs-completed-by-contract-v03) and `docs/contract-v0.3-migration.md`. WO-6 treats the contract as frozen.

---

## Data model additions

Same conventions as M1: identifiers are `control.identifier`, contract timestamps are `control.canonical_timestamp` with a generated `timestamptz` for range queries, RLS is `FORCE`d with `SET LOCAL open_mmp.tenant_id`, and lifecycle is expressed by append-only `*_states` tables plus a `*_current` view. Nothing below deviates.

### Control plane

```sql
CREATE TABLE control.tracking_links (
  tracking_link_id control.identifier PRIMARY KEY,
  tenant_id  control.identifier NOT NULL,
  app_id     control.identifier NOT NULL,
  slug       text NOT NULL,
  slug_alias text,
  destination_kind text NOT NULL CHECK (destination_kind IN ('play_store','custom_https')),
  destination_package text,
  destination_url text,
  campaign_id control.identifier NOT NULL,
  ad_group_id control.identifier,
  creative_id control.identifier,
  network text, site_id text,
  created_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, slug_alias)
);
-- plus control.tracking_link_states (active | paused | archived) and control.tracking_links_current
```

`slug` is unique per **tenant**, not per app, because the URL space is shared.

```sql
CREATE TABLE control.sdk_keys (
  sdk_key_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id    control.identifier NOT NULL,
  -- M4 adds nullable platform evidence for newly issued keys; existing M2 rows remain unchanged.
  secret_ref text NOT NULL,          -- envelope-encrypted object in the payload store
  created_at control.canonical_timestamp NOT NULL,
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id)
);
-- plus control.sdk_key_states (active | retired) and control.sdk_keys_current, max two active

CREATE TABLE control.installation_credentials (
  installation_key_id control.identifier PRIMARY KEY,   -- opaque, server-assigned
  tenant_id control.identifier NOT NULL,
  app_id    control.identifier NOT NULL,
  installation_id_digest text NOT NULL CHECK (installation_id_digest ~ '^[a-f0-9]{64}$'),
  sdk_key_id control.identifier NOT NULL REFERENCES control.sdk_keys (sdk_key_id),
  secret_ref text NOT NULL,          -- envelope-encrypted object in the payload store
  created_at control.canonical_timestamp NOT NULL,
  UNIQUE (tenant_id, app_id, installation_id_digest)
);
-- plus control.installation_credential_states (active | revoked | deleted) and ..._current
```

Two properties are deliberate.

- The **secret material lives in the payload store**, not in the table. Purging an installation therefore reuses the mechanism M1 already proved: delete the encrypted object and its wrapped key entry, append a `purged` state row, and the credential is unrecoverable while the append-only table is untouched. No new deletion mechanism, no `UPDATE` exception.
- The key row carries only `HMAC-SHA-256(tenant_id || NUL || app_id || NUL || installation_id)` as `installation_id_digest`, so the authorisation check in M2-S-2 is an indexed digest lookup without storing the plaintext installation identifier. `UNIQUE (tenant_id, app_id, installation_id_digest)` makes double enrollment of one installation impossible.

### Ephemeral (new schema)

```sql
CREATE SCHEMA ephemeral AUTHORIZATION openmmp_owner;

CREATE TABLE ephemeral.request_nonces (
  tenant_id control.identifier NOT NULL,
  app_id    control.identifier NOT NULL,
  key_id    control.identifier NOT NULL,          -- sdk_key_id or installation_key_id
  nonce     text NOT NULL,
  received_at control.canonical_timestamp NOT NULL,
  received_at_ts timestamptz GENERATED ALWAYS AS
    (control.canonical_timestamp_value(received_at)) STORED,
  PRIMARY KEY (tenant_id, app_id, key_id, nonce)
);
CREATE INDEX request_nonces_sweep_idx ON ephemeral.request_nonces (received_at_ts);

GRANT SELECT, INSERT, DELETE ON ephemeral.request_nonces TO openmmp_app;
```

RLS applies exactly as in `ledger` and `control`. The schema name is the documentation: `ephemeral` holds no evidence, is outside the append-only guarantee, and may be truncated at any time with no loss of contract meaning. That is a claim a reader of `db/schema.sql` can check.

### Ledger

```sql
CREATE TABLE ledger.ingest_batches (
  batch_id uuid PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id    control.identifier NOT NULL,
  producer  text NOT NULL,                       -- 'sdk-android' | 'redirector'
  sdk_key_id control.identifier,
  installation_key_id control.identifier,
  received_at control.canonical_timestamp NOT NULL,
  event_count int NOT NULL CHECK (event_count BETWEEN 1 AND 1000),
  payload_ref text NOT NULL,                     -- envelope-encrypted request body
  payload_digest char(64) NOT NULL,
  artifact jsonb NOT NULL
);
-- plus ledger.ingest_batch_states (pending | processed | failed) and ledger.ingest_batches_current
```

**Why a new table rather than reusing `ledger.ingest_inbox`.** The existing inbox is MAX-shaped: it has a singular `event_id` and a `raw_query_ref`, and it carries `token_mode`. Forcing a 100-event signed JSON batch into those columns means either nullable columns whose meaning depends on the producer, or an overloaded `event_id`. A parallel table that reuses the same **pattern** (row + `*_states` + `*_current`) is the cheaper honest option, and it keeps each inbox's columns meaningful.

`installation_key_id` is on the batch row rather than `installation_id`: the API never needs the installation identity to accept, store, or rate-limit a batch, and keeping the identity out of the operational table means the identity exists only inside the encrypted payload and the projections, where redaction already reaches it.

`install_facts` gains one projected column so Meta coverage is queryable rather than buried in `artifact`:

```sql
ALTER TABLE ledger.install_facts ADD COLUMN meta_referrer_status text;
```

`ledger.click_facts` needs no change; the redirector's click flows through the ordinary logical-event projection.

### Threat-model rows

`npm run check:threat-model` requires every component in `docs/architecture.md` to have a row in `docs/threat-model.md`. M2 adds four component identifiers: `redirector`, `sdk-ingestion`, `sdk-android`, `unity-bridge`.

---

## SDK design

### Android module layout

```text
sdk/android/
  core/            # queue, delivery, signing, consent, installation identity — no Play/Meta deps
  installreferrer/ # com.android.installreferrer wrapper
  metareferrer/    # ContentProvider read (no decryption on device)
  max/             # optional: MaxAdRevenueListener → ad_revenue
  sample/          # sample app used by the emulator gate and the Play internal test
```

`core` has no dependency on the Install Referrer library or on AppLovin. An app that only wants first-party events pulls one artifact. `max` being optional matters: it must not force the AppLovin SDK on apps that do not use it.

### M2-D-17. Queue storage

**Options**

- (a) Room.
- (b) `SQLiteOpenHelper` directly.
- (c) An append-only file plus an index.

**Decided (R-24): (a).** Android's documentation recommends Room over the SQLite APIs directly, and the reasons stated there — compile-time SQL verification, less boilerplate, a consistent migration path — are the reasons a queue schema that must survive SDK upgrades needs. (c) is attractive for a write-mostly queue but reimplements crash-consistent truncation, which is where hand-rolled queues actually break.

**Say what "zero loss" means, precisely, and match the test to it.** `RoomDatabase.JournalMode.AUTOMATIC` (the default) selects write-ahead logging on normal devices. WAL with SQLite's usual `synchronous=NORMAL` does not fsync on every commit. Therefore:

- **Process death (SIGKILL, force-stop, OOM kill) loses nothing**, because committed pages are in the OS page cache and survive the process. This is the case A-14 tests, and it is the case that actually happens.
- **Abrupt power loss or a kernel panic can lose the most recent commits.** Setting `synchronous=FULL` would close that at a real write-amplification cost on every event.

Recommend keeping the default and documenting the boundary. A "zero loss" claim that quietly means "except on power loss" is the kind of promise this project should not make; a stated boundary is stronger than an unstated absolute.

### M2-D-18. Background delivery

**Options**

- (a) WorkManager for everything.
- (b) An in-process scheduler while the app is alive, plus WorkManager as a backstop.
- (c) A foreground service.

**Decided (R-24): (b).** WorkManager persists work to its own SQLite database and reschedules across reboots, and it honours Doze — which is exactly right for the backstop but wrong for the foreground path, where the minimum periodic interval is 15 minutes and Doze can add much more. An app in the foreground should deliver a batch within seconds of an event, or session and revenue data lags reporting by a quarter of an hour for no reason. So: deliver in-process on a coalescing timer while the process is alive, and enqueue a **unique** `OneTimeWorkRequest` with `NetworkType.CONNECTED` whenever the queue is non-empty at background transition, so anything left over drains later.

Backoff: WorkManager's default is `EXPONENTIAL` with a 30-second initial delay, and `MIN_BACKOFF_MILLIS` is 10 seconds — 10 seconds is the *floor*, not the default. Adopt the default; do not set 10 seconds because it appeared in a note.

There is **no** Android API that reliably runs work at app-kill time; `onTaskRemoved` is not one. Nothing in the design may depend on flushing at exit. The durable queue is the answer, and A-14 is the proof.

### M2-D-19. `installation_id` storage and backup exclusion

Requirement (`docs/privacy-security.md`, and a named M2 release gate): storage holding `installation_id` must be excluded from Android Auto Backup **and** device-transfer restoration.

**Options**

- (a) `android:allowBackup="false"` on the SDK manifest.
- (b) Keep `installation_id` in a dedicated `SharedPreferences` file plus a dedicated files-directory subtree, and exclude both in `android:dataExtractionRules` (API 31+) **and** `android:fullBackupContent` (API ≤ 30), in the **library** manifest so manifest merging carries it into the host app.
- (c) Do not persist it; derive it from something.

**Decided (R-24): (b), and it must be both attributes.** Android's documentation is explicit on two points that make (a) insufficient and make "one attribute is enough" wrong:

- for apps targeting API 31+, on devices from some manufacturers `android:allowBackup="false"` disables cloud backup but **does not disable device-to-device transfer**. So (a) can leave the exact failure the gate exists to prevent — an `installation_id` reappearing on a second device.
- an app targeting API 31+ must *also* specify `fullBackupContent` rules to cover devices running API 30 and below.

(c) is a fingerprint by another name and is forbidden by project policy.

The exclusion targets a directory, not a file list — the documentation confirms `path` has no wildcards but that naming a directory applies recursively — so the SDK puts every persistent artifact (`installation_id`, the installation credential reference, the queue database, consent state) under one subtree and excludes that subtree once. This also means the queue is not restored onto another device, which is correct and easy to forget.

`allowBackup` itself is left to the host app: a measurement SDK must not disable an app's backup.

**Acceptance:** A-13 (static, mechanical) and V-3 (two real devices).

### M2-D-20. Install Referrer response codes → contract values

Verified constants (2026-08-19): `OK=0`, `SERVICE_UNAVAILABLE=1`, `FEATURE_NOT_SUPPORTED=2`, `DEVELOPER_ERROR=3`, `SERVICE_DISCONNECTED=-1`. There is no `PERMISSION_ERROR`. `SERVICE_DISCONNECTED` is documented as potentially transient with an explicit invitation to implement a retry policy.

| Client outcome | `referrer_status` | Retry | Resulting attribution |
| --- | --- | --- | --- |
| `OK`, referrer non-empty, our `cid` present | `available` + `click_id` | — | window evaluation |
| `OK`, referrer non-empty, no `cid` | `available`, no `click_id` | — | `unattributed / unknown_click_id` **— see C-2; this is the case v0.3 must fix** |
| `OK`, referrer empty or absent | `none` | — | `organic / no_referrer` |
| `FEATURE_NOT_SUPPORTED` | `unsupported` | no | `unattributed / install_referrer_unsupported` |
| `SERVICE_UNAVAILABLE` | `unavailable` after retries | bounded | `unattributed / install_referrer_unavailable` |
| `SERVICE_DISCONNECTED` | `unavailable` after retries | bounded, per the documentation | `unattributed / install_referrer_unavailable` |
| `DEVELOPER_ERROR` | `unavailable` | no | `unattributed / install_referrer_unavailable` **— see C-5; indistinguishable from a platform failure** |

Retry policy: reconnect on `SERVICE_UNAVAILABLE` / `SERVICE_DISCONNECTED` with exponential backoff, up to a bounded number of attempts across app launches; the terminal outcome is delivered exactly once. `DEVELOPER_ERROR` must additionally emit a loud Logcat error, because it is always the integrator's bug.

Call the API once after install and call `endConnection()`, as documented. The 90-day retention gives the retry budget generous headroom; the "once" guidance is about avoiding pointless calls, not a hard limit, and a bounded retry across launches after a transient failure is consistent with it.

**One item the design deliberately resolves by compiling.** Google's AIDL page documents seven response-Bundle keys including `referrer_click_timestamp_server_seconds`, `install_begin_timestamp_server_seconds`, and `install_version`. The `ReferrerDetails` **class reference page**, checked three times on 2026-08-19, lists only four accessors and does not show getters for those three. The contract's entire install-side time authority depends on the server timestamps. Rather than assert getter names from memory, WO-6 makes the SDK call all seven accessors and **the build failing is the verification** (A-09b). If the accessors do not exist, the library must be read through the raw AIDL interface and the fact recorded — a discovery worth making on day one of WO-6, not in week three.

### M2-D-21. Meta Install Referrer read path

The device performs no cryptography (M2-S-11). Sequence:

1. Resolve `com.facebook.katana.provider.InstallReferrerProvider`, then `com.instagram.contentprovider.InstallReferrerProvider`, then `com.facebook.lite.provider.InstallReferrerProvider` — the order Meta's own sample uses.
2. Query `content://<authority>/<FB_APP_ID>` with projection `["install_referrer", "is_ct", "actual_timestamp"]`.
3. Send the three column values verbatim as protected payload alongside the install.
4. The server parses, decrypts `install_referrer.utm_content.source.data` with the nonce in `install_referrer.utm_content.source.nonce`, and populates `meta_referrer_status` / `meta_referrer_context`.

**`packages/meta-install-referrer` is pure.** Input: the three column values plus a key. Output: a discriminated result — decrypted payload, `wrong_key`, `malformed`, or `absent`. No I/O, no database, no clock. That is what makes A-11 possible: synthetic vectors generated inside the test with a synthetic key, never a real Meta payload, which `AGENTS.md` forbids in this repository anyway.

**Two documented ambiguities the implementation must absorb rather than assume.**

- **`is_ct` semantics.** The field name makes `1 = click-through, 0 = view-through` the obvious reading, and Meta's documentation states the feature covers view-through, click-through, and multi-session click-through. But the primary page does **not** state the mapping. Both `meta_referrer_context.attribution_model` values (`last_click`, `view_through`) hang off this one bit, so guessing it wrong inverts every Meta attribution model. Recommendation: implement the obvious reading, put it behind a single named constant, and make V-2 (live campaign) confirm it before any operator trusts the model split. Record it in `docs/validation/` as a value to be observed, not assumed.
- **`actual_timestamp` unit.** Not stated. Seconds is the convention for the neighbouring Play fields; milliseconds is possible. Recommendation: accept both by magnitude (a plausible epoch-second value versus a plausible epoch-millisecond value), record which branch fired on the raw record, and confirm in V-2. This is not the authoritative install time under the contract — `install_begin_at_server` is — so a wrong guess degrades a diagnostic rather than corrupting attribution. That is why absorbing it is acceptable here and would not be for `is_ct`.

Meta's outer payload is shown in the documentation as a **pseudo-JSON** block that mixes `=` and `:` separators and is not valid JSON. The parser must be written against the real shape observed in V-2 and must fail into `malformed` rather than throwing. Treat the documented example as a shape hint, not a grammar.

**Deduplication against the Play referrer.** Meta documents it: for click-through campaigns, when Play Install Referrer campaign metadata is also available, deduplicate using the matching `install_referrer` values; for view-through and cross-session click-through, use Meta's data because Play does not cover them. The evaluator's current precedence already implements the safe half — `meta_referrer_status=decrypted` is checked **before** the first-party referrer path, so a Meta-decrypted install is never double-counted as a first-party click install. What is missing is the case where a first-party `click_id` and a Meta decryption both resolve; today Meta wins silently. That precedence is a contract-level rule and should be stated in the spec rather than left to reading the evaluator (H-9).

### M2-D-22. Identifier reset — the hardest item in M2

`docs/product-scope.md` requires "collection disablement and local identifier reset". The contract makes this genuinely difficult, and the difficulty is not obvious until the constraints are put side by side:

- "Exactly one accepted install record may name an installation anchor" (spec, Install anchors).
- `ledger.install_facts` has `UNIQUE (tenant_id, app_id, installation_id)`.
- Revenue and sessions join only to that anchor; an ambiguous anchor fails closed.
- `install_type=first_install` **must not** name `prior_installation_id`; `reinstall` / `redownload` **must**.

So a reset that produces a new `installation_id` produces either a new install record (inflating installs) or an anchorless identity (whose sessions and revenue cannot join, silently).

**Options**

- (a) Reset local state only; emit no install. The new identity has no anchor, so every subsequent session and revenue event fails to join. The SDK is measurement-dead after a reset.
- (b) Emit `install_type=reinstall` naming the old `installation_id` as `prior_installation_id`. Preserves the anchor chain — and preserves the link between the old and new identity, which is precisely what the user asked to break.
- (c) Emit `install_type=first_install` with `referrer_status=none`, and require a successful on-device deletion request for the old installation first.
- (d) Refuse to implement reset until the contract has a marker.

**Decided (R-24): (c), with the marker raised as H-7.** Walk the alternatives: (a) satisfies the letter of "reset" and produces an SDK that silently stops measuring, which an operator will discover as missing revenue weeks later. (b) is a privacy violation dressed as data integrity — a reset whose audit trail says "this is the same person as before" is not a reset. (d) blocks a product-scope requirement on a contract change that is itself only a nice-to-have.

Under (c) the sequence is: the SDK issues a signed on-device deletion request for the old installation (which succeeds or the reset does not proceed), purges local state including the queue, generates a new `installation_id`, enrolls a new installation credential, and delivers a fresh `install` with `install_type=first_install` and `referrer_status=none`. It must **not** re-read the Play Install Referrer — the referrer is still available for 90 days, and re-reading it would re-attribute the same acquisition to the same campaign a second time. The SDK records locally that the referrer has been consumed, and that flag lives in the same backup-excluded subtree.

**The cost, stated plainly:** install counts include resets, and there is no field that says so. That is why H-7 proposes an optional `install_origin = play_first_launch | identifier_reset` evidence field on `install`, which is a two-line schema change that makes the count correctable. Until it lands, the reset is documented as counting, and the SDK emits a Logcat warning so an integrator wiring reset into a settings screen learns it before shipping.

### M2-D-23. Collection disablement

Simpler, and it should stay simple. `setCollectionEnabled(false)`: stop generating events, stop delivering, retain the queue (this is not a consent withdrawal, so the M2-S-12 purge does not apply), persist the flag in the backup-excluded subtree, and honour it before any other initialisation so that a disabled SDK performs no Install Referrer read, no Meta provider query, and no network call. Re-enabling resumes delivery of whatever was queued. `docs/product-scope.md` evidence gate 6 — "the SDK sends no new events after collection is disabled" — is A-17.

The one trap: `setCollectionEnabled(false)` called before `init()` must be honoured. A flag that only works after initialisation means the first launch always reads the referrer. Recommend a manifest meta-data key (`com.openmmp.COLLECTION_ENABLED_DEFAULT=false`) so an app can start disabled, which is what a consent-gated app actually needs.

### M2-D-24. MAX impression-level ad revenue

Verified 2026-08-19 (note that `developers.applovin.com` now redirects to `support.applovin.com` / `support.axon.ai`; `docs/references.md:77` should be updated to the reachable host, which Lane C already flagged as unreachable).

- **Android:** `MaxAdRevenueListener` with `onAdRevenuePaid(MaxAd ad)`, attached through `setRevenueListener()`; no format restriction is documented.
- **`MaxAd` accessors documented in the ILRD section:** `getRevenue()` → `double`, USD, **`-1` on error**; `getRevenuePrecision()` → `String` with values `"publisher_defined" | "exact" | "estimated" | "undefined"` and `""` when disabled; `getNetworkName()`, `getAdUnitId()`, `getFormat()` (`MaxAdFormat`), `getPlacement()`, `getNetworkPlacement()`.
- **Correction to the earlier work-order assumption:** the precision value is `"undefined"`, not `"undisclosed"`.
- `getCreativeId()`, `getWaterfall()`, `getDspName()` are documented **elsewhere**, not in the ILRD section — **unconfirmed** as guaranteed on the ILRD callback. Do not put them on a required path.
- **Unity:** only **per-format** events are documented — `MaxSdkCallbacks.Interstitial.OnAdRevenuePaidEvent`, `.Rewarded.`, `.Banner.`, `.MRec.` — with signature `(string adUnitId, MaxSdkBase.AdInfo adInfo)`. A single unified `MaxSdkCallbacks.OnAdRevenuePaidEvent` is **not** documented; the design must subscribe per format. The parameter type is `MaxSdkBase.AdInfo`, not `MaxSdk.AdInfo`. Fields confirmed in that section: `Revenue`, `RevenuePrecision`, `NetworkName`, `AdUnitIdentifier`, `Placement`, `NetworkPlacement`.
- S2S ILRD requires account-team enablement. The client callback carries **no** such documented requirement — but that is a negative observation (the documentation does not say it is required), not a positive guarantee. Do not tell operators it is unconditionally available.

**Mapping to `ad_revenue`**

| MAX | Contract | Note |
| --- | --- | --- |
| `getRevenue()` | `amount_unscaled` / `amount_scale` | The contract requires **non-negative integer** unscaled money. `-1` is an error sentinel, not revenue: drop the event and count it. A `double` must be scaled to integer micros deterministically, and rounding to 6 decimal places must be **half-even** to match the contract's rounding mode. |
| `getRevenuePrecision()` | — | No contract field exists. Currently only expressible under `extensions`, which is permitted for non-attribution evidence — but precision is exactly the metadata that decides whether a revenue number is trustworthy, so a typed field belongs in the contract (H-10). |
| `getNetworkName()` | `ad_network` | required |
| — | `mediation_provider` | constant `applovin-max` |
| `getAdUnitId()` | `ad_unit_id` | |
| — | `currency` | USD; `currency_source=reported`. AppLovin documents the value as USD, so this is not a default. |
| — | `revenue_source` | `client_estimated` |
| — | `impression_id` | Not supplied by the callback. Generate a UUIDv7 client-side and reuse it as the `event_id`, so the contract's `(tenant, app, producer, event_id)` key makes a retried delivery idempotent. |
| — | `installation_id` | The whole point of M2: `subject_scope=installation_level` with a real anchor, closing M1 D-22. |

**Whether client-side ILRD equals the S2S/reporting value is unconfirmed.** Do not claim they reconcile. The reporting-API backfill M1 built stays useful and the difference between the two series is a legitimate difference-audit output, not a bug to hide.

### M2-D-25. Unity packaging and the bridge

**Options**

- (a) A `.unitypackage`.
- (b) A UPM package (Git URL or a scoped registry) shipping the Android side as a `.androidlib` folder.
- (c) A UPM package shipping a prebuilt `.aar` under `Plugins/Android`.
- (d) A UPM package that adds a Maven coordinate to `mainTemplate.gradle`.

**Decided (R-24): (b) as the shipped default, (d) documented as an advanced option.** `.unitypackage` has no version or dependency management and is how measurement SDKs end up duplicated in projects. (c) means shipping a binary the integrator cannot inspect and re-releasing it for every Kotlin change. (b) keeps Kotlin sources visible and buildable inside the Unity project, which matters for an open-source SDK whose selling point is that you can audit it, and Unity documents the `.androidlib` layout (`build.gradle` optional and auto-generated when absent; `src/main/AndroidManifest.xml`; `src/main/java/<package>/`). (d) is right for teams already managing Gradle dependencies and is the only sane path if the SDK later needs transitive Maven dependencies; document the `**DEPS**` template token for them.

**Two things are unconfirmed and must be settled by building, not by reading.** Unity's documentation places `.androidlib` under `Assets`; whether the same folder works under a UPM package's `Runtime` directory is **not** documented, and the Unity version that introduced `.androidlib` is **not** documented. WO-6's first Unity task is to build the sample from a UPM reference on the chosen Unity version and record what actually worked. If `.androidlib` does not resolve from a package, fall back to (c) with the `.aar` built in CI from the same sources — decide that on evidence, not now.

**Callback marshalling — the part that silently breaks.** `AndroidJavaProxy` is the documented way to implement a Java interface in C#. Unity documents that it can be used from a custom thread only if that thread was attached with `AndroidJNI.AttachCurrentThread`. Unity does **not** document that proxy invocations arrive on the Unity main thread — and the callbacks that matter here (Install Referrer completion, MAX revenue) originate on Android background threads. Therefore: the C# proxy must do nothing but enqueue into a lock-free queue drained on the Unity main thread, and must never touch Unity APIs inline. A-18 asserts the round trip from a background Java thread. Dispose `AndroidJavaObject` instances explicitly rather than relying on finalisation.

### M2-D-26. Version support matrix

Unity 6 (6000.x) is the current LTS line and Unity 2022 LTS has passed standard support — **both are unconfirmed at primary source**, because `unity.com/releases/*` returned HTTP 403 to automated fetching. Several independent secondary sources agree, and the direction is not in doubt, but the dates are not established here.

**Decided (R-24):** support **Unity 2022.3 LTS and Unity 6 LTS**, declare 2022.3 as best-effort, and have the owner confirm the support dates from a browser before the matrix is published. Supporting 2022.3 costs little (the bridge uses APIs present in both) and dropping the version a large share of shipped mobile titles are still on would be a self-inflicted adoption problem. Android `minSdk`: propose **24**, to be confirmed against the Install Referrer library and AppLovin's own minimums during WO-6.

### M2-D-27. SDK versioning and `producer_version`

`producer` is closed and a Unity app is still `sdk-android`. `producer_version` is one string covering what are really two artifacts.

**Decided (R-24):** `producer_version` carries the **Kotlin core** version; `install.sdk_version` carries the **outermost** SDK version the integrator installed (the Unity package version for Unity apps, the Kotlin version otherwise). Do **not** encode both into `producer_version` with a separator — a string pipe that a later reader has to split is exactly what the project's conventions reject.

The residual gap is that `session_start` has no `sdk_version`, so per-version diagnosis is install-only. H-8 proposes the typed fix.

### M2-D-28. Custom events in M2

`docs/product-scope.md` promises them; the contract cannot express them (C-3).

**Options**

- (a) Ship M2 without custom events and amend `docs/product-scope.md`.
- (b) Add a `custom_event` envelope in contract v0.3 and implement it in M2.
- (c) Ship the SDK API now, buffering events that cannot yet be delivered.

**Decided (R-24): (b).** Custom events are the reason a team integrates a measurement SDK at all rather than reading Play Console; an SDK that can report installs and sessions but not "tutorial complete" will not be adopted, and M2 exists to make first-party measurement primary. (c) is the worst option — an API that accepts data it silently cannot deliver.

Proposed shape for H-3, deliberately narrow: `event_name = "custom_event"` with a closed envelope carrying `installation_id`, `event_key` (validated against a deployment-private catalogue, exactly as provider mappings are), an optional `money` object reusing `common#/$defs/money`, and a closed `attributes` map limited to typed scalars with a bounded count and length. No free-form nesting; no PII by construction. Whether `purchase` / `refund` also enter the SDK in M2 is a separate, smaller decision — the schemas already exist, so it is implementation work only, and it should be decided explicitly rather than drifting in.

---

## Redirector design

`GET /r/{slug}` — the whole flow, in order:

1. Per-IP and per-slug token buckets (M2-S-5); the IP is never persisted.
2. Resolve the link from `control.tracking_links_current`. Unknown, paused, or archived → the indistinguishable fallback `302` (M2-S-6).
3. Generate `click_id`: 32 CSPRNG bytes → base64url → 43 characters. Comfortably above the contract's 22-character / 128-bit floor, and short enough that the referrer stays tiny.
4. Append a `click` batch row to `ledger.ingest_batches` with `producer = redirector` (one INSERT).
5. Build the destination:
   - Android + `destination_kind=play_store` → `https://play.google.com/store/apps/details?id=<package>&referrer=<percent-encoded referrer>` where the referrer is `omv=1&cid=<click_id>`;
   - `destination_kind=custom_https` → the stored URL, with no request-derived input;
   - Non-Android user agents → the configured fallback. The redirector reads the User-Agent to route platforms and **must not** persist or derive anything else from it (`docs/privacy-security.md` forbids fingerprinting from User-Agent).
6. `302` with `Cache-Control: no-store`.

`redirector_click_at` is the redirector's own server clock and is the contract's authoritative click time. `redirector_time_status` is `available` normally, and `invalid` if the clock is detectably wrong (for example not monotonic against the database's `now()` beyond a threshold) — because the contract distinguishes `authoritative_time_missing` from `authoritative_time_invalid` and a runtime that never emits `invalid` leaves half that distinction dead.

**Latency budget:** p99 under 50 ms, one database write, no read of the ledger. Link resolution is served from an in-process cache with a short TTL and invalidation on link change; a redirect that waits on a cold database query is a redirect the user abandons.

**The Workers adapter** imports `packages/redirector-core` and supplies platform bindings for storage and clock. It is optional, is not in the default topology (R-14), and is only worth shipping once the same behavioural test suite passes against both shells. If that suite does not exist, the adapter should not ship.

**One item to confirm cheaply.** The `referrer` query parameter on the Play Store details URL is the transport this entire design rests on. It is the universally used mechanism and the Install Referrer documentation is written around it, but this pass did **not** re-verify an explicit primary statement of the parameter name. V-1 observes the round trip on a real device and settles it on day one of M2b; no design decision depends on the answer being anything else.

---

## Local runtime and CI additions

### Compose

One new service, `redirector`, on its own port, `depends_on: migrate`. Bootstrap prints the redirector base URL alongside the admin key and the MAX postback template. The first-run promise is unchanged: `docker compose up` on a clean clone, no manual step.

New environment variables — all of them in `.env.example` with a generator command, because `npm run test:env-coverage` fails otherwise (M1 A13): `OPENMMP_REDIRECTOR_PORT`, `OPENMMP_REDIRECTOR_BASE_URL`, `OPENMMP_REDIRECTOR_FALLBACK_URL`, `OPENMMP_REDIRECTOR_DESTINATION_ALLOWLIST`, `OPENMMP_REDIRECTOR_GEO`, `OPENMMP_SDK_KEY` / `_FILE`, `OPENMMP_SDK_KEY_PREVIOUS` / `_FILE`, `OPENMMP_META_IR_DECRYPTION_KEY` / `_FILE`, `OPENMMP_META_IR_DECRYPTION_KEY_PREVIOUS` / `_FILE`, `OPENMMP_INGEST_SKEW_MS`, `OPENMMP_NONCE_TTL_MS`, plus every limit in the M2-S-5 table.

### CI

**`runtime.yml` extended** with the redirector, ingestion, replay, enrollment, and on-device-privacy integration tests; the Compose smoke gains one redirect and one signed batch.

**M2-D-29. New `sdk-android.yml`.**

- (a) JVM unit tests only.
- (b) JVM unit tests plus one emulator job.
- (c) JVM plus emulator plus a real-device farm.

**Decided (R-24): (b).** The JVM job is the substantive gate and carries most of the value: the queue, retry, signing, consent purge, Install Referrer response mapping (against a fake service), and Meta decryption vectors are all pure logic behind ports, and they run in seconds with no emulator. Durability is tested honestly at the JVM level by writing to a real SQLite file in a **child process** and killing it with SIGKILL — that reproduces the actual failure mode rather than simulating it.

The emulator job earns its cost by proving three things the JVM cannot: that the merged manifest of the sample app contains the backup-exclusion rules and the Meta `<queries>` entries (mechanical, fast, and the highest-value assertion in M2b, because a merge failure here is silent); that the SDK initialises on a real Android runtime; and that one end-to-end install flows to a local ingestion API. Keep it to those three. (c) is an operator procedure, not a code gate — the same principle as M1 D-30.

**M2-D-30. Unity CI.**

- (a) None; a documented manual export procedure.
- (b) Compile the C# with `dotnet` against a stub `UnityEngine` shim, plus a manual procedure.
- (c) A licensed Unity build in CI.

**Decided (R-24): (b).** (c) needs a Unity licence in CI, which is a real cost and a credential in a public repository's workflow — a poor trade for a package whose C# is a thin marshalling layer. (b) catches the errors that actually occur (signature drift, marshalling mistakes, null handling) at nearly zero cost. The Unity export itself becomes an operator/maintainer release step in `docs/validation/m2-device-checklist.md`.

**M2-D-31. SDK artifact SBOM and distribution.** `npm sbom` (M1 D-29) does not see Gradle. Options: (a) leave the SDK out of the SBOM gate — no; the SDK is the artifact that ships inside other people's apps, so it is the one that most needs a bill of materials. (b) CycloneDX Gradle plugin producing `sbom/sdk-android.cdx.json`, with the same "CI fails if it is missing" rule M1 applies to the npm workspaces. (c) Syft over the AAR. **Decided (R-24): (b).** Distribution (Maven Central, signing, an OpenUPM listing) is deliberately **out of M2**: publishing is a maintainer/release-engineering decision with its own credentials, and M2's job is a buildable, reproducible artifact plus a documented build.

---

## Acceptance criteria

Written as commands and observable outcomes; "verify" means the output goes into the completion report. The split below is the M1 D-30 principle applied to M2: **anything requiring a real device, a real Play install, a real Meta campaign, or a real MAX account is an operator procedure, never a code gate**, because an external contributor must be able to verify that M2 is done.

### M2a — synthetic, code gates

**A-01 — redirector determinism and `click_id` quality.** 10,000 redirects produce 10,000 distinct `click_id` values, each matching `^[A-Za-z0-9_-]{22,128}$`; a chi-square test over the character distribution does not reject uniformity; the same `slug` always resolves to the same destination.

**A-02 — no open redirect.** A request carrying `?destination=`, `?url=`, `?next=`, or a `Location`-shaped header cannot change the destination. Creating a link whose destination is outside the allowlist fails at creation with a named error.

**A-03 — enumeration yields nothing.** Unknown slug, paused link, archived link, and a forced internal error return byte-identical responses (status, headers, body). Exceeding the per-IP bucket returns `429`. A full scan of the database and the payload store after the test finds no occurrence of the submitted IP address.

**A-04 — referrer round trip.** The referrer built for a known `click_id`, percent-decoded exactly once, yields that `click_id`; the total referrer is under 64 bytes before encoding; a referrer containing `%`, `+`, `&`, and `=` survives the round trip unchanged.

**A-05 — signature verification.** A correctly signed batch returns `202`. Flipping one byte of the body, of `sdk_key_id`, of `timestamp_ms`, of the nonce, or of the signature returns `401` and writes an `audit_logs` row with `outcome=failed`. Verification happens before JSON parsing: a batch with a valid signature over a malformed body returns `400`, while the same malformed body unsigned returns `401`.

**A-06 — replay rejection.** Replaying a byte-identical valid request returns `401` with `nonce_reused`. A signature whose `timestamp_ms` is 6 minutes old returns `401` with `timestamp_out_of_window`. After `OPENMMP_NONCE_TTL_MS`, the sweep has removed the nonce row and the stale request is still rejected by the timestamp check — proving the two controls are independent.

**A-07 — limits refuse before insert.** A batch over `OPENMMP_INGEST_MAX_BYTES` or `OPENMMP_INGEST_MAX_EVENTS` returns `413`/`400` and `SELECT count(*) FROM ledger.ingest_batches` is unchanged. Exceeding either bucket returns `429`.

**A-08 — durable receipt.** A valid batch returns `202` with `curl -w '%{time_total}'` below 0.2 s; the row is present in `ledger.ingest_batches` before the response; killing the worker before it drains and restarting it still produces the logical events.

**A-09 — Install Referrer mapping.** A table-driven test drives the fake Install Referrer service through every response code and asserts the exact `(referrer_status, click_id presence, retry behaviour)` triple in M2-D-20, and then the resulting attribution reason code end to end.

**A-09b — accessor existence.** `sdk/android` compiles while calling all seven documented `ReferrerDetails` accessors. **The build is the verification** for the item the class-reference page did not confirm. If it fails, that is a finding to report, not a silent workaround.

**A-10 — time authority.** The seven-day half-open window is evaluated from `redirector_click_at` and `install_begin_at_server` only. A device clock set 30 days ahead does not move the boundary and produces `clock_skew_suspected=true`. Exactly seven days is `window_expired`; one millisecond under is `valid_install_referrer`.

**A-11 — Meta decryption vectors.** Vectors are generated **inside the test** with a synthetic key: correct key → decrypted payload with every expected field; wrong key → `wrong_key`, never a partial result; one flipped ciphertext byte → authentication failure, never a decrypted result; a truncated payload, an empty payload, and the documentation's pseudo-JSON shape → `malformed`, never a throw. Key rollover: a payload encrypted with the previous key decrypts when the current key fails, and the raw record records which key succeeded.

**A-16 — event idempotency.** The same `event_id` delivered five times yields one logical event and five `event_deliveries`, four of them `duplicate_delivery`. A different payload under the same `event_id` yields `event_id_conflict` and is rejected.

**A-16b — click/install ordering and late-click recovery.** With the click and install in the same inbox, drain order does not change the attribution. With the click deliberately delayed until after the install is attributed `unknown_click_id`, the re-evaluation pass produces a superseding attribution with `valid_install_referrer` and `supersedes_attribution_id` set, and the prior row is byte-identical to before.

**A-22 — on-device deletion is authorised, not merely authenticated.** Unsigned → `401`. Signed with installation A's credential but naming installation B → `403`, no tombstone, an `audit_logs` row with `outcome=failed`. Signed for itself → tombstones, corrections, a superseding metric run, and `requester_auth_ref` matching `^sdk_auth:`; the credential object and its wrapped key are gone from the payload store and no longer decrypt; the `privacy_request` artifact contains no `deletion_subject_ref` and does contain `deletion_subject_digest`.

**A-24 — IP is never persisted.** After a full redirector and ingestion test run, a full-text scan of every database table and every payload-store object finds no occurrence of the source IP used. With `OPENMMP_REDIRECTOR_GEO=off`, `click.country` is absent.

**A-25 — contract gate untouched.** `npm run validate` prints its unchanged summary line and `git diff --stat -- fixtures/` is empty. (If contract v0.3 lands first, the summary line changes exactly once, in the contract work order, and never in WO-6.)

**A-26 — configuration and threat-model coverage.** `npm run test:env-coverage` and `npm run check:threat-model` pass with the four new components.

**A-27 — SBOM.** `npm run sbom` produces one file per npm workspace and `sbom/sdk-android.cdx.json` exists; CI fails if any is missing.

### M2b — synthetic, code gates

**A-12 — Meta manifest and authorities.** The sample app's **merged** manifest contains `<queries>` entries for `com.facebook.katana`, `com.instagram.android`, and `com.facebook.lite`; the source contains the three provider authorities exactly as documented, including `com.instagram.contentprovider.InstallReferrerProvider`. A string-equality test against a checked-in constants table catches the transposition described in M2-S-11.

**A-13 — backup exclusion.** The merged manifest declares **both** `android:dataExtractionRules` and `android:fullBackupContent`; the rules exclude the SDK's storage subtree from **both** `<cloud-backup>` and `<device-transfer>`; and no persistent SDK artifact is written outside that subtree (asserted by listing the app's data directory after an end-to-end run).

**A-14 — queue survives process death.** Enqueue 1,000 events with the network unavailable; `kill -9` the child process holding the database; restart; exactly 1,000 events are present and no duplicates. Repeat with the kill during a write. The documented boundary (M2-D-17: power loss is not covered) is stated in the test's own comment so nobody later reads this as a stronger guarantee than it is.

**A-15 — consent withdrawal purges.** With events queued for `attribution`, `analytics`, `fraud_prevention`, and `revenue_measurement`, a withdrawal removes exactly the consent-required ones, delivers the `consent_changed` event, and the server rejects any later consent-required event with `consent_withdrawn` regardless of `occurred_at`.

**A-17 — disablement and reset.** After `setCollectionEnabled(false)` no request leaves the SDK and no Install Referrer or Meta provider read occurs — asserted by a strict fake that fails the test on any call. The manifest default-disabled key is honoured before `init()`. `resetInstallationId()` issues the deletion request first, produces a new `installation_id`, does **not** re-read the referrer, and emits `install_type=first_install` with `referrer_status=none`.

**A-18 — Unity bridge round trip.** A C# call reaches Kotlin and a Kotlin callback raised on a **background** thread reaches C# with intact values; the handler observes it on the Unity main thread; 10,000 round trips leak no `AndroidJavaObject` (asserted by an allocation counter).

**A-19 — MAX mapping.** A synthetic `MaxAd` produces one `ad_revenue` with `subject_scope=installation_level`, the correct `installation_id`, `revenue_source=client_estimated`, `mediation_provider=applovin-max`, USD with `currency_source=reported`, and half-even scaling to integer micros. `getRevenue() == -1` produces **no** event and increments an error counter. Each precision value round-trips. Each of the four Unity per-format events is subscribed (asserted by reflection over the subscription table, so adding a format without subscribing fails the test).

**A-20 — emulator smoke.** The sample app installs on an emulator, initialises, reads a fake Install Referrer, and delivers one install to a local ingestion API that records exactly one non-conflicting install.

### Operator-verified — `docs/validation/m2-device-checklist.md`, not code gates

Recording the result is the deliverable; results, campaign identifiers, and values stay outside the public repository, exactly as `docs/validation/real-data-checklist.md` requires.

**V-1 — Play internal testing (the roadmap M2 evidence gate).** Publish the sample to an internal-testing track; click a real measurement link; install from Play; first launch retrieves the referrer and produces **one** non-conflicting install with `valid_install_referrer`. Record the observed referrer string and confirm the `referrer` parameter name (M2-D-08 note).

**V-2 — Meta live campaign (the roadmap M2 evidence gate).** With one live Meta app-install campaign: the decrypted payload yields `campaign_id`, and it reconciles against Meta Ads Manager. Record privately: which provider resolved, the observed `is_ct` values against known click and view installs (**this confirms or refutes the 0/1 mapping — M2-D-21**), the magnitude of `actual_timestamp` (confirming its unit), and the decryption success rate.

**V-3 — Auto Backup and device transfer (the roadmap M2 evidence gate).** With two devices: back up, restore onto the second device, confirm `installation_id` is **not** restored; repeat with device-to-device transfer, which is the case `allowBackup=false` does not cover on some manufacturers' devices. Record the OEM and OS version, because the documented behaviour varies by manufacturer.

**V-4 — MAX live account.** Confirm the client callback fires without account-team enablement (settling the negative observation in M2-D-24); record precision-value distribution and the difference between client ILRD totals and the S2S/reporting series for the same UTC day.

**V-5 — referrer length probe.** Record the longest referrer string observed intact. This finally answers Lane D F-15's open question. Nothing depends on the answer under M2-S-8 (a), which is the point.

**V-6 — Meta coverage.** Over one week: installs with no Meta app, with a below-minimum Meta app, with a Meta app but no Meta campaign data, and with a decrypted payload. This is the number that tells an operator whether Meta Install Referrer is worth relying on, and it is the number C-4/H-4 currently makes impossible to compute.

**V-7 — Unity export.** Export the sample from a UPM reference on each supported Unity version; record whether `.androidlib` resolved from the package directory (M2-D-25's unconfirmed item) and the Gradle configuration actually produced.

---

## Open decisions

| # | Decision | Recommendation |
| --- | --- | --- |
| M2-D-01 | Ingestion API authentication | SDK key ID + HMAC-SHA256 over a canonical string; secret envelope-encrypted; two-key rotation (M2-S-1) |
| M2-D-02 | Per-installation credential and the on-device deletion path | Enrollment-issued installation secret; deletion authorised against the bound `installation_id` (M2-S-2) |
| M2-D-03 | Replay window and nonce storage | ±5 min skew, 15 min nonce retention, new `ephemeral` schema with DELETE (M2-S-3) |
| M2-D-04 | Ingestion request shape | Verify → one durable insert → `202`; withdrawal recognised synchronously (M2-S-4) |
| M2-D-05 | Rate and size limits | In-process buckets, defaults tabled, refuse before insert (M2-S-5) |
| M2-D-06 | Redirector open redirect | Destination only from the stored link + creation-time allowlist; indistinguishable fallback (M2-S-6) |
| M2-D-07 | Slug generation | CSPRNG 12 chars, optional operator alias, deployment-level off switch (M2-S-7) |
| M2-D-08 | `click_id` integrity | Server-side lookup only; referrer carries `click_id` and nothing else (M2-S-8) |
| M2-D-09 | Click injection | Compute CTIT and emit the v0.3 `click_injection_suspected` public fraud envelope; keep live thresholds private (M2-S-9) |
| M2-D-10 | Redirector IP and `click.country` | Offline GeoIP, country only, **default off**, Data-safety consequence documented (M2-S-10) |
| M2-D-11 | Meta decryption key | Server-side decryption; two-key rollover; blob retained as recoverable evidence (M2-S-11) |
| M2-D-12 | Consent withdrawal on device | Purge consent-required queue rows; `secure_delete` described precisely (M2-S-12) |
| M2-D-13 | Interim anti-abuse posture | State plainly that M2 does not prevent fabricated installs; Play Integrity is M5 (M2-S-13) |
| M2-D-14 | Redirector deployment shape | `packages/redirector-core` + Node shell as its own service + optional Workers shell |
| M2-D-15 | Ingestion path | Reuse `ingestRuntimeBatch` unmodified; extend the candidate provider to load clicks from the ledger |
| M2-D-16 | Click/install ordering | Strict `received_at` drain **plus** bounded late-click re-evaluation producing superseding attributions |
| M2-D-17 | Queue storage | Room; durability boundary stated (process death covered, power loss not) |
| M2-D-18 | Background delivery | In-process coalescing timer + unique WorkManager backstop; WorkManager's own defaults |
| M2-D-19 | `installation_id` storage | One backup-excluded subtree; **both** `dataExtractionRules` and `fullBackupContent`; not `allowBackup` |
| M2-D-20 | Install Referrer response mapping | Table in M2-D-20; bounded retries; `DEVELOPER_ERROR` logged loudly; H-5 for the diagnostic gap |
| M2-D-21 | Meta read path | Device reads three columns verbatim; pure server-side decrypt package; `is_ct` confirmed by V-2 |
| M2-D-22 | Identifier reset | Deletion first, then `first_install` + `referrer_status=none`, no referrer re-read; H-7 for the marker |
| M2-D-23 | Collection disablement | Honoured before `init()` via a manifest default; queue retained; no reads while disabled |
| M2-D-24 | MAX ILRD | Per-format Unity subscriptions; `-1` dropped; half-even scaling; precision needs H-10 |
| M2-D-25 | Unity packaging | UPM + `.androidlib` default, Maven coordinate documented; `.aar` fallback decided by building |
| M2-D-26 | Version matrix | Unity 2022.3 LTS + Unity 6 LTS, `minSdk` 24 — **support dates need owner confirmation** |
| M2-D-27 | SDK versioning | `producer_version` = Kotlin core; `install.sdk_version` = outermost package; no string pipe |
| M2-D-28 | Custom events | Add the envelope in v0.3 (H-3) and implement in M2; decide `purchase`/`refund` explicitly |
| M2-D-29 | Android CI | JVM gate (with a real SIGKILL durability test) + one narrow emulator job |
| M2-D-30 | Unity CI | `dotnet` compile against a stub shim; the Unity export is a maintainer procedure |
| M2-D-31 | SDK SBOM and distribution | CycloneDX Gradle plugin, missing-file failure; publishing is out of M2 |
| M2-D-32 | M2a/M2b split and non-goals | Server-side M2a, device-side M2b; device/campaign validation is an operator procedure |

---

## Handoffs completed by contract v0.3

WO-5.5 completed H-1 through H-12 before WO-6. The table remains as the design rationale; every row below is implemented and exercised by a synthetic contract fixture. H-11 fixes reconciliation reason semantics and H-12 adds `attribution_status` as a grouping dimension; their detailed migration evidence is in `docs/contract-v0.3-migration.md`.

| # | Severity | Item |
| --- | --- | --- |
| H-1 | **Blocks the M2 evidence gate** | Meta Install Referrer decrypted fields. The spec's stated reason for omitting them — the primary page could not be retrieved on 2026-08-18 — no longer holds; it was retrieved on 2026-08-19. Extend `meta_referrer_context` with `campaign_group_id`, `campaign_id`, `adgroup_id`, `ad_id`, `account_id`, `ad_objective_name`, `is_instagram`, `publisher_platform`, `platform_position`. **Recommend excluding the `*_name` fields** (`campaign_name`, `adgroup_name`, `campaign_group_name`): they are operator-confidential free text with no measurement use that the IDs do not serve, and they belong in protected raw evidence, not in a typed public artifact. Also record the outer `is_ct` and `actual_timestamp` as evidence, with their unresolved semantics noted in the spec rather than silently assumed. |
| H-2 | **Blocks honest organic/unattributed reporting** | A Play referrer that is present but carries no first-party `click_id` is currently forced into `unattributed / unknown_click_id`. Add `referrer_status=third_party` plus attribution reason codes distinguishing "a referrer we do not own" from "a click ID that did not resolve", and decide whether Play's own organic referrer marker maps to `organic`. Without this, every M2 deployment reports a badly inflated unattributed bucket, and the difference audit's largest gap is caused by our own vocabulary. |
| H-3 | **Blocks a `docs/product-scope.md` promise** | No custom in-app event envelope exists. Add `custom_event` with a closed shape: `installation_id`, `event_key` (deployment-private catalogue), optional `money`, and a closed typed-scalar `attributes` map with bounded count and length. |
| H-4 | P1 | `meta_referrer_status` cannot express the five states a device can actually distinguish, so Meta coverage is not measurable — and coverage is exactly what an operator must know given Meta's minimum app versions. Add values such as `provider_unavailable` and `no_campaign_data`. |
| H-5 | P1 | The Install Referrer client response code has nowhere to live. `DEVELOPER_ERROR` (an integration bug) and a persistent `SERVICE_DISCONNECTED` (a platform state) are indistinguishable in the ledger. Add an evidence-only `referrer_client_response` on `install` that never decides attribution. |
| H-6 | P1 | No public fraud category for click injection, although contract v0.2 already makes it detectable from two server clocks. Add `click_injection_suspected` to `fraud_public_categories`, and state the CTIT definition in the spec so two implementations compute it identically. |
| H-7 | P2 | An identifier reset produces an install record indistinguishable from a genuine first install, so install counts silently include resets. Add optional `install_origin = play_first_launch | identifier_reset`. |
| H-8 | P2 | No typed place for a wrapper SDK version. Either add an optional `producer_variant` / `wrapper_version` to `raw-record`, or add `sdk_version` to `session_start` so per-version diagnosis is not install-only. Do not solve this with a delimiter inside `producer_version`. |
| H-9 | P2 | Precedence between a decrypted Meta Install Referrer and a resolvable first-party `click_id` is implemented in the evaluator (Meta wins) but not stated in the spec. Meta's own documentation describes deduplicating click-through installs between the two sources; the contract should state the rule rather than leave a second implementation to read the reference code. |
| H-10 | P2 | `ad_revenue` has no field for the mediation platform's revenue precision, although MAX supplies `"exact" | "estimated" | "publisher_defined" | "undefined"` and that value decides how much a revenue number can be trusted. Add a closed `revenue_precision`. |

---

## References

All URLs fetched and checked on **2026-08-19** unless noted. Items marked **unconfirmed** are stated as unconfirmed and are never used as the basis for a design that would break if they turn out otherwise.

| Topic | URL | What was confirmed |
| --- | --- | --- |
| Play Install Referrer library | `https://developer.android.com/google/play/installreferrer/library` | Latest published version is `com.android.installreferrer:installreferrer:2.2`. Referrer information is available for 90 days and does not change unless the app is reinstalled. Call the API once during the first execution after install; `endConnection()` avoids leaks. |
| Play Install Referrer AIDL fields | `https://developer.android.com/google/play/installreferrer/igetinstallreferrerservice` | Response Bundle keys: `install_referrer`, `referrer_click_timestamp_seconds`, `install_begin_timestamp_seconds`, `referrer_click_timestamp_server_seconds`, `install_begin_timestamp_server_seconds`, `install_version`, `google_play_instant`. Request parameter `package_name`. |
| `ReferrerDetails` reference | `https://developer.android.com/reference/com/android/installreferrer/api/ReferrerDetails` | Checked 2026-08-20. The page lists only four accessors, but Install Referrer 2.2 compilation succeeds while calling all seven AIDL-backed accessors, including both server timestamps and `install_version` (A-09b). |
| `InstallReferrerResponse` | `https://developer.android.com/reference/com/android/installreferrer/api/InstallReferrerClient.InstallReferrerResponse` | `OK=0`, `SERVICE_UNAVAILABLE=1`, `FEATURE_NOT_SUPPORTED=2`, `DEVELOPER_ERROR=3`, `SERVICE_DISCONNECTED=-1`. No `PERMISSION_ERROR`. `SERVICE_DISCONNECTED` is documented as potentially transient with an explicit retry invitation. |
| Android Auto Backup | `https://developer.android.com/guide/topics/data/autobackup` | `<data-extraction-rules>` with `<cloud-backup>` / `<device-transfer>`, `<include>`/`<exclude>`, the nine `domain` values, no wildcards in `path`, directories apply recursively, exclude wins. An app targeting API 31+ must **also** supply `fullBackupContent` rules for API ≤ 30. On some manufacturers' devices, `android:allowBackup="false"` disables cloud backup but **not** device-to-device transfer. Backup requires user opt-in, 24 h since the last backup, device idle, and Wi-Fi; a device might never back up. |
| Play Data safety | `https://support.google.com/googleplay/android-developer/answer/10787469` | Developers must declare data collected through third-party libraries and SDKs. "Device or other IDs" is defined to include identifiers such as a Firebase installation ID. IP addresses must be declared where used, for example, to determine location. Ephemeral processing — held in memory and retained no longer than needed to service the request in real time — is not disclosed in the Data safety section. |
| Meta Install Referrer | `https://developers.facebook.com/docs/app-ads/meta-install-referrer` (mirror: `/documentation/app-ads/meta-install-referrer`) | Android only. Covers view-through, click-through, and multi-session click-through; Play Install Referrer covers same-session click-through only. Provider authorities `com.facebook.katana.provider.InstallReferrerProvider`, `com.instagram.contentprovider.InstallReferrerProvider`, `com.facebook.lite.provider.InstallReferrerProvider`; URI `content://[authority]/[FB_APP_ID]`; projection `install_referrer`, `is_ct`, `actual_timestamp`. `<queries><package android:name="…"/></queries>` for `com.facebook.katana`, `com.instagram.android`, `com.facebook.lite`. Minimum versions Facebook v428, Instagram v296, Facebook Lite v411. Deduplication against Play Install Referrer for click-through; Meta's data for view-through and cross-session click-through. Verification uses a test campaign injected through Preview in Ads Manager. `/setup`, `/decryption`, `/testing`, `/troubleshooting`, and `/faq` sub-pages return 404. |
| Meta Install Referrer decryption | `https://developers.facebook.com/documentation/app-ads/install-referrer` | AES-GCM 256-bit through libsodium. Key from App Dashboard → Settings > Basic → Android → **Install Referrer Decryption Key** (Business Manager admin). Key is a 64-character hex string; nonce is a hex string; a 16-byte tag; hex→binary conversion required before decrypting; empty AAD (`sodium_crypto_aead_aes256gcm_decrypt(cipher, '', nonce, key)`). Encrypted content is `install_referrer.utm_content.source.{data,nonce}`; `utm_campaign` and `utm_source` are plaintext. Decrypted fields: `ad_id`, `adgroup_id`, `adgroup_name`, `campaign_id`, `campaign_name`, `campaign_group_id`, `campaign_group_name`, `account_id`, `ad_objective_name`, `is_instagram`, `publisher_platform`, `platform_position`. |
| AppLovin MAX ILRD (Android) | `https://support.applovin.com/en/max/android/overview/advanced-settings` | `MaxAdRevenueListener.onAdRevenuePaid(MaxAd)` attached with `setRevenueListener()`; no format restriction documented. `getRevenue()` → `double` in USD, `-1` on error. `getRevenuePrecision()` → `"publisher_defined" | "exact" | "estimated" | "undefined"`, `""` when disabled. Also `getNetworkName()`, `getAdUnitId()`, `getFormat()`, `getPlacement()`, `getNetworkPlacement()`. |
| AppLovin MAX ILRD (Unity) | `https://support.applovin.com/en/max/unity/overview/advanced-settings` | Checked 2026-08-20. Per-format `MaxSdkCallbacks.{Interstitial,Rewarded,Banner,MRec}.OnAdRevenuePaidEvent` exposes revenue fields. The current Unity SDK source uses `MaxSdk.AdInfo`; the earlier design spelling `MaxSdkBase.AdInfo` is not used by the implementation. |
| AppLovin S2S ILRD | `https://support.applovin.com/en/max/advanced-features/s2s-impression-level-api` | S2S ILRD requires account-team or support enablement. (`developers.applovin.com` now redirects to `support.applovin.com` / `support.axon.ai`; `docs/references.md:77` should be updated.) |
| Unity `AndroidJavaProxy` | `https://docs.unity3d.com/ScriptReference/AndroidJavaProxy.html` | Usable from a custom thread only if that thread was attached with `AndroidJNI.AttachCurrentThread`; callbacks are implemented by overriding `Invoke`. **Whether callbacks arrive on the Unity main thread is not documented — unconfirmed.** |
| Unity Android library plugin | `https://docs.unity3d.com/6000.3/Documentation/Manual/android-library-plugin-create.html` | `.androidlib` folder under `Assets`, containing an optional `build.gradle` (auto-generated when absent), `src/main/AndroidManifest.xml`, and `src/main/java/<package>/`. **The Unity version that introduced it, and whether the folder resolves from a UPM package's `Runtime` directory, are unconfirmed.** |
| Unity Gradle templates | `https://docs.unity3d.com/6000.3/Documentation/Manual/android-gradle-template-variables.html` | `**DEPS**` is the project-dependency token in `mainTemplate.gradle`, alongside `APPLICATIONID`, `MINSDK`, `TARGETSDK`, `VERSIONCODE`. **Differences between Unity 2022 LTS and Unity 6 are not documented on this page — unconfirmed.** |
| Room | `https://developer.android.com/training/data-storage/room` | "We recommend using Room instead of using the SQLite APIs directly", for compile-time SQL verification, less boilerplate, and consistent migrations. |
| Room journal mode | `https://developer.android.com/reference/android/arch/persistence/room/RoomDatabase.JournalMode` | `AUTOMATIC` selects `TRUNCATE` below API 16 or on low-memory devices and `WRITE_AHEAD_LOGGING` otherwise. **No explicit durability guarantee statement was found — unconfirmed.** |
| WorkManager | `https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work` | Minimum periodic interval 15 minutes (`MIN_PERIODIC_INTERVAL_MILLIS`), matching JobScheduler. Backoff policies `LINEAR` and `EXPONENTIAL`; the **default is `EXPONENTIAL` with a 30-second delay**; `MIN_BACKOFF_MILLIS` is 10 seconds, i.e. the floor and not the default. |

M2b dependency pins were rechecked from primary release sources on **2026-08-20**: Kotlin 2.3 requires AGP 8.13.2 (`https://developer.android.com/build/kotlin-support`); Room 2.8.4 (`https://developer.android.com/jetpack/androidx/releases/room`); WorkManager 2.11.2 (`https://developer.android.com/jetpack/androidx/releases/work`); AppLovin Android SDK 13.6.2 (`https://github.com/AppLovin/AppLovin-MAX-SDK-Android`); CycloneDX Gradle plugin 3.3.0 (`https://github.com/CycloneDX/cyclonedx-gradle-plugin/releases`); and Android Emulator Runner 2.38.0 (`https://github.com/ReactiveCircus/android-emulator-runner/releases/tag/v2.38.0`). Gradle 8.13's distribution and wrapper checksums were checked against `https://gradle.org/release-checksums/` and both are pinned or asserted by the build/CI.
| WorkManager persistence | `https://developer.android.com/develop/background-work/background-tasks/persistent` | Work is stored in an internally managed SQLite database and rescheduled across device reboots; power-management features such as Doze are respected. **Quantitative delivery-delay impact is not documented — unconfirmed.** |
| Android services guidance | `https://developer.android.com/guide/components/services` | "In many cases, using WorkManager is preferable to using foreground services directly." **No explicit primary-source warning about `onTaskRemoved` reliability was found — unconfirmed;** the design therefore depends on no app-kill hook at all. |

**Not verified — stated as unverified rather than assumed.**

1. Java getter names on `ReferrerDetails` for the two server timestamps and `install_version`. Resolved by Install Referrer 2.2 compilation (A-09b) on 2026-08-20.
2. The maximum length of the Play Store `referrer` parameter. No primary statement found. M2-S-8 (a) removes the dependency; V-5 records the observation.
3. Whether the Play referrer string requires URL decoding, and its behaviour on sideload and on app update. Not stated on the pages checked.
4. The `referrer` query-parameter name on the Play Store details URL was not re-confirmed as an explicit primary statement in this pass. V-1 settles it.
5. Meta's `is_ct` value mapping (which of 0/1 is click-through) and the unit of `actual_timestamp`. Not stated. V-2 settles both; M2-D-21 says how each is absorbed until then.
6. Meta decryption key rotation, and the documented behaviour on a wrong key, an old Meta app version, or a non-Meta install. Not documented. The two-key rollover in M2-S-11 is defensive design, not a documented feature.
7. Whether the MAX client ILRD callback is available to all publishers without account-team enablement. Only a negative observation (the documentation does not say it is required). V-4 settles it.
8. Whether the MAX client ILRD value equals the S2S/reporting value, and whether either is estimated or final. Not documented.
9. Whether `getCreativeId()`, `getWaterfall()`, `getDspName()`, `CreativeIdentifier`, `AdFormat`, and `Waterfall` are guaranteed on the ILRD callback. Documented elsewhere but not in the ILRD section.
10. Unity 6 LTS and Unity 2022 LTS support dates. `unity.com/releases/*` returned HTTP 403 to automated fetching; secondary sources agree but were not treated as primary. M2-D-26 asks the owner to confirm from a browser.
11. Ed25519 availability through the Android platform provider at the SDK's minSdk. Asserted from experience in M2-S-1, not verified. If it is available, option (c) there deserves reconsideration.
12. The Play Data safety classification of the Install Referrer string. The page does not name it; classification is content-dependent.
13. `ExistingWorkPolicy` values, `enqueueUniqueWork`, and `runAttemptCount` semantics could not be read from the AndroidX reference pages (navigation-only responses). The design uses only `enqueueUniqueWork` with a single policy, so nothing depends on the finer distinctions.
14. Whether any real deployment reaches the volumes in M2-S-5. Every number there is a proposed default and a threshold, not a measurement.
