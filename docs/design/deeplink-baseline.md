# Deep Link and Re-engagement Design Baseline

Status: **Decided (R-33, 2026-08-21).** All recommendations in this baseline are adopted; WO-15 implements the fixed design rather than redesigning it.

Repository location when adopted: `docs/design/deeplink-baseline.md`.

Milestone: **M7**.

Adoption baseline: contract `0.4.0`; `main` at `ad22525` includes M0.4 and M1 through M5. This document was written on 2026-08-21 against that tree.

Decision numbering is `DL-D-01 … DL-D-30` and is identical in this document and in `deeplink-baseline-decisions.ja.md`. References of the form `M2-D-08` point at `docs/design/m2-baseline.md`; `M4-D-02` points at `docs/design/m4-baseline.md`; `M1 D-30` points at `docs/design/m1-baseline.md`.

Acceptance criteria are numbered `DL-A-nn` (code gates) and `DL-V-n` (operator procedures), following the M4 convention, because this document references M2 and M4 criteria by number.

---

## Scope

### Why this milestone exists now

Two facts, one from the owner and one from the market, arrive at the same place.

The owner's is recorded in R-31: demand for deep linking is strong. The market's is that the free, default answer disappeared. **Firebase Dynamic Links shut down on 2025-08-25**; links stopped resolving and now return `404`, and Google's own migration guidance splits into two tiers: for full feature parity, use a commercial provider (it names Adjust, Airbridge, AppsFlyer, Bitly, Branch, Kochava, and Singular); for post-install app-only deep linking, use App Links and Universal Links [G-FDL]. The second tier is not a replacement for the first. **App Links and Universal Links solve the installed case only. Google shipped no replacement for the deferred case and said so, attributing the shutdown in part to its inability to keep the post-install transition working.**

That is the shape of the gap. An operator who wants deep links today either pays a commercial MMP or builds the installed-case half themselves and lives without the rest. OpenMasu already owns every piece of the installed-case half — a redirector on a domain it controls, a deterministic `click_id`, a store-carried referrer channel on Android, and three SDKs — and has never wired them to a destination.

### The honest headline, stated before the scope list

**Deterministic deep linking is available on both platforms. Deterministic *deferred* deep linking is available on Android only, and this milestone does not manufacture an iOS equivalent.**

The asymmetry is the same one M4 documented, and it has the same cause. Android has the Play Install Referrer: a platform-provided channel that carries a developer-authored string through the store into the app's first launch. iOS has nothing equivalent, and this pass re-verified that nothing equivalent has appeared:

- **AdAttributionKit postbacks carry no destination field of any kind.** The complete documented field set is `jws-string`, `conversion-value`, `coarse-conversion-value`, `ad-interaction-type`, `country-code` at the top level, and `postback-identifier`, `publisher-item-identifier`, `marketplace-identifier`, `impression-type`, `ad-network-identifier`, `did-win`, `postback-sequence-index`, `conversion-type`, `source-identifier`, `advertised-item-identifier` inside the JWS [A-AAK-PARAMS]. They also arrive 24–48 hours later at the earliest [A-AAK-WINDOWS], which disqualifies them as a first-launch routing signal regardless.
- **StoreKit's product-page parameters carry no destination.** The documented `SKStoreProductParameter*` set covers item identifier, affiliate/campaign/provider/advertising-partner tokens, the custom-product-page identifier, and the SKAdNetwork keys. None is delivered to the installed app [A-SKSP].
- **Custom Product Pages select which store page renders.** The `ppid` UUID is readable only through App Store Connect analytics, never on device [A-CPP].
- **The pasteboard route is closed.** From iOS 16, reading `UIPasteboard.general.string` raises a user-facing approval alert before the app gets the contents [A-PASTECTL]. `detectPatterns(for:)` is prompt-free but returns only whether a pattern matched, never the value; `detectValues(for:)` returns the value and does prompt [A-PATTERNS][A-VALUES]. Firebase Dynamic Links used exactly this mechanism and documented its own degradation: with pasteboard retrieval disabled, the received link's `matchType` was `weak` at best [G-FDL-IOS].
- **App Clips are the one Apple-sanctioned path that survives install** — an App Clip receives the invocation, writes the destination into a shared App Group container, and the full app replaces the App Clip and receives every later invocation [A-CLIP-INVOKE][A-CLIP-SHARE]. It is real, it is not fingerprinting, and it is examined in §DL-D-25. It is also a second shipping artifact, an App Store Connect experience configuration, and a prohibition on wildcard domains, which is why it is not in this milestone.

What every commercial vendor does to fill the remaining gap is device matching. This pass confirmed it from the vendors' own documentation: AppsFlyer states that probabilistic modeling is used when IDFA and IDFV are unavailable [V-AF-DDL]; Adjust ships probabilistic modeling as an explicit opt-in [V-ADJ-WIN]; Branch's confidence ladder ends in probabilistic click-through and view-through tiers [V-BR-METH]; and Singular's own troubleshooting concedes the mechanism by explaining that iCloud Private Relay breaks it because the click IP and the install IP no longer match [V-SNG-DL].

`docs/privacy-security.md` forbids deriving a device fingerprint from IP address, User-Agent, device configuration, or network data. M4-D-02 already ruled that deferred-deep-link matching is that prohibition wearing a costume. **This milestone does not reopen that ruling.** There is now a second reason, and it is the integrators' reason rather than ours: Apple's Developer Program License Agreement, quoted on the User Privacy and Data Use page, prohibits deriving data from a device for the purpose of uniquely identifying it, and it extends the consequence to apps that merely reference an SDK doing so — naming ad networks, attribution services, and analytics SDKs explicitly [A-PRIVACY]. An MMP SDK that fingerprints puts every host app at App Store rejection risk. That is not a principle we are choosing to hold; it is a liability we would be shipping into other people's apps.

So the claim is: **on Android, a user who taps a measurement link and installs lands on the right screen, deterministically, with no matching. On iOS, a user who already has the app lands on the right screen, deterministically, with no matching. An iOS user who does not have the app lands on the App Store, and then on the app's default screen.** Smaller than what a commercial MMP advertises. It is what this project's rules permit, and stating it on the first page is the point of the milestone.

### What "usable" means after this milestone

An operator can:

1. issue a measurement link that opens the app directly on both platforms when the app is installed, verified by Android App Links and iOS Universal Links, with the association files served by the deployment;
2. carry an in-app destination through Google Play into first launch, recovered from the Install Referrer with no network call and no matching;
3. see a re-engagement series — link-driven app opens by already-installed users — that is reported separately from, and never mixed into, installation-level attribution;
4. measure deferred-destination *coverage*, i.e. what fraction of Android installs actually received the destination the operator configured, which is the number that tells them whether the feature is working.

### In scope

- Deep link destinations on the tracking-link definition, with a closed grammar and creation-time validation.
- Redirector serving of `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association`, generated from the control plane.
- A `control.link_domains` registration binding one link host to one tenant, and a `control.app_link_identities` registration holding the Android package name and signing fingerprints, and the Apple team and bundle identifiers.
- The measurement URL shape that lets both a browser and an installed app read the same link.
- A new typed `deep_link_open` event and its SDK receiving surfaces on Android, iOS, and Unity.
- Android deferred destinations carried in the Play referrer, with a validated byte budget.
- Engagement-scope re-engagement attribution, its reason codes, its projection, and its own metric names.
- Contract patch `v0.4.7`, additive only.
- `docs/validation/deeplink-device-checklist.md`.

### Explicitly out of scope

- **iOS deferred deep linking of any kind** (§DL-D-24). Not deferred to a later milestone as a promise — excluded by the same rule that excludes IDFA and fingerprinting, and reconsidered only if Apple ships a channel.
- **App Clips** (§DL-D-25). Examined, sound, and a separate product decision.
- **AdAttributionKit re-engagement** (§DL-D-29). Its prerequisite is exactly this milestone's Universal Links work, which is why it is designed here and built after.
- **Probabilistic matching, pasteboard reads, and any "match confidence" ladder.** Branch and Firebase both converged on a confidence flag (`+match_guaranteed`, `matchType`) [V-BR-MATCH][G-FDL-IOS] because their mechanisms are sometimes wrong. Every mechanism in this milestone is deterministic, so the analogous field records *which* mechanism delivered the destination and *why* it did not, never a confidence score. Shipping a confidence score we would always set to "certain" would invite a later contributor to add a tier below it.
- **Web-to-app measurement**, which R-31 lists as recorded-only extension room.
- **A re-engagement cohort metric with an inactivity threshold** (§DL-D-28). The evidence is recorded; the metric calculation is a later, separate change.
- **Uninstall measurement**, silent push, and anything requiring a push certificate.

### Relationship to the earlier baselines, and how the M2 declaration is amended

`docs/design/m2-baseline.md:48` lists deferred deep linking, re-engagement attribution, and view-through as out of scope for M2. That sentence is not deleted (§DL-D-02). It described a *milestone boundary* and was accurate; M2 shipped without any of it. Two facts make the amendment procedurally light:

- **`docs/product-scope.md` never excluded deep linking.** Its explicit non-goals are device fingerprinting, presenting probabilistic estimates as deterministic, initial ad-cost API coverage, real-time bidding, user-level cross-app tracking on iOS, persistent device identifiers justified as fraud prevention, immediate MMP replacement, and user-level attribution requiring partner-MMP status. Deep linking is absent from that list. So this milestone *adds* to product scope and *retracts* nothing.
- **M4-D-02 is preserved verbatim** (§DL-D-03). It forbids deferred-deep-link *matching*. Direct deep linking performs no matching: the operating system hands our URL to the app because the app proved domain ownership. Android deferred deep linking performs no matching either: Google Play carries our own string to our own app. The one thing M4-D-02 names is the one thing this milestone still does not do.

The M4 decisions memo already anticipated this exact request. Its item 18 records that M4-D-02's iOS conclusion depends on the project treating deferred deep linking as fingerprinting, and flags it as the single place where the conclusion moves on policy rather than technique. This document is the answer: the policy holds, and the technique splits into three parts of which two are deterministic and one is not offered.

### Stage split (DL-D-04, DL-D-05)

Seven stages, each a PR under R-26 non-stop operation. Stages 0–3 need no device; stages 4–6 do.

| Stage | Content | Toolchain |
| --- | --- | --- |
| 0 | Contract patch `v0.4.7` and its fixtures | Linux |
| 1 | Link definitions, domain and app-identity registration, association-file generation and serving | Linux |
| 2 | Redirector URL shape, per-click parameters, referrer payload and byte budget | Linux |
| 3 | `deep_link_open` ingestion, engagement attribution, worker projection, metrics | Linux |
| 4 | Android SDK receiving surface and referrer destination recovery | JVM + emulator |
| 5 | iOS SDK receiving surface | macOS |
| 6 | Unity bridge, sample apps, docs, checklist, threat model, roadmap | mixed |

Stages 1–3 deliver standalone operator value before any SDK change lands: an operator can register a domain, serve valid association files, and verify them with `adb shell pm verify-app-links` and Apple's CDN before touching an app. That is the same argument M4-D-01 used to put M4b first, and it holds here.

**Re-engagement stays inside WO-15, at stage 3.** Splitting it would land a `deep_link_open` event that nothing reads, which is the worst of the available orderings: a new contract surface with no consumer and therefore no proof it was designed correctly. **AdAttributionKit re-engagement is a separate work order** (§DL-D-29): different framework, different postback family, a publisher-side API we do not control, and a contract change to a closed enum with fixture work of its own.

**Relation to WO-14 (fraud).** WO-15 introduces a device-claimed event and therefore a new fabrication surface (§DL-S-6). It does not depend on WO-14, but the `deep_link_open` event must be inside the evidence surface WO-14's rules can read, and the threat row must state the residual before WO-14 exists.

---

## Principles

These are the sentences the rest of the document is derived from. Each one closes a class of mistake.

**P1. The destination is not evidence; the click identifier is.** A deep link destination tells the app which screen to show. It never decides attribution, never enters a window computation, and never appears in an attribution reason. This is what makes it safe to hand the destination to the device in the Play referrer, where campaign identifiers would not be safe (M2-S-8). If a later change ever makes a destination decide an attribution outcome, this principle has been broken and the change is wrong.

**P2. Routing and attribution are separate concerns with separate latencies.** The app must route on first frame, offline, with no server round trip. Attribution happens on the server, later, from evidence. Adjust reached the same separation from the other direction with optimized deferred deep linking, which delivers the link without waiting for attribution [V-ADJ-ODDL], and Branch keeps a 120-minute deep-linking duration distinct from its 7-day click-to-install window [V-BR-ATTR]. Conflating them is the standard homegrown mistake.

**P3. The SDK never navigates.** It parses, validates, and hands a typed value to a host-registered callback. It does not start an Activity, does not construct a `PendingIntent`, and does not open a URL. This closes the open-redirect and intent-redirection classes at the SDK boundary rather than defending against them, and it keeps the SDK compatible with platform hardening it cannot anticipate.

**P4. The destination is resolved only from stored configuration.** Nothing in a request URL becomes a destination. Request input can only fill placeholders the link definition declared. This is M2-S-6 restated for a new payload, and it is the specific defence CWE-601 asks for — where the archetypal open redirect it describes is a link-tracking endpoint [SEC-CWE601].

**P5. Association files are effectively immutable once links circulate.** Android 15 and later re-verify in the background with changes taking up to seven days to reach devices, and Android 14 and earlier only re-verify on install or update [G-VERIFY]. Apple's CDN pulls within 24 hours and devices refresh roughly weekly [A-ASSOC]. Every commercial vendor warns that changing the link subdomain breaks links already in circulation [V-AF-IOS]. Design for append-only: add an app or a fingerprint, never remove one you still need.

**P6. State the population, not the aggregate.** A direct link open, a deferred destination delivery, and an install attribution are three different measurements of three different populations. They get separate event names, separate metric names, and separate series, for the reason M4-D-19 gives: separate names make a mixed row unconstructible, whereas a shared dimension makes not mixing them a discipline.

---

## Security baseline

### DL-S-1 (DL-D-06, DL-D-07). Where a destination comes from, and its grammar

The destination is the highest-risk new input in this milestone, because a redirector is the archetype the open-redirect literature is written about [SEC-CWE601], and because Android's own risk catalogue names host-validation bypass, cross-app scripting, and remote code execution as the consequences of unvalidated deep link input [G-DEEPRISK].

**Options for where the destination comes from**

- (a) A destination URL supplied as a request parameter, validated against an allowlist.
- (b) A destination stored on the tracking-link definition; no request input influences it.
- (c) (b) plus per-click values that may only fill placeholders the definition declared.

**Recommended: (c).** (b) alone closes the class but forbids the single most valuable game use case — one link template, many destinations, which is what an invite code or an item link needs. (a) is the option that produces a CVE.

**Grammar, and why it is this strict.** `deep_link_value` is a slash-separated path of unreserved characters:

```
^(/[A-Za-z0-9._~-]{1,64}){1,8}$        maximum 256 characters
```

No scheme, no authority, no `//`, no `.` or `..` segment, no query, no fragment, and **no percent-encoding**. Forbidding percent-encoding is deliberate: it removes every double-decode question from the SDK, the redirector, the referrer round trip, and the host app at once. It also means the value can never denote another origin, so there is nothing for the redirector to redirect to and nothing for the SDK to navigate into. This is the security property AppsFlyer reaches by passing an opaque `deep_link_value` plus numbered sub-values rather than a URL [V-AF-LINK]; we reach it with a path-shaped value instead, because a game team routing to `/event/summer` should not have to maintain a token table.

The host app decides whether to treat the value as a path or as an opaque routing token. The contract does not care.

**Per-click parameters.** `deep_link_param_names` on the link definition declares a closed set of names. A request may supply values for declared names only; undeclared names are dropped and counted. Values match `^[A-Za-z0-9._~-]{1,64}$`, at most 10. An undeclared parameter is not an error to the caller — the redirect still succeeds — because a caller-visible error is an enumeration oracle for what a link accepts.

**Creation-time failure, not click-time failure.** A link whose declared template cannot fit the referrer budget (§DL-S-9) is rejected when it is created, with a named error, exactly as M2-S-6 rejects an out-of-allowlist destination at creation.

**Acceptance:** DL-A-03, DL-A-04, DL-A-05.

### DL-S-2 (DL-D-09). The SDK never navigates — and the platform now agrees

This began as a defensive preference. Three current Android rules make it the only correct design.

- **Android 14, target SDK 34 and above:** implicit intents are delivered only to exported components; an implicit launch into a non-exported activity raises `ActivityNotFoundException`, and a mutable `PendingIntent` whose intent names neither component nor package raises an exception [G-A14]. A measurement SDK cannot know whether the host's destination activity is exported.
- **Android 16, all apps regardless of target:** the platform hardens intent redirection by default, with `Intent.removeLaunchSecurityProtection()` as the discouraged opt-out [G-A16]. Parsing a URI out of an intent and re-launching it is precisely the shape being hardened. It is also precisely what a naive deep link SDK does.
- **Android 16, target SDK 36 opt-in:** `intentMatchingFlags` lets a host app require that explicit intents match its declared filters and reject action-less intents [G-A16-36].

So the Android surface is `OpenMasuSdk.setDeepLinkListener(listener)`, and the listener receives a typed `OpenMasuDeepLink(value, params, source, deferred)`. The host app routes. On iOS and Unity the shape is identical. The SDK's contribution is that the value it hands over has already been validated against the grammar above; the host is still expected to validate again, which is Android's own guidance [G-DEEPRISK] and Apple's [A-UL-APP].

**Acceptance:** DL-A-14, DL-A-18.

### DL-S-3 (DL-D-12, DL-D-14). Serving the association files

Both files are public, unauthenticated `GET`s at paths the platforms fix. The deployment serves them from the redirector, on the link host. This is the universal arrangement: AppsFlyer, Branch, Singular, and Adjust all host the association files on their own link domain and require the customer to add that domain to the app's Associated Domains entitlement and `autoVerify` intent filter, and to submit the Android signing fingerprint and the Apple team identifier so the vendor can write them into the hosted file [V-AF-IOS][V-AF-AND][V-BR-UL][V-SNG-PRE][V-ADJ-UL].

The hosting requirements are unforgiving and each has a documented failure mode:

| | Android `assetlinks.json` | iOS `apple-app-site-association` |
| --- | --- | --- |
| Path | `/.well-known/assetlinks.json` [G-ASSETLINKS] | `/.well-known/apple-app-site-association`, no extension; the root-level path was deprecated at WWDC19 [A-ASSOC][A-WWDC19] |
| Transport | HTTPS with a chain to a trusted root, regardless of the intent filter's scheme [G-ASSETLINKS][G-DAL-CREATE] | HTTPS with a valid certificate; custom roots unsupported [A-ASSOC][A-WWDC19] |
| Redirects | **Prohibited.** Stated independently on the configuration page and in the Digital Asset Links specification, and named as a failure cause in the troubleshooting page [G-ASSETLINKS][G-DAL-CREATE][G-TROUBLE] | **Prohibited** [A-ASSOC] |
| Content type | `application/json` required [G-ASSETLINKS][G-DAL-CREATE] | `application/json` stated in the archived guide only; current documentation is silent, and Apple's own properties serve a different type successfully. **Send `application/json`; do not rely on it being enforced** [A-ARCHIVE] |
| Signing | n/a | **Must not be signed.** Signed files were deprecated at WWDC19 [A-WWDC19] |
| Non-200 | Any non-`200` yields an empty statement list [G-DAL-CREATE] | Undocumented; treat as fatal |

Two details are cheap to get wrong and expensive to discover:

- **The redirector's catch-all is a `302`.** `apps/redirector/src/handler.ts` currently returns the configured fallback redirect for every path that is not `GET /r/{slug}`. Serving the association files therefore requires explicit routes ordered **before** the fallback, and the acceptance test must assert a `200` with no `Location` header — because the failure mode of getting this wrong is that verification silently never succeeds and every link opens the browser.
- **The trailing-dot host.** Google's troubleshooting page names serving different content for `example.com.` as a documented failure. DL-A-08 asserts identical bytes for both forms.

**Integrity and freshness.** The files are generated from `control.link_domains` and `control.app_link_identities`, cached in process with a short TTL, and served with a `Cache-Control` chosen for propagation rather than for load. Fingerprints are stored and emitted uppercase; a lowercase fingerprint is a documented failure cause [G-TROUBLE]. Multiple fingerprints per app are supported and expected — Play App Signing means the fingerprint on users' devices is generally not the one a local `keytool` run produces, and the correct value comes from Play Console under Release, Setup, App signing [G-ASSETLINKS].

**Acceptance:** DL-A-06, DL-A-07, DL-A-08, DL-A-09.

### DL-S-4 (DL-D-13). One link host per tenant — and why Android decides this

`assetlinks.json` has **no path scoping**. The relation is `delegate_permission/common.handle_all_urls`: an app listed in the file is authorised for the whole host. Apple's format does have path scoping through `components`, but the weaker platform sets the boundary.

Two consequences make sharing a host across tenants unacceptable:

1. **Every app listed on a host can intercept every link on that host.** Tenant A's app would be authorised for tenant B's measurement links.
2. **On a device, only one app at a time can be associated with a particular domain** [G-VERIFY]. Two tenant apps declaring the same host on one device means one of them silently loses.

**Recommended: `control.link_domains` holds one host per tenant, `UNIQUE` deployment-wide on the host.** The uniqueness constraint is the security property, exactly as `UNIQUE (apple_app_adam_id)` is in M4-S-2: two tenants claiming one host is a configuration error, and the constraint turns it into a registration-time failure rather than a run-time cross-tenant interception.

The redirector therefore resolves the tenant from the `Host` header rather than from `OPENMASU_REDIRECTOR_TENANT_ID`. That is a real change — the current shell fixes the tenant from an environment variable — and it is the same environment-variable scoping problem M3-D-16 unpicked for admin identity, resolved the same way.

**The honest cost, stated plainly:** a deployment measuring three tenants needs three hostnames and three certificates. A single-tenant deployment, which is the common self-host case, needs one and notices nothing.

**Acceptance:** DL-A-10.

### DL-S-5 (DL-D-10). Custom URL schemes

A custom scheme is supported as a fallback and never as the primary channel, for a reason Android states itself: any app may register an intent filter for the same URI, so there is no guarantee the system routes a custom-scheme link to the intended app, and `autoVerify` on an HTTPS host is the documented mitigation [G-DEEPRISK][G-DEEPLINK]. The canonical measurement of how badly this fails in practice is the USENIX Security '17 study of Android deep link security, which found large-scale scheme and host collisions across the Play corpus [SEC-USENIX].

**Two mechanical rules.** A custom scheme must live in a **separate** `<intent-filter>`: Android's configuration guidance is explicit that including other schemes alongside `http`/`https` in an `autoVerify` filter prevents verification [G-ADDLINKS]. And App Links require Android 6 and Google services [G-APPLINKS-ABOUT], so a custom-scheme fallback retains a documented purpose on devices without them.

### DL-S-6 (DL-D-16). What a device-claimed link open does and does not prove

When an installed app opens a Universal Link, **the origin server receives no request**. Apple states that the system routes the link directly to the app without going through the browser or the website [A-UL-ALLOW], and since iOS 14 the only traffic the origin sees for association is Apple's CDN pulling the AASA [A-ASSOC][A-WWDC20]. Android App Links behave the same way: the intent is delivered to the activity; no HTTP fetch occurs.

**There is therefore no server-side click-time hook on an installed-app deep link.** Any record of a direct open is a device claim, and the design must say what that claim is worth.

**Options**

- (a) The SDK calls the redirector to convert the slug into a server-clocked `click`, so direct opens appear in click evidence exactly like browser clicks.
- (b) The SDK reports a typed `deep_link_open` event through the existing signed ingestion path; the server resolves campaign meaning from the slug and never synthesises a click.
- (c) Both.

**Recommended: (b).** (a) is superficially attractive because it preserves one definition of a click, but it is wrong three times over. It adds a new unauthenticated public route to the one surface already hammered by the open internet. It puts a network call on the cold-start path, violating P2. And it would write a `click` with `producer=redirector` and `redirector_click_at` describing a moment the redirector did not observe — a synthesised evidence row, which is the exact failure this project exists to refuse. Under (b) the device claims only what it can honestly claim: an operating system handed it a URL bearing this slug. The server resolves what that slug means. The claim is authenticated by the existing per-installation HMAC credential, arrives through `POST /v1/events/batch`, and needs no new authentication.

**What it does not prove, stated in the threat model rather than implied:** an attacker holding the APK or IPA can enrol installations and deliver fabricated `deep_link_open` events, inflating a re-engagement series. This is M2-S-13 restated for a new event, with the same bounded controls — the per-installation credential, the permanent `event_id` uniqueness constraint, the signature and nonce window — and the same honest limit. It is also a natural rule surface for WO-14.

**Acceptance:** DL-A-15, DL-A-16.

### DL-S-7 (DL-D-11). Who may define a deep link destination

`POST /v1/admin/tracking-links` and the dashboard equivalent both require the `operate` capability today; `admin | operator | read_only` is M5's RBAC.

**Recommended: destinations stay at `operate`; domain and app-identity registration require `administer`.** The split follows the blast radius. A `deep_link_value` is a path-only value that the SDK cannot navigate to and the redirector cannot redirect to (§DL-S-1, §DL-S-2), so an operator creating one can misroute a campaign but cannot send a user off-app. Registering a link host or an app identity changes which application the deployment vouches for on a public, cached, platform-consumed file, and it is effectively irreversible for a week (P5). That belongs with app registration and Apple registration, which are already `administer`.

### DL-S-8. Rate and size limits

Same instrument as M1 D-11, M2-S-5, and M4-S-5: in-process token buckets, no new dependency, refuse before any work.

| Surface | Unit | Proposed default | Environment variable |
| --- | --- | --- | --- |
| `/.well-known/assetlinks.json` | per source IP, memory only | 5 req/s, burst 20 | `OPENMASU_WELLKNOWN_RATE_RPS`, `_BURST` |
| `/.well-known/apple-app-site-association` | per source IP, memory only | 5 req/s, burst 20 | same bucket |
| generated association file | bytes | 65536 | `OPENMASU_WELLKNOWN_MAX_BYTES` |
| `deep_link_value` | characters | 256 | contract, not configurable |
| declared per-click parameters | count | 10 | contract, not configurable |
| encoded Play referrer | characters | 512 | `OPENMASU_REFERRER_MAX_ENCODED_CHARS` |

The association-file bucket is deliberately tight and deliberately per-IP-in-memory, identical to the redirector's existing bucket: these files are fetched rarely by Apple's CDN and by devices at install time, so a high rate is abuse, not traffic. The 65536-byte cap is not a platform limit — **Android documents no size limit for `assetlinks.json` and the Digital Asset Links usage-limits page states there are none** [G-DAL-LIMITS], and Apple's 128 KB figure appears only in the archived guide [A-ARCHIVE] — it is a self-imposed ceiling that fails registration loudly rather than serving a file the platforms may silently reject.

### DL-S-9. The referrer byte budget

The only Google statement of a referrer length limit is 512 characters, URL-encoded, and it appears on the Google Play Games on PC user-acquisition page, which scopes itself to that product [G-GPGPC]. The core Install Referrer pages state no maximum [G-IR][G-IR-LIB][G-IR-AIDL]. M2-S-8 deliberately removed this project's dependency on the unknown by keeping the referrer under 64 bytes; carrying a destination reintroduces the dependency, and that must be said rather than glossed.

Measured against the shipped implementation (`click_id` is 44 base64url characters from 33 CSPRNG bytes):

| Referrer content | Encoded characters |
| --- | --- |
| `omv=1&cid=<44>` (today) | 60 |
| plus a 32-character destination | 102 |
| plus a 64-character destination | 134 |
| plus a 128-character destination | 198 |
| plus a 256-character destination | 326 |

**Recommended:** a configured budget of 512 encoded characters, validated at link creation against the template's maximum expansion, and re-checked at click time. A click-time overflow drops the destination, records `deferred_deep_link_status=omitted_length` on the click, and still redirects — the redirect never fails because a destination did not fit. `click_id` entropy is never reduced to make room; the destination yields first, because P1 says the destination is not evidence and the click identifier is.

The existing `resolveRedirect` guard that throws `referrer_too_long` above 64 bytes becomes the configured budget check. `packages/redirector-core`'s `encodeInstallReferrer` already accepts an `extras` record, so the mechanism exists.

**Acceptance:** DL-A-11, DL-A-12; DL-V-2 records the observed limit.

### DL-S-10. What this milestone does not claim

Stated once, plainly, in `docs/threat-model.md` under the extended components:

- **No deferred deep linking on iOS, by design, not by omission.** An operator running an iOS-only campaign gets direct deep linking for installed users and nothing for new users.
- **A `deep_link_open` event is a device claim.** It proves an authenticated installation reported a URL bearing this slug; it does not prove a human tapped a link.
- **Fabricated `deep_link_open` events inflate the re-engagement series.** Bounded by the same controls as M2-S-13 and visible in the same reports; integrity evidence is M5's reserved surface and live configuration is operator work.
- **Deferred-destination delivery is not guaranteed.** The referrer can be absent, the destination can be dropped for length, and Google documents that the referrer changes on reinstall [G-IR-LIB]. Coverage is measured (§DL-V-3), not asserted.
- **A tenant can still point a link at a harmful in-app destination.** The grammar prevents leaving the app; it does not audit the operator's own screens.

---

## Architecture

### Repository layout additions

```text
apps/
  api/                     # + link-domain and app-identity registration routes
                           # + deep-link fields on tracking-link creation
  redirector/              # + /.well-known/assetlinks.json
                           # + /.well-known/apple-app-site-association
                           # + Host-header tenant resolution
                           # + /r/{slug}/<deep_link_value> path suffix
  worker/                  # + deep_link_open projection and engagement attribution
packages/
  redirector-core/         # + destination grammar, parameter binding, referrer budget
  app-association/         # NEW: pure assetlinks.json and AASA generation, no I/O
sdk/
  android/deeplink/        # NEW module: intent parsing, referrer destination recovery
  ios/Sources/OpenMasuDeepLink/   # NEW target: NSUserActivity and URL parsing
  unity/com.openmasu.sdk/  # + deep-link callback over the existing dispatcher
docs/validation/
  deeplink-device-checklist.md    # NEW
```

`packages/app-association` is pure for the same reason `packages/meta-install-referrer` and `packages/apple-postback` are: it turns a registration set into two JSON documents with no clock, no database, and no I/O, which is what makes DL-A-06 and DL-A-07 possible against synthetic registrations.

`sdk/android/deeplink` is a separate Gradle module rather than a `core` addition, so an app that wants first-party measurement and no deep linking pulls no intent-handling code. Same rule as `installreferrer` and `max`.

### DL-D-08. The measurement URL shape

The single most consequential small decision, because one URL must be readable by a browser, by an installed app offline, and by a platform that may rewrite it.

**Options**

- (a) `https://<host>/r/<slug>` with the destination as a query parameter, as AppsFlyer's `deep_link_value` and Branch's `$deeplink_path` do [V-AF-LINK][V-BR-REF].
- (b) `https://<host>/r/<slug>/<deep_link_value>` — the destination is a path suffix.
- (c) `https://<host>/r/<slug>` only; the app must ask the server what the destination is.

**Recommended: (b), with declared query parameters as a best-effort addition.** Two reasons, and the second is not obvious.

The first is offline routing (P2). Under (b) an installed app that receives the URL knows the destination immediately, with no network call. Under (c) the app must round-trip on cold start, which fails exactly when connectivity is poor.

The second is that **query parameters are not reliably delivered on iOS.** When AdAttributionKit re-engagement passes a URL to an advertised app, the system appends its own marker parameter and strips parameters it recognises as tracking parameters before delivery [A-AAK-RECEIVE][A-AAK-PARAM]. A design that puts the destination in the query would work today and break the moment the deployment enables the AdAttributionKit re-engagement path this same document designs (§DL-D-29). Putting the destination in the path makes the two compatible by construction.

So: **the path suffix is authoritative and survives; declared query parameters are best-effort and their absence is recorded, never inferred.** When the URL carries no suffix, the link definition's own `deep_link_value` is used — so a campaign with one destination needs no suffix at all.

The redirector route becomes `^/r/([A-Za-z0-9_-]{12,64})(/.*)?$`, and the suffix is validated against the grammar in §DL-S-1 before anything else happens.

### DL-D-15. Route precedence, and the same-host trap

Three ordering rules in the redirector shell, all of which fail silently if wrong:

1. `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` are matched **before** the `/r/` route and **before** the catch-all fallback, and return `200` with no `Location`.
2. Unknown paths keep returning the byte-identical fallback `302` (M2-S-6), so the new routes do not become an enumeration oracle for which tenants exist. A request for a well-known path on an **unregistered** `Host` returns the same `404` as a registered host with no apps — not a `302`, because a redirect on these paths is itself a documented verification failure.
3. **The web fallback page must not be on the link host.** Apple documents that tapping a Universal Link while already browsing the same domain in Safari opens it in Safari rather than the app, and that opening your own Universal Link from your own app does not open your app [A-UL-ALLOW]. Branch works around this by issuing every customer a second `-alternate` domain [V-BR-UL]. Our exposure is narrower — the redirector serves `302`s, not pages — but `OPENMASU_REDIRECTOR_FALLBACK_URL` must point at a different host, and the configuration check should say so rather than leaving an operator to discover that their fallback page's links stopped opening the app.

### Runtime shape

No new Compose service and no new port. `redirector` gains three routes and `Host`-based tenant resolution; `api` gains two registration routes; `worker` gains one projection and one attribution branch. The default topology stays `postgres`, `migrate`, `api`, `worker`, `redirector`.

---

## Direct deep linking

### DL-D-17. Android receiving surface

The host app declares an `autoVerify` intent filter for the link host and forwards the intent to the SDK:

```xml
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="http" />
  <data android:scheme="https" />
  <data android:host="links.example.com" />
</intent-filter>
```

Both schemes are required in the filter even though the redirector serves only HTTPS; Android's configuration guidance requires `http` and `https` together and warns that adding any other scheme prevents verification [G-ADDLINKS]. Declaring several `<data>` elements in one filter merges them into every combination, so a deployment with more than one host uses separate filters [G-ADDLINKS].

The SDK entry point is `OpenMasuSdk.handleDeepLink(intent)`. It:

1. rejects any URI whose host is not a configured link host (configured through the same manifest meta-data mechanism as `COLLECTION_ENABLED_DEFAULT`);
2. parses slug and suffix, validates the suffix against the grammar, and binds declared parameters;
3. delivers `OpenMasuDeepLink` to the host listener **synchronously on the calling thread**, before any queue or network work, so routing is never behind delivery;
4. enqueues a `deep_link_open` event.

Step 3 before step 4 is the ordering that matters: a user must reach their screen whether or not measurement succeeds.

**Verification failure is a first-class state, not an error.** From Android 12, a generic web intent resolves to the app only if the app is approved for that domain; otherwise it goes to the browser [G-A12]. That is the graceful path — the browser reaches the redirector, the redirector issues a click and sends the user to the store, and Play offers "Open". Nothing breaks; the open is simply not measured as a direct open. The SDK exposes `verificationState()` over `DomainVerificationManager` so an integrator can diagnose it, and the sample app prints it. Two related facts belong in the integrator documentation because they change what an operator should expect: on Android 12 and later verification is per host, so one bad host no longer poisons the others, while on Android 11 and earlier a single unverifiable host fails them all [G-ADDLINKS][G-TROUBLE].

**Acceptance:** DL-A-17, DL-A-18.

### DL-D-18. iOS receiving surface

The entitlement entry is `applinks:links.example.com`. Apple's guidance is to list the top-level domain and, where needed, the subdomain, with no path, query, or trailing slash, and each subdomain needs its own entitlement entry and its own association file [A-CONFIG][A-ASSOC].

The SDK offers two entry points because **UIKit and SwiftUI deliver Universal Links differently, and this is the integration mistake that costs a day**:

- UIKit and AppKit deliver an `NSUserActivity` of type `NSUserActivityTypeBrowsingWeb` through `application(_:continue:restorationHandler:)` or `scene(_:continue:)`, with the URL in `webpageURL` [A-UL-APP];
- **SwiftUI delivers a Universal Link directly as a `URL` through `onOpenURL(perform:)`**, and Apple's own documentation for `onContinueUserActivity` redirects the reader to `onOpenURL` for this case [A-SWIFTUI-OPEN][A-SWIFTUI-CONT].

So the surface is `handleDeepLink(_ userActivity: NSUserActivity)` and `handleDeepLink(_ url: URL)`, with identical downstream behaviour. An SDK that only accepted `NSUserActivity` would silently never fire in a SwiftUI app.

Everything else mirrors Android: host allowlist from `Info.plist`, grammar validation, synchronous delivery to the host closure, then enqueue.

**Development mode is an operator trap worth one sentence in the checklist.** `applinks:links.example.com?mode=developer` lets a development-signed app work against a host whose certificate is not yet trusted, but the query string must be removed before App Store submission [A-CONFIG].

**Acceptance:** DL-A-19.

### DL-D-19. Unity surface

The existing `OpenMasuDispatcher` already marshals background callbacks onto the Unity main thread for both platforms (M2-D-25, M4-D-26). The deep link callback uses it unchanged: `OpenMasuClient.SetDeepLinkListener(Action<OpenMasuDeepLink>)`, delivered through `PumpCallbacks()`.

One platform-specific piece is unavoidable. Unity's Android activity must forward `onNewIntent`; the UPM package's `.androidlib` therefore ships an activity subclass and the documentation states the two-line alternative for teams with their own activity. On iOS, the existing `OnPostProcessBuild` step that writes the Apple postback keys also writes the Associated Domains entitlement — which means an integrator does not hand-edit a generated project, and DL-A-20 asserts it against a generated-project fixture, exactly as M4-A-32 does for the postback keys.

**Acceptance:** DL-A-20.

### DL-D-20. Routing when collection is disabled or consent is withdrawn

The sharp question, and the wrong answer is easy to reach by analogy.

`setCollectionEnabled(false)` stops event generation and delivery, and M2-D-23 requires it be honoured before any other initialisation. Consent withdrawal purges queued consent-required events.

**Recommended: destination delivery to the host app is never suppressed; the `deep_link_open` event is suppressed exactly like every other event.** The reasoning is that the two things are different in kind. Routing the user to the screen they asked for is the app's own function, performed on data the operating system just handed the app, with nothing collected and nothing transmitted. Suppressing it would break the product for a user who withheld measurement consent — turning a privacy choice into a degraded experience, which is precisely the pattern consent regimes exist to prevent. The measurement of that open is collection, and it is suppressed.

Concretely: `handleDeepLink` parses and delivers regardless of collection state; the enqueue step returns early. Under withdrawal, `processing_purpose_id` for `deep_link_open` is `attribution`, so a withdrawn installation's opens are rejected server-side by the existing withdrawal gate with no new mechanism.

The Android deferred path needs one extra rule for the same reason: the SDK must not read the Install Referrer while collection is disabled (M2-D-23, asserted by A-17). So a disabled-at-first-launch installation **cannot** receive a deferred destination — the referrer is never read. That is a real product consequence, it is the correct one, and it must be documented rather than worked around.

**Acceptance:** DL-A-21.

---

## Android deferred deep linking

### DL-D-21. What the referrer carries

Today the referrer is `omv=1&cid=<click_id>`. It gains one key:

```
omv=1&cid=<click_id>&dl=<deep_link_value>
```

Declared parameters, when present, are appended as additional keys with a `dlp_` prefix. The whole string is percent-encoded exactly once when the Play URL is built and decoded exactly once by the SDK, and the existing round-trip test (M2's A-04) is extended to cover the new keys, because "how many times is this encoded" remains the classic way this breaks. The byte budget that governs how much can be carried is §DL-S-9.

**Why this is safe, and why the same reasoning would not justify carrying campaign identifiers.** M2-S-8 rejected a self-authenticating referrer carrying campaign dimensions, because that trusts the device's copy of the campaign assignment — a synthesised join presented as evidence. A destination is different in kind (P1): it is a UX instruction, not a claim about who earned the install. A tampered `dl` sends the tamperer to a different screen in their own app. A tampered `cid` still fails to resolve, and attribution is still decided server-side from the click the redirector wrote. **The device may carry instructions; it may not carry evidence.** If a future change ever puts something in the referrer that decides an outcome, this paragraph is the one it has to argue with.

`GooglePlayReferrerReader.details()` already splits the referrer on `&` and extracts `cid`; extracting `dl` and `dlp_*` is the same loop.

**This is deliberately not Google's own mechanism, and the difference is worth recording.** Google Analytics for Firebase implements deferred deep linking by fetching the configured deep link from a server at app start and caching it in a preferences file [G-GA4F]. That is option (c) of §DL-D-08 — a network round trip on first launch — and this design rejects it for P2's reason. Naming the divergence keeps a later reader from assuming we simply did not know.

**Acceptance:** DL-A-11, DL-A-22.

### DL-D-22. Deferred routing TTL

A destination recovered from the referrer can be stale: the referrer is retained for 90 days [G-IR-LIB], and opening a user on a campaign page from three weeks ago is a bad experience, not a measurement error.

**Options**

- (a) No TTL; always route.
- (b) A separate short routing TTL, as Branch's 120-minute deep-linking duration and AppsFlyer's 15-minute unified-deep-link fast path do [V-BR-ATTR][V-AF-UDL].
- (c) A TTL equal to the attribution window.

**Recommended: (c), 7 days, configurable per link.** The industry's two-number model exists because their routing mechanism (matching) and their attribution mechanism have genuinely different reliability profiles. Ours do not: the destination and the click identifier travel in the same string through the same channel. Making the routing TTL equal the attribution window means **a user is never routed to a campaign destination for a click that did not attribute**, which is one number to explain instead of two, and it removes an entire class of "why does the report not match the experience" question.

The measurement is from `redirector_click_at` to first launch. Because the attribution window is measured to `install_begin_at_server`, which precedes first launch, a narrow band exists where attribution is valid and routing has expired. That is real and it is recorded rather than hidden: `install.deferred_deep_link_status=expired`.

`install.deferred_deep_link_status` is a closed, evidence-only field — `not_applicable | absent | delivered | expired | rejected` — and it never changes attribution, exactly as `referrer_client_response` does not. It is what makes coverage computable from install records alone, which is the number an operator actually needs (§DL-V-3).

### DL-D-23. Exactly-once consumption, reinstall, and identifier reset

The destination is consumed once. The SDK already persists a "referrer consumed" flag in the backup-excluded subtree (M2-D-22); the delivered destination is recorded in the same place, and a second launch delivers nothing.

Two interactions must be settled explicitly rather than inherited:

- **Identifier reset must not re-deliver.** M2-D-22 forbids re-reading the referrer after a reset, because that would re-attribute one acquisition twice. The same flag suppresses re-delivery of the destination, and DL-A-21 asserts it alongside the existing reset assertions.
- **Reinstall is an open question, and the widely repeated answer is not documented.** Google states that the referrer does not change unless the application is reinstalled [G-IR-LIB] — which reads as the reinstall's own referrer replacing the prior value. The common industry claim that a reinstall returns the *original* install's referrer was not found on any Google page in this pass. The design does not depend on the answer: `install_type=reinstall` is a separate install record with its own `prior_installation_id`, and whichever referrer arrives is treated as that record's evidence. DL-V-2 observes the actual behaviour.

---

## iOS deferred deep linking

### DL-D-24. Not offered, and the options that were examined

**Recommended: iOS deferred deep linking is not offered, and the public documentation says so in plain words rather than by omission.** The wording, for `README.md` and `docs/product-scope.md`:

> On iOS, OpenMasu delivers deep links to users who already have the app, using Universal Links. It does not deliver a deep link to a user who installs the app after tapping a link. Every mechanism that would make that possible either requires deriving an identifier from device signals, which Apple's Developer Program License Agreement prohibits and which this project does not do, or requires a user-visible prompt on first launch. If Apple provides a channel that carries a destination through installation, OpenMasu will use it.

Four alternatives were examined. Recording them matters more than the conclusion, because the next person to ask this question should find the analysis rather than repeat it.

1. **Probabilistic matching from IP and User-Agent.** Forbidden by `docs/privacy-security.md` and by M4-D-02, and — the part that is not about our principles — prohibited by the Apple Developer Program License Agreement in terms that extend rejection risk to any app referencing such an SDK [A-PRIVACY].
2. **The pasteboard.** This was Firebase Dynamic Links' actual mechanism, and Google documented both the technique and its cost, including that disabling it degraded the match to `weak` [G-FDL-IOS]. It is now doubly unavailable: from iOS 16 a programmatic read raises an approval alert before the app gets the contents [A-PASTECTL], and the prompt-free `detectPatterns` path can report that a URL is present but cannot return it [A-PATTERNS][A-VALUES]. Branch kept the technique alive behind a paste-control interstitial [V-BR-PASTE], which is honest — the user's tap is real consent — and is exactly the kind of first-launch modal a measurement SDK should not put in someone else's app. **The SDK links no pasteboard symbol; M4-A-25's forbidden-symbol audit already asserts this and gains no exception.** An operator who wants a user-mediated code entry can build it in host-app code and hand the value to the SDK.
3. **A first-party claim code.** The redirector could mint a short human-enterable code bound to a `click_id`, display it on the web landing page, and accept it back from the app. It is deterministic and user-mediated, and it is genuinely different from fingerprinting. It is also a channel whose carrier is the user, which means a code can be shared, and it would produce iOS install attribution for arbitrary networks — reopening M4-D-02's headline through a side door. **Not adopted.** Recorded here with its design so that if an owner ever wants it, the discussion starts from what it is: a weaker evidence class that would need its own attribution method name and its own honest label, never presented as equivalent to Install Referrer.
4. **Apple Ads campaign-level destinations.** A deployment already receives a verified AdServices response server-side for Apple Ads installs (M4-S-7), carrying `campaignId` and `adGroupId`. Mapping a campaign to a destination server-side would be a deterministic, Apple-verified deferred destination with no device claim and no matching whatsoever. It is the only iOS deferred mechanism this analysis found that survives every rule in this project. It is also campaign-granular rather than per-click, and it needs the SDK to wait for a server round trip on first launch — violating P2 — because the AdServices lookup is a worker step with a documented retry policy. **Not adopted in WO-15; see the owner question in the decisions memo.**

### DL-D-25. App Clips

Apple provides exactly one mechanism where a destination survives installation, and it is real. An App Clip receives an invocation URL, writes what it needs into a shared App Group container or keychain, and when the user installs the full app it replaces the App Clip and receives every subsequent invocation in its place [A-CLIP-INVOKE][A-CLIP-SHARE].

**Recommended: documented as the one Apple-sanctioned path and not built in WO-15.** The reason is cost, not soundness. It requires a second shipping target, an App Store Connect App Clip experience configuration per destination, and it forbids wildcard association domains. It also only fires where an App Clip invocation is offered, which is not a generic ad click. For a mobile game studio, the ratio of effort to reachable users is poor today.

The consequence of recording it is that this project's "iOS has no deferred channel" sentence is precise rather than sweeping: **iOS has no *general* deferred channel; it has one that costs a second app target.**

---

## Re-engagement attribution

### The impossibility statement, before the design

**Deterministic re-engagement attribution is available exactly when the operating system hands the link to the app.** Everything else is unavailable, and the reason is structural rather than a limitation of this milestone:

- **The Play Install Referrer does not fire for an existing install.** It reports the install's referrer for 90 days and does not change unless the app is reinstalled [G-IR-LIB]. A user who taps a link inside an in-app browser, is bounced to Play, and taps "Open" delivers no new referrer.
- **An unverified or unapproved domain sends the web intent to the browser** on Android 12 and later [G-A12]. The redirector then records a real click — and that click can never be paired with the app open that follows, because pairing an anonymous browser click to a specific installed device is device matching.

So the honest series is: **direct link opens are measured; browser-mediated re-engagement is not.** A click with no paired open appears in click evidence with nothing attached, which is the correct and visible outcome.

This also disposes of the industry's re-engagement *window* for us. AppsFlyer's default re-engagement window is 30 days [V-AF-RETG], Adjust's reattribution window is 7 days [V-ADJ-WIN]; both exist to bound a matching interval. We have no interval to bound: the click and the open are the same instant.

### DL-D-26. The subject scope of a re-engagement decision

**Options**

- (a) `subject_scope=installation_level` with a new method.
- (b) A new `subject_scope=engagement_level` with an `engagement:` subject namespace.
- (c) A separate `re-engagement-result` schema alongside `attribution-result`.

**Recommended: (b).** (a) is disqualified by a specific mechanical consequence: the contract already establishes that an installation has one attribution identity, and any consumer that selects "the attribution for installation X" would begin returning two rows with different methods. Cohort ROAS is built on exactly that selection. (c) duplicates roughly twenty-five fields — supersession, evidence references, finality, rule-bundle identity, the three timestamps — and duplication is its own drift source; the M4 lesson was that the *names* need separating, not the machinery.

Under (b): `subject_scope=engagement_level`, `subject_ref` matching `^engagement:`, `method=deep_link`, `model=last_click`, statuses `non_organic | unattributed`. The evaluator's existing namespace check gains a third branch, and the existing `aggregate_installation_join_forbidden` mechanism generalises without a new instrument.

Installation identity lives in the evidence, not in the subject reference: the `deep_link_open` record carries `installation_id`, the attribution's `evidence_refs` point at it, and the projection carries it for reporting. So "which installations were reactivated" is answerable, and "the attribution for installation X" stays unambiguous.

**Reason codes.** Four, and the fourth is the one that prevents double counting:

| Reason | Status | Meaning |
| --- | --- | --- |
| `deep_link_open_attributed` | `non_organic` | The slug resolved to an active link in the authenticated scope. |
| `deep_link_unknown_link` | `unattributed` | The slug resolved to nothing. |
| `deep_link_link_inactive` | `unattributed` | The link is paused or archived. |
| `deep_link_install_click_reused` | `unattributed` | The click identifier on this open is the click that attributed this installation's install record. |

**Acceptance:** DL-A-23, DL-A-24.

### DL-D-27. Install attribution is never re-credited

AppsFlyer documents that in-app events inside the re-engagement window are credited to both the retargeting source and the original acquisition source [V-AF-RETG]. That is a defensible product choice for a vendor whose customers want it. It is also the mechanism by which two reports of the same business disagree by construction.

**Recommended: an engagement-scope result never modifies, supersedes, or re-credits an installation-scope result.** No re-attribution, no window in which an install changes owner, no cohort revenue counted twice.

The industry's distinction survives without new machinery. AppsFlyer's discriminator is app presence, not time: a retargeting click that leads to an app open is re-engagement, and one that leads to a reinstall is re-attribution [V-AF-RETG]. In this design, re-attribution is already handled — a reinstall produces a new install record with `install_type=reinstall` and its own click chain, evaluated by the ordinary window rules. So we have both concepts, and only one of them needed anything new.

`deep_link_install_click_reused` is the guard. On Android, a deferred open carries the click identifier that also drove the install; without the rule, one click would produce both an install attribution and a re-engagement attribution. The worker checks `ledger.install_facts.click_id` for the same installation and, on a match, emits `unattributed` with that reason — a recorded, queryable decision rather than a silent skip.

### DL-D-28. Inactivity is evidence, not an attribution window

The industry does not agree on this number, and the disagreement is not small: Adjust defaults its inactivity period to 7 days, Branch to 90, and AppsFlyer ships it off [V-ADJ-WIN][V-BR-ATTR][V-AF-INACT]. There is no standards-body definition; the IAB, MMA, and MRC mobile in-app measurement guidelines cover impression counting and viewability, not retargeting attribution [SEC-MRC].

**Recommended: the worker computes `days_since_last_session` from the installation's own session history and stores it on the projection; the attribution decision does not use it.** Three reasons:

- A threshold baked into an attribution artifact cannot be changed without re-deciding attribution. A threshold applied at report time can be changed by changing a report.
- The pure evaluator stays pure. Computing inactivity requires reading session history, which would make `packages/attribution-core` stateful in a new way. Keeping it in the worker preserves the property M4-A-10 gates on.
- When three vendors' defaults span 7 to 90 days to off, picking one and calling it attribution asserts a certainty nobody has.

`ledger.session_facts` already carries the index this needs — `(tenant_id, app_id, installation_id, occurred_at_ts)` — so the computation is one indexed lookup per open.

**A reactivation cohort metric with an inactivity threshold is deliberately not in WO-15.** It needs a new `calculation` value in the metric-definition schema plus matching SQL, TypeScript, and Python implementations. That is real work with a real parity gate, and bundling it would turn an additive contract patch into a semantic one. Recorded as a handoff.

### DL-D-29. AdAttributionKit re-engagement

M4 put this out of scope and named the reason: Apple gates it behind a separate impression flag, a separate publisher API, and a separate developer-copy opt-in. This pass verified all three and pinned the version, which M4 could not: **every re-engagement symbol is iOS 18.0**, not 17.4 and not 18.4 — `AppImpression.handleTap(reengagementURL:)`, `AppImpression.eligibleForReengagement`, `Postback.reengagementOpenURLParameter`, `PostbackUpdate.ConversionType`, and the `EligibleForAdAttributionKitReengagementPostbackCopies` property-list key [A-AAK-TAP][A-AAK-PLIST].

Four facts decide the placement:

1. **It is layered on Universal Links.** Apple requires the re-engagement URL to be a Universal Link registered to the advertised app; if it is not, the framework discards the URL and launches the app normally [A-AAK-TAP]. **So this milestone's association-file work is a hard prerequisite, and doing it in the reverse order would be impossible.**
2. **The developer copy is available**, but behind a second opt-in on top of `AttributionCopyEndpoint` [A-AAK-PLIST][A-AAK-CONFIG].
3. **It is click-only and has no losing copies** [A-AAK-RECEIVE], so M4-S-12's "no win rate may be derived" statement extends unchanged.
4. **Apple's own two pages spell the value differently** — the postback field reference documents `re-engagement` with a hyphen and shows it in the decoded sample, while the receiving guide writes `reengagement` [A-AAK-PARAMS][A-AAK-RECEIVE]. Any implementation must accept both and normalise.

**Recommended: a separate work order after WO-15.** The contract change widens `adattributionkit_postback.conversion_type`, which is an enum addition and therefore non-breaking, but it needs its own fixture and its own reason-code path, and the conversion-value window for re-engagement differs from the install case [A-AAK-RECEIVE]. Doing it here would mean a second contract patch inside one work order for a capability that cannot be exercised until the association files it depends on are live.

---

## Contract extensions

### DL-D-30. Version and shape

**Recommended: `v0.4.7`, an additive patch under R-27's standing authority.** Every change below matches `docs/schema-versioning.md`'s non-breaking list — adding an optional field, adding an enum value, or adding a new independent schema or registry entry that existing artifacts need not use. No existing golden changes, no `$id` changes, no `schema_version` bump, and existing event-version constants stay `0.4.0`, following the pattern of `0.3.2` through `0.3.6`.

A `v0.5` line would be wrong twice: it would assert a break that does not exist, and it would force every consumer to migrate schemas, registries, fixtures, and evaluators as one unit for a feature they may not use.

**New schema — `schemas/events/deep-link-open.schema.json`**

| Field | Required | Notes |
| --- | --- | --- |
| `event_name` | yes | `const: "deep_link_open"` |
| `installation_id` | yes | |
| `session_id` | no | present when the host has an active session |
| `open_source` | yes | closed: `android_app_link \| ios_universal_link \| custom_scheme \| android_deferred_referrer` |
| `link_slug` | conditional | required unless `open_source=android_deferred_referrer` |
| `click_id` | conditional | required when `open_source=android_deferred_referrer`; forbidden otherwise |
| `deep_link_value` | no | the grammar in §DL-S-1 |
| `deep_link_params` | no | closed typed-scalar map, at most 10, the `custom_event.attributes` shape |
| `destination_status` | yes | closed: `delivered \| absent \| expired \| rejected` |
| `opened_at_device` | no | evidence only, never a window input |
| `extensions` | no | same reserved-name rules as `click` |

**Registry and enum additions**

| Target | Addition |
| --- | --- |
| `registries/event-names-v0.4.json` | `deep_link_open` |
| `registries/reason-codes-v0.4.json` → `attribution` | `deep_link_open_attributed`, `deep_link_unknown_link`, `deep_link_link_inactive`, `deep_link_install_click_reused` |
| `registries/compatibility-v0.4.json` | `engagement_level × deep_link × last_click × [non_organic, unattributed]` |
| `attribution-result.subject_scope` | `engagement_level`, with `subject_ref` pattern `^engagement:` in a third `allOf` branch |
| `attribution-result.method` | `deep_link` |
| `attribution-result.reason_code` | the four above; `reason_code_version` stays `const: "0.4.0"` |
| `click.schema.json` | optional `deep_link_value`; optional closed `deferred_deep_link_status = carried \| omitted_length \| omitted_platform \| not_configured` |
| `install.schema.json` | optional closed `deferred_deep_link_status = not_applicable \| absent \| delivered \| expired \| rejected`, evidence only |
| `metric-definition.schema.json` → `event_names` | `deep_link_open` |

**Metric names.** `daily_deep_link_opens`, and `daily_deep_link_opens_by_status` using the existing `attribution_status` grouping dimension. Separate names, never a dimension inside the deterministic install metrics — M4-D-19's rule, and DL-A-24 extends M4-A-12's gate so that no metric definition references both an engagement-scope and an installation-scope name.

**Spec text.** `spec/event-metric-contract-v0.4.md` gains a "Deep links and re-engagement" subsection under Attribution stating: the destination is never attribution evidence; `deep_link_open` is device-reported and its campaign meaning is resolved server-side from the slug; an engagement-scope result never supersedes or re-credits an installation-scope result; and `deep_link_install_click_reused` is the double-count guard.

---

## Data model additions

Same conventions as M1, M2, and M4: `control.identifier`, `control.canonical_timestamp`, `FORCE`d RLS, append-only `*_states` plus a `*_current` view.

```sql
-- One link host per tenant (DL-S-4). The deployment-wide UNIQUE is the control.
CREATE TABLE control.link_domains (
  tenant_id     control.identifier PRIMARY KEY,
  host          text NOT NULL CHECK (host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  registered_at control.canonical_timestamp NOT NULL,
  artifact      jsonb NOT NULL,
  UNIQUE (host)
);

-- What the association files vouch for (DL-S-3).
CREATE TABLE control.app_link_identities (
  tenant_id                  control.identifier NOT NULL,
  app_id                     control.identifier NOT NULL,
  android_package_name       text CHECK (android_package_name IS NULL
                               OR android_package_name ~ '^[A-Za-z][A-Za-z0-9_.]{2,254}$'),
  android_sha256_fingerprints text[] NOT NULL DEFAULT '{}',   -- uppercase, colon-separated
  apple_team_id              text CHECK (apple_team_id IS NULL OR apple_team_id ~ '^[A-Z0-9]{10}$'),
  apple_bundle_id            text CHECK (apple_bundle_id IS NULL
                               OR apple_bundle_id ~ '^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$'),
  registered_at              control.canonical_timestamp NOT NULL,
  artifact                   jsonb NOT NULL,
  PRIMARY KEY (tenant_id, app_id),
  FOREIGN KEY (tenant_id, app_id) REFERENCES control.apps (tenant_id, app_id),
  UNIQUE (android_package_name),
  UNIQUE (apple_team_id, apple_bundle_id),
  CHECK (array_length(android_sha256_fingerprints, 1) IS NULL
         OR array_length(android_sha256_fingerprints, 1) <= 8)
);

ALTER TABLE control.tracking_links
  ADD COLUMN deep_link_value text
    CHECK (deep_link_value IS NULL
           OR (length(deep_link_value) <= 256
               AND deep_link_value ~ '^(/[A-Za-z0-9._~-]{1,64}){1,8}$')),
  ADD COLUMN deep_link_param_names text[] NOT NULL DEFAULT '{}',
  ADD COLUMN deferred_deep_link_ttl_seconds integer NOT NULL DEFAULT 604800
    CHECK (deferred_deep_link_ttl_seconds BETWEEN 0 AND 7776000);

CREATE TABLE ledger.deep_link_open_facts (
  logical_event_id text PRIMARY KEY REFERENCES ledger.logical_events (logical_event_id),
  tenant_id        control.identifier NOT NULL,
  app_id           control.identifier NOT NULL,
  installation_id  text NOT NULL,
  tracking_link_id control.identifier,          -- resolved server-side; NULL when unresolved
  campaign_id      text,
  open_source      text NOT NULL,
  occurred_at      control.canonical_timestamp NOT NULL,
  occurred_at_ts   timestamptz GENERATED ALWAYS AS
                     (control.canonical_timestamp_value(occurred_at)) STORED,
  days_since_last_session integer,              -- worker-computed evidence (DL-D-28), not contract
  artifact         jsonb NOT NULL
);

CREATE INDEX deep_link_open_facts_dimensions_idx
  ON ledger.deep_link_open_facts (tenant_id, app_id, campaign_id, occurred_at_ts);
```

`UNIQUE (android_package_name)` and `UNIQUE (apple_team_id, apple_bundle_id)` are deployment-wide for M4-S-2's reason: a published app has one owner, so two tenants claiming it is a configuration error, and the constraint turns it into a registration-time failure rather than a run-time cross-tenant vouching.

**Threat-model rows.** `npm run check:threat-model` requires a row per `docs/architecture.md` component. Extend the existing `redirector`, `sdk-android`, `sdk-ios`, and `unity-bridge` rows rather than adding new components — the association-file routes and the deep link surfaces are new responsibilities of existing components, not new trust boundaries. Add one component, `app-association`, for the generation package.

---

## Local runtime and CI additions

**Compose.** No new service. New variables, all in `.env.example` with a generator command because `npm run test:env-coverage` fails otherwise: `OPENMASU_REFERRER_MAX_ENCODED_CHARS`, `OPENMASU_WELLKNOWN_RATE_RPS`, `OPENMASU_WELLKNOWN_RATE_BURST`, `OPENMASU_WELLKNOWN_MAX_BYTES`, `OPENMASU_WELLKNOWN_CACHE_SECONDS`, `OPENMASU_REDIRECTOR_LINK_HOST_MODE` (`host_header | fixed_tenant`, defaulting to `host_header`, with the fixed mode retained for single-tenant deployments behind a proxy that rewrites `Host`).

Bootstrap prints the two well-known URLs alongside the existing admin key, redirector URL, MAX template, and Apple postback endpoints, so an operator can paste them straight into a verification tool.

**CI.** `runtime.yml` carries all of stages 0–3: association-file generation, serving, route precedence, destination grammar, referrer budget, ingestion, engagement attribution, and metric separation are all TypeScript on the existing Linux job. `sdk-android.yml` gains intent-parsing and referrer-recovery JVM tests plus one emulator assertion that the sample's **merged** manifest carries the `autoVerify` filter — a merged-manifest assertion for the same reason M2's A-12 and A-13 exist, because a manifest merge failure here is silent. `sdk-ios.yml` gains the `NSUserActivity` and `URL` entry points and a generated-entitlement assertion. The Unity `dotnet` compile probe gains the deep link callback type.

---

## Acceptance criteria

Written as commands and observable outcomes. The M1 D-30 principle applies unchanged: **anything requiring a real device, a real store listing, real domain verification, or a real campaign is an operator procedure, never a code gate.**

### Stages 0–3 — synthetic, code gates, Linux

**DL-A-01 — contract gate.** `npm run validate` prints its updated summary line exactly once, in the stage 0 commit; `git diff --stat -- fixtures/v0.4/` shows only the new fixture directory and no change to any existing `expected_*.json`.

**DL-A-02 — evaluator parity.** The new engagement branch produces byte-identical JCS output from the TypeScript and Python evaluators for every new fixture case.

**DL-A-03 — destination grammar.** A table of 40 candidate values asserts acceptance and rejection: `/a`, `/shop/item/1`, and an 8-segment 256-character value accept; `..`, `//`, `a`, `/a//b`, `/a/../b`, `/a?b`, `/a#b`, `%2F`, `http://x`, `//evil.example`, a 9th segment, a 65-character segment, and a 257-character total all reject with a named error.

**DL-A-04 — no open redirect through a destination.** A request carrying `?destination=`, `?url=`, `?next=`, `?dl=`, or an undeclared parameter cannot change the `Location` header or the referrer's `dl` value. Creating a link whose `deep_link_value` is outside the grammar fails at creation with a named error.

**DL-A-05 — declared parameters only.** Values for declared names bind; undeclared names are dropped and counted; a value outside the value charset is dropped; the response is byte-identical whether an undeclared parameter was supplied or not.

**DL-A-06 — `assetlinks.json` generation.** From synthetic registrations, the generated file is a JSON array whose every element has `relation` exactly `["delegate_permission/common.handle_all_urls"]`, `target.namespace` `"android_app"`, a package name, and an uppercase colon-separated fingerprint array. Two apps on one tenant produce two elements. A lowercase fingerprint is rejected at registration.

**DL-A-07 — AASA generation.** The generated file has an `applinks.details` array; every entry's `appIDs` values are `<team>.<bundle>`; `components` entries carry a `/` pattern; no `paths` key is emitted. The file parses under a strict JSON parser and contains no comment or trailing comma.

**DL-A-08 — serving is verification-shaped.** `GET /.well-known/assetlinks.json` and `GET /.well-known/apple-app-site-association` return `200` with `content-type: application/json`, **no `Location` header**, and no `Set-Cookie`. A `Host` with a trailing dot returns byte-identical content. An unregistered `Host` returns `404`, not `302`. The AASA path is served with no file extension. Exceeding the well-known bucket returns `429`.

**DL-A-09 — route precedence.** With a tracking link whose slug is `well-known000`, the well-known paths still resolve to association files, and `/r/well-known000` still resolves to a redirect. Adding a route cannot shadow either.

**DL-A-10 — one host, one tenant.** Registering a host already registered to another tenant fails at registration with a named error. A redirect request for tenant A's slug on tenant B's host returns the fallback and writes no click.

**DL-A-11 — referrer budget.** For a destination that fits, the referrer round-trips through one percent-encoding and one decoding with `cid`, `dl`, and every `dlp_*` value unchanged, and the encoded length is at or under `OPENMASU_REFERRER_MAX_ENCODED_CHARS`. For a destination that does not fit, the redirect still returns `302`, the referrer contains `cid` and no `dl`, and the click records `deferred_deep_link_status=omitted_length`. Creating a link whose maximum expansion exceeds the budget fails at creation.

**DL-A-12 — `click_id` entropy is never traded.** With the budget set to its own minimum, `click_id` still matches `^[A-Za-z0-9_-]{22,128}$` and 10,000 redirects still produce 10,000 distinct values.

**DL-A-13 — non-Android and destination-less paths.** A non-Android user agent still receives the configured fallback and no referrer is built. A link with no `deep_link_value` produces `deferred_deep_link_status=not_configured` and a referrer byte-identical to today's.

**DL-A-15 — `deep_link_open` ingestion.** A signed batch carrying a `deep_link_open` returns `202`, the logical event and projection appear after the worker drains, and the projection carries the resolved `tracking_link_id` and `campaign_id`. An open naming an unresolvable slug produces `unattributed/deep_link_unknown_link` and a projection row with a NULL `tracking_link_id` — never a rejection, because an unresolvable slug is evidence.

**DL-A-16 — the device cannot claim campaign meaning.** A `deep_link_open` payload carrying `campaign_id`, `tracking_link_id`, or any `provider_*` name is rejected by the schema. A payload naming a slug belonging to another tenant resolves to nothing in the authenticated scope and produces `deep_link_unknown_link`, never a cross-tenant read.

**DL-A-23 — engagement scope cannot be joined to an install.** Every attribution the deep link path produces has `subject_scope=engagement_level` and `subject_ref` matching `^engagement:`. An engagement result carrying `installation:` in `subject_ref` is rejected. No engagement result ever sets `supersedes_attribution_id` to an installation-scope attribution, and no installation-scope attribution is modified by any deep link path — asserted by comparing every install attribution row byte for byte before and after a re-engagement run.

**DL-A-24 — double counting is unconstructible.** An Android deferred open whose `click_id` equals the click that attributed the installation produces `unattributed/deep_link_install_click_reused`, and the installation's cohort revenue is unchanged. No metric definition references both an engagement-scope and an installation-scope metric name; a test that constructs one fails at definition time.

**DL-A-25 — inactivity is evidence.** `days_since_last_session` is present on the projection, is computed from `session_facts` only, and appears in **no** contract artifact — asserted by scanning every emitted artifact for the field name.

**DL-A-26 — configuration and threat-model coverage.** `npm run test:env-coverage` and `npm run check:threat-model` pass with the new variables and the `app-association` component.

### Stages 4–6 — synthetic, code gates, device toolchains

**DL-A-14 — the SDK never navigates.** A source and built-symbol audit over `sdk/android/deeplink` finds no `startActivity`, `PendingIntent`, `Intent#setData` on an outbound intent, or `removeLaunchSecurityProtection`; over `sdk/ios` it finds no `UIApplication.open` and, as M4-A-25 already asserts, no `UIPasteboard`. This is the same instrument as M4-S-8: a built-artifact audit, not a review.

**DL-A-17 — Android intent parsing.** A table drives every case: a URL on a configured host with a valid suffix delivers a listener call before any enqueue; a URL on an unconfigured host delivers nothing and enqueues nothing; an invalid suffix delivers `destination_status=rejected` with a null value and still enqueues; a URL with no suffix uses the link definition's value only after server resolution and delivers `absent` locally.

**DL-A-18 — delivery precedes measurement.** With the transport replaced by a fake that blocks forever, the listener still fires within 50 ms on the calling thread.

**DL-A-19 — iOS receives both shapes.** An `NSUserActivity` of type `NSUserActivityTypeBrowsingWeb` and a bare `URL` both reach the listener with identical values. A `URL` on an unconfigured host reaches nothing.

**DL-A-20 — manifests and entitlements survive generation.** The Android sample's **merged** manifest contains the `autoVerify` filter with both schemes, `VIEW`, `DEFAULT`, `BROWSABLE`, and the configured host, and contains no custom scheme inside that filter. The generated Xcode project fixture contains `com.apple.developer.associated-domains` with `applinks:<host>` and no `?mode=` query string.

**DL-A-21 — disablement, consent, and reset.** With collection disabled, a deep link still reaches the listener, no request leaves the SDK, and no Install Referrer read occurs. After `resetInstallationId()`, no deferred destination is delivered a second time. After consent withdrawal, queued `deep_link_open` events are purged with the other consent-required purposes and the server rejects a later one.

**DL-A-22 — referrer recovery.** A fake Install Referrer returning `omv=1&cid=…&dl=…&dlp_code=…` yields one listener call with `deferred=true` and one `deep_link_open` with `open_source=android_deferred_referrer`; a referrer with `cid` and no `dl` yields no listener call and `install.deferred_deep_link_status=absent`; a referrer whose click is older than the TTL yields `expired` and no listener call.

### Operator-verified — `docs/validation/deeplink-device-checklist.md`, not code gates

Recording a dated pass or fail and an opaque private reference is the deliverable. Hosts, package names, fingerprints, team identifiers, campaign values, and destinations stay outside the public repository, exactly as `docs/validation/real-data-checklist.md` requires.

**DL-V-1 — Android verification on a real device.** After installing from a real track, `adb shell pm get-app-links <package>` reports `verified` for the host. Record the observed propagation delay, whether `pm verify-app-links --re-verify` was needed, and the Android version. Repeat on an Android 11 device to observe the all-or-nothing behaviour, and on Android 12+ to observe per-host verification.

**DL-V-2 — Android deferred end to end, and the reinstall question.** Tap a real measurement link with a destination, install from Play, confirm the destination is delivered on first launch with no network. Then **reinstall and record which referrer is returned** — this settles the undocumented behaviour named in §DL-D-23. Record the longest referrer that survived intact, which also settles M2's V-5.

**DL-V-3 — deferred coverage over one week.** The distribution of `install.deferred_deep_link_status` across real installs. This is the number that tells an operator whether the feature works, and no synthetic gate can produce it.

**DL-V-4 — iOS Universal Links on a real device.** Confirm the app opens from Safari, from Messages, and from a third-party app; confirm it does **not** open when tapping a link on a page already served from the link host [A-UL-ALLOW]; confirm Apple's CDN serves the association file at `https://app-site-association.cdn-apple.com/a/v1/<host>` — **noting that this endpoint is undocumented by Apple and was verified live only on 2026-08-21**. Record the observed propagation delay against Apple's stated 24-hour CDN pull and roughly weekly device refresh.

**DL-V-5 — association-file change propagation.** Add a second app to both files and record how long each platform takes to honour it. Confirm that nothing regresses for the first app. **Do not test removal on a production host.**

**DL-V-6 — App Store submission.** Submit a sample with Associated Domains enabled and no `?mode=developer` string. Record any reviewer question.

**DL-V-7 — Unity export.** Export from a UPM reference on each supported Unity version. Record whether the Android activity forwarding and the iOS entitlement injection worked without hand-editing.

**DL-V-8 — re-engagement in practice over four weeks.** Record the ratio of `deep_link_open` events to clicks, and the share of opens carrying `deep_link_install_click_reused`. A high reuse share means the deferred and direct paths are overlapping in a way the design did not anticipate, and it is an input to the next milestone rather than a bug to close.

---

## Decided design

| # | Decision | Recommendation |
| --- | --- | --- |
| DL-D-01 | What this milestone claims | Deterministic direct deep linking on both platforms; deterministic deferred on Android only; no iOS deferred, stated plainly in public documentation |
| DL-D-02 | Amending the M2 non-goal declaration | Do not delete it; append a dated cross-reference in both directions. `docs/product-scope.md` never excluded deep linking, so nothing is retracted |
| DL-D-03 | M4-D-02 | Preserved unchanged. It forbids deferred-deep-link *matching*; neither direct nor Android-deferred linking performs matching |
| DL-D-04 | Milestone and staging | Seven stages, one PR each; stages 0–3 Linux-only and standalone; WO-15 does not depend on WO-14 but its events must be inside WO-14's rule surface |
| DL-D-05 | Re-engagement placement | Inside WO-15 at stage 3; AdAttributionKit re-engagement is a separate work order |
| DL-D-06 | Where the destination lives | On the link definition; path-only grammar, no percent-encoding, 256 characters, 8 segments |
| DL-D-07 | Per-click values | Declared parameter names only; undeclared dropped and counted; creation-time failure |
| DL-D-08 | Measurement URL shape | `/r/<slug>[/<deep_link_value>]`; path suffix authoritative, query best-effort, because iOS strips tracking parameters on re-engagement opens |
| DL-D-09 | SDK navigation | The SDK never navigates; it hands a typed value to a host listener |
| DL-D-10 | Custom schemes | Fallback only, in a separate intent filter, never mixed into the `autoVerify` filter |
| DL-D-11 | Who may define a destination | Destinations at `operate`; host and app-identity registration at `administer` |
| DL-D-12 | Association-file serving | Generated from the control plane by a pure package, served by the redirector, `200` with no redirect |
| DL-D-13 | Link host scope | One host per tenant, `UNIQUE` deployment-wide; the redirector resolves tenant from `Host` |
| DL-D-14 | Association-file lifecycle | Append-only in practice; add before removing; propagation is up to a week on both platforms |
| DL-D-15 | Route precedence and hosts | Well-known paths before `/r/` and before the fallback; the web fallback must not be on the link host |
| DL-D-16 | Direct opens | A typed `deep_link_open` event through the existing signed path; never a synthesised `click` |
| DL-D-17 | Android surface | `handleDeepLink(intent)`, host allowlist, deliver before enqueue, `DomainVerificationManager` exposed for diagnosis |
| DL-D-18 | iOS surface | Both `NSUserActivity` and bare `URL`, because SwiftUI delivers Universal Links through `onOpenURL` |
| DL-D-19 | Unity surface | One callback over the existing dispatcher; activity forwarding shipped in the `.androidlib`; entitlement written by the existing post-processor |
| DL-D-20 | Disablement and consent | Routing is never suppressed; measurement is. A disabled first launch cannot receive a deferred destination |
| DL-D-21 | Referrer payload | `dl` and `dlp_*` beside `cid`; the device may carry instructions, never evidence |
| DL-D-22 | Deferred TTL | Equal to the attribution window, 7 days, per-link configurable; one number instead of the industry's two |
| DL-D-23 | Consumption | Exactly once, in the existing consumed flag; no re-delivery after identifier reset; reinstall behaviour is observed, not assumed |
| DL-D-24 | iOS deferred | Not offered; four alternatives examined and recorded with their reasons |
| DL-D-25 | App Clips | The one Apple-sanctioned surviving path; documented, not built |
| DL-D-26 | Re-engagement subject | New `subject_scope=engagement_level` with an `engagement:` namespace; not a second installation-scope attribution |
| DL-D-27 | Install attribution | Never re-credited, never superseded; `deep_link_install_click_reused` is the guard |
| DL-D-28 | Inactivity | Worker-computed evidence on the projection, not an attribution window; no vendor consensus exists |
| DL-D-29 | AdAttributionKit re-engagement | Separate work order; all symbols are iOS 18.0; Universal Links are a hard prerequisite; both spellings of the conversion type must parse |
| DL-D-30 | Contract | `v0.4.7` additive patch under R-27; new schema, new registry entries, new enum values, no golden changes |

---

## Handoffs

### To the contract (all inside WO-15 stage 0, all non-breaking under R-27)

Listed in `docs/schema-versioning.md`'s terms so the migration ledger entry writes itself: one new independent schema, four new reason codes, one new compatibility row, three new enum values on `attribution-result`, one new event name, one new metric-definition enum value, and three new optional fields on existing events.

### To the runtime and the repository

| Target | Change | Why |
| --- | --- | --- |
| `apps/redirector/src/handler.ts` | Resolve the tenant from `Host` rather than `OPENMASU_REDIRECTOR_TENANT_ID`; keep the fixed mode behind a flag | DL-S-4 needs per-tenant hosts; this is the same environment-variable scoping problem M3-D-16 unpicked for admin identity |
| `packages/redirector-core/src/index.ts` | Replace the hard-coded 64-byte `referrer_too_long` guard with the configured budget; extend `encodeInstallReferrer` callers | The `extras` parameter already exists; only the guard blocks the feature |
| `spec/event-metric-contract-v0.4.md` | The `permission_error` sentence currently says the value was not found in the Android client response-code reference. That remains true of the reference page, but the Install Referrer **release notes** document its addition in library 2.2 [G-IR-NOTES]. Correct the sentence to name the release notes as the source and keep the value | The contract states a negative that is now partly disproven; leaving it invites a later reader to remove a valid value |
| `docs/architecture.md` | Add the two well-known routes and the `/r/{slug}/<value>` shape to the Redirector section; add an `app-association` component marker; extend the Android flow diagram with the deferred destination | `check:threat-model` fails without the component row, and the flow diagram is where a new reader learns the mechanism |
| `docs/privacy-security.md` | State: the destination is never attribution evidence; the SDK links no pasteboard symbol and why; routing is not suppressed by collection disablement while measurement is; association files are public and contain package names, team identifiers, and signing fingerprints by design | Three of these four are non-obvious, and the fourth is a question every security reviewer asks |
| `docs/product-scope.md` | Add deep linking to Phase 1 measurement links and to the adapter boundary; add the iOS deferred sentence from §DL-D-24 verbatim | The document never excluded deep linking, so this is an addition, not a retraction |
| `docs/roadmap.md` and `docs/project-plan.md` | Add the milestone and its crosswalk in one change; keep the milestone name byte-identical here, in `privacy-security.md`, and in `threat-model.md` | `AGENTS.md` |
| `docs/references.md` | New Android App Links, Digital Asset Links, Universal Links, Associated Domains, AdAttributionKit re-engagement, and pasteboard entries dated 2026-08-21 | The current Google and Apple sections contain none of the pages this milestone depends on |
| `docs/design/m2-baseline.md` | Append the dated cross-reference of §DL-D-02 to line 48 | The amendment procedure |
| `docs/design/m4-baseline.md` | Append a dated pointer next to the re-engagement out-of-scope bullet and next to "Not verified" item 18, both naming this document | Item 18 predicted this request; closing the loop is what makes the earlier document trustworthy |
| `.env.example` | The six new variables | `npm run test:env-coverage` fails otherwise |

### To later work orders

- **AdAttributionKit re-engagement** (§DL-D-29), after WO-15.
- **A reactivation cohort metric** with an inactivity threshold, needing a new `calculation` value and three implementations (§DL-D-28).
- **Apple Ads campaign-level deferred destinations** (§DL-D-24 item 4), if the owner wants it.
- **App Clip destination handoff** (§DL-D-25), if the owner wants it.
- **A fraud rule surface over `deep_link_open`** (WO-14), because a fabricated open inflates the re-engagement series.

---

## References

All URLs fetched and checked on **2026-08-21** unless noted. Items marked **unverified** are stated as unverified and are never the basis for a design that would break if they turn out otherwise. Apple documentation was read through the DocC JSON backing store because the rendered pages return only a title to automated fetching, the same method M4 used.

### Google and Android

| Tag | URL | What was confirmed |
| --- | --- | --- |
| G-APPLINKS-ABOUT | `https://developer.android.com/training/app-links/about` | App Links require Android 6 and Google services. The guide has been split into `about`, `add-applinks`, `configure-assetlinks`, `verify-applinks`, `test-applinks`, `troubleshoot`, `tools`; earlier URLs redirect. |
| G-ADDLINKS | `https://developer.android.com/training/app-links/add-applinks` | `autoVerify="true"` required; the filter must include both `http` and `https`; other schemes in the same filter prevent verification; `exported="true"`; `VIEW` + `BROWSABLE` + `DEFAULT`; multiple `<data>` elements merge into all combinations; wildcard hosts require the file at the root host; Android 12+ verifies per host while Android 11 and earlier fail all hosts if one fails. |
| G-ASSETLINKS | `https://developer.android.com/training/app-links/configure-assetlinks` | Path, HTTPS regardless of the filter's scheme, `application/json`, no redirects, multiple fingerprints per app, multiple apps per host, one file per host, and Play App Signing as the fingerprint source (Play Console → Release → Setup → App signing). |
| G-VERIFY | `https://developer.android.com/training/app-links/verify-applinks` | Verification runs at install on Android 6+; the device queries each host; Android 15+ re-verifies in the background with changes taking up to seven days; Android 14 and earlier only re-verify on install or update; `pm get-app-links`, `pm verify-app-links`, `pm set-app-links`; verification states; only one app per domain per device. |
| G-TROUBLE | `https://developer.android.com/training/app-links/troubleshoot` | Documented failure causes: redirects, lowercase fingerprints, debug-vs-release signing, wrong Play signing key, missing `autoVerify`, and a trailing-dot host serving different content. |
| G-DEEPLINK | `https://developer.android.com/training/app-links/deep-linking` | Custom schemes give no routing guarantee; App Links are recommended for your own domains. |
| G-DEEPRISK | `https://developer.android.com/privacy-and-security/risks/unsafe-use-of-deeplinks` | Host-validation bypass, cross-app scripting, and remote code execution as consequences; `autoVerify` and parameter allowlisting as the mitigations; check authentication state before exposing data. |
| G-DAL-CREATE | `https://developers.google.com/digital-asset-links/v1/create-statement` | `application/json` in the headers; redirects not followed; a non-200 or an unverifiable certificate chain yields an empty statement list. |
| G-DAL-LIMITS | `https://developers.google.com/digital-asset-links/v1/limits` | **No usage limits are documented.** This is the basis for stating that no `assetlinks.json` size limit exists rather than inventing one. |
| G-A12 | `https://developer.android.com/about/versions/12/behavior-changes-all` | From Android 12 a generic web intent resolves to the app only if the app is approved for the domain; otherwise the default browser. |
| G-A14 | `https://developer.android.com/about/versions/14/behavior-changes-14` | Target SDK 34: implicit intents are delivered only to exported components; a mutable `PendingIntent` naming neither component nor package throws. |
| G-A16 | `https://developer.android.com/about/versions/16/behavior-changes-all` | Android 16 hardens intent redirection for all apps regardless of target, with `Intent.removeLaunchSecurityProtection()` as a discouraged opt-out. |
| G-A16-36 | `https://developer.android.com/about/versions/16/behavior-changes-16` | Target SDK 36: `intentMatchingFlags` with `enforceIntentFilter`, `allowNullAction`, `none`. |
| G-IR | `https://developer.android.com/google/play/installreferrer` | Client and server referrer timestamps and the first-install version. |
| G-IR-LIB | `https://developer.android.com/google/play/installreferrer/library` | Library `2.2`; referrer available for 90 days and unchanged unless the app is reinstalled; call once on the first execution after install. |
| G-IR-AIDL | `https://developer.android.com/google/play/installreferrer/igetinstallreferrerservice` | The seven response-Bundle keys. |
| G-IR-NOTES | `https://developer.android.com/google/play/installreferrer/release-notes` | `2.2` (2021-01-14) added the `PERMISSION_ERROR` response constant. The library has had no release since. |
| G-GPGPC | `https://developer.android.com/games/playgames/user-acquisition` | The referrer must be URL-encoded and 512 characters or fewer. **This page scopes itself to Google Play Games on PC; the general Play pages state no maximum — treat 512 as a documented-but-scoped design budget.** |
| G-FDL | `https://firebase.google.com/support/dynamic-links-faq` | Shutdown on 2025-08-25; links return `404`; migration guidance names commercial providers for parity and App Links / Universal Links for the installed case only. |
| G-FDL-IOS | `https://firebase.google.com/docs/dynamic-links/ios/receive` | Firebase Dynamic Links used the pasteboard for the deferred case; iOS 14 raised a notification; disabling retrieval degraded `matchType` to `weak` at best. |
| G-GA4F | `https://support.google.com/google-ads/answer/12373942` | Google Analytics for Firebase implements deferred deep linking by fetching the configured link at app start and caching it, not through the referrer. Google Ads Help rather than developer documentation. |
| G-DATASAFETY | `https://support.google.com/googleplay/android-developer/answer/10787469` | Collection includes data transmitted by third-party SDKs; sharing includes on-device transfers to other apps. Nothing in Play policy constrains a destination in the referrer; carrying user data in it, or joining it to persistent identifiers, is constrained. |

### Apple

| Tag | URL | What was confirmed |
| --- | --- | --- |
| A-ASSOC | `https://developer.apple.com/documentation/xcode/supporting-associated-domains` | AASA at `/.well-known/apple-app-site-association`; HTTPS with a valid certificate and no redirects; **Apple's CDN requests the file within 24 hours and devices check for updates roughly weekly after installation**; each subdomain needs its own entitlement entry and its own file; `details` applies only to `applinks`. |
| A-WWDC19 | `https://developer.apple.com/videos/play/wwdc2019/717/` | Signed AASA files and non-`.well-known` paths are deprecated; custom roots unsupported. |
| A-WWDC20 | `https://developer.apple.com/videos/play/wwdc2020/10098/` | From iOS 14 the origin server receives AASA requests only from Apple's CDN. |
| A-ARCHIVE | `https://developer.apple.com/library/archive/documentation/General/Conceptual/AppSearch/UniversalLinks.html` | **Archived.** The only Apple source for `application/json` on AASA and for the 128 KB size limit. Both are therefore **unverified for current iOS**; the design sends `application/json` and caps at 64 KiB without depending on either. |
| A-APPLINKS | `https://developer.apple.com/documentation/bundleresources/applinks` and its `details`, `components`, `defaults`, `substitutionvariables` pages | `appIDs` and legacy `appID`; `components` keys `/`, `?`, `#`, `exclude`, `comment`, `caseSensitive` (default true), `percentEncoded` (default true); first match wins; `defaults` and `substitutionVariables` with the predefined variable set. |
| A-CONFIG | `https://developer.apple.com/documentation/xcode/configuring-an-associated-domain` | Entitlement format `<service>:<domain>`; no path, query, or trailing slash; wildcard prefix supported except for App Clips; `?mode=developer` and `managed`; **the query string must be removed before App Store submission**. |
| A-UL-APP | `https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app` | `NSUserActivityTypeBrowsingWeb`, `webpageURL`, and the instruction to validate all URL parameters. |
| A-UL-ALLOW | `https://developer.apple.com/documentation/xcode/allowing-apps-and-websites-to-link-to-your-content` | **The system routes a universal link directly to the app without going through the browser or the website** — so the origin sees no request. Without the app installed, the browser opens the URL. Tapping a universal link while already browsing the same domain opens it in Safari; opening your own universal link from your own app does not open your app. |
| A-SWIFTUI-OPEN | `https://developer.apple.com/documentation/swiftui/view/onopenurl(perform:)` | SwiftUI passes a Universal Link directly as a `URL`, not as an `NSUserActivity`. |
| A-SWIFTUI-CONT | `https://developer.apple.com/documentation/swiftui/view/oncontinueuseractivity(_:perform:)` | Directs the reader to `onOpenURL` for Universal Links. |
| A-AAK-PARAMS | `https://developer.apple.com/documentation/adattributionkit/identifying-the-parameters-in-a-postback` | The complete field set; **no destination field of any kind**; `conversion-type` documented as `download`, `redownload`, `re-engagement`, with the hyphenated form in the decoded sample. |
| A-AAK-TAP | `https://developer.apple.com/documentation/adattributionkit/appimpression/handletap(reengagementurl:)` | iOS 18.0. Delivers a URL only if the advertised app is installed, and **only if the URL is a Universal Link registered to that app**; otherwise the URL is discarded and the app launches normally. |
| A-AAK-RECEIVE | `https://developer.apple.com/documentation/adattributionkit/receiving-ad-attributions-and-postbacks` | Re-engagement is click-only; there are no non-winning re-engagement postbacks; the system appends its own open marker and **strips known tracking parameters before delivering the URL**; the developer copy is an exact copy of the winning postback; the guide spells the conversion type without a hyphen, conflicting with the field reference. |
| A-AAK-PARAM | `https://developer.apple.com/documentation/adattributionkit/postback/reengagementopenurlparameter` | iOS 18.0; the marker parameter is always present. |
| A-AAK-PLIST | `https://developer.apple.com/documentation/bundleresources/information-property-list/eligibleforadattributionkitreengagementpostbackcopies` | The separate Boolean opt-in for developer copies of re-engagement postbacks; iOS 18.0. |
| A-AAK-CONFIG | `https://developer.apple.com/documentation/adattributionkit/configuring-an-advertised-app` | `AttributionCopyEndpoint`; registrable domain only; winning copies only. |
| A-AAK-WINDOWS | `https://developer.apple.com/documentation/adattributionkit/receiving-postbacks-in-multiple-conversion-windows` | Windows days 0–2 / 3–7 / 8–35; 24–48 h delay on the first postback and 24–144 h on the others. |
| A-SKSP | `https://developer.apple.com/documentation/storekit/skstoreproductparametercustomproductpageidentifier` and the sibling parameter pages | The complete product-page parameter set carries no destination. |
| A-CPP | same | The custom-product-page identifier selects a store page and is readable only through App Store Connect. |
| A-CLIP-INVOKE | `https://developer.apple.com/documentation/appclip/responding-to-invocations` | Installing the full app replaces the App Clip, and the system launches the full app for each invocation. |
| A-CLIP-SHARE | `https://developer.apple.com/documentation/appclip/sharing-data-between-your-app-clip-and-your-full-app` | Shared App Group container and keychain survive the upgrade; the full app receives all later invocations. |
| A-PASTECTL | `https://developer.apple.com/documentation/uikit/uipastecontrol` | From iOS 16, programmatic pasting raises a user alert before the app gains access to pasteboard contents. |
| A-PATTERNS | `https://developer.apple.com/documentation/uikit/uipasteboard/detectpatterns(for:completionhandler:)-23vwn` | Pattern detection does not notify the user, because it never gives the app the contents. `probableWebURL` is among the patterns. |
| A-VALUES | `https://developer.apple.com/documentation/uikit/uipasteboard/detectvalues(for:completionhandler:)-6adre` | Value detection does notify the user, because it does give the app the contents. |
| A-PRIVACY | `https://developer.apple.com/app-store/user-privacy-and-data-use/` | Quotes the Developer Program License Agreement prohibiting deriving data from a device to uniquely identify it, and extends rejection risk to apps referencing such SDKs, naming ad networks, attribution services, and analytics. **The App Store Review Guidelines themselves contain no fingerprinting language and defer to the agreement; cite this page, not guideline 5.1.2.** |

### Vendor documentation and secondary sources

Cited as prior art and as evidence of what the market does, never as technical authority over a platform.

| Tag | URL | What it establishes |
| --- | --- | --- |
| V-AF-DDL | `https://support.appsflyer.com/hc/en-us/articles/360014821438` | iOS deferred deep linking uses IDFA or IDFV when available and probabilistic modeling otherwise. |
| V-AF-LINK | `https://support.appsflyer.com/hc/en-us/articles/207447163` | `deep_link_value`, `deep_link_sub1`–`sub10`, `af_dp`, `af_web_dp`, `af_r`, `is_retargeting`. |
| V-AF-UDL | `https://dev.appsflyer.com/hc/docs/dl_work_flow` | A 15-minute click-to-install lookback on the fast deferred path; the deferred payload is restricted to the opaque value and its sub-values. |
| V-AF-RETG | `https://support.appsflyer.com/hc/en-us/articles/207033786` | Re-engagement versus re-attribution is discriminated by app presence; re-engagement window defaults to 30 days; in-app events in the window are credited to both sources. |
| V-AF-INACT | `https://support.appsflyer.com/hc/en-us/articles/360009305817` | The retargeting inactivity window defaults to off. |
| V-AF-IOS | `https://dev.appsflyer.com/hc/docs/dl_ios_init_setup` | The vendor hosts the AASA on its own link domain; changing the subdomain breaks circulating links. |
| V-AF-AND | `https://dev.appsflyer.com/hc/docs/dl_android_init_setup` | The vendor hosts `assetlinks.json` and requires the customer's SHA-256 signing fingerprint. |
| V-ADJ-WIN | `https://help.adjust.com/en/article/attribution-windows` | Click attribution 7 days; reattribution 7 days; **inactivity period defaults to 7 days**; probabilistic modeling is opt-in. |
| V-ADJ-ODDL | `https://help.adjust.com/en/article/optimized-deferred-deep-linking-oddl` | Delivers the deferred link without waiting for attribution — the routing/attribution separation. |
| V-ADJ-UL | `https://help.adjust.com/en/article/set-up-universal-links` | Vendor-hosted AASA on `go.link` / `adj.st`. |
| V-BR-ATTR | `https://help.branch.io/marketer-hub/docs/branch-attribution-explained` | Click-to-install 7 days; **deep-linking duration 120 minutes**; re-engagement inactivity 90 days. |
| V-BR-METH | `https://help.branch.io/marketer-hub/docs/branch-methodology-overview` | A confidence ladder ending in probabilistic click-through and view-through. |
| V-BR-MATCH | `https://www.branch.io/resources/blog/nativelink-solution-to-challenges-caused-by-ios-15/` | `+match_guaranteed` as a per-link confidence boolean. Marketing material; the mechanism is real, the accuracy claim is not verifiable. |
| V-BR-PASTE | `https://help.branch.io/developer-hub/docs/ios-advanced-features` | The pasteboard path survives behind `UIPasteControl` and an interstitial. |
| V-BR-REF | `https://help.branch.io/marketer-hub/docs/deep-link-reference` | `$deeplink_path`, `$canonical_url`, `$fallback_url`, `$uri_redirect_mode`, `$match_duration`. |
| V-BR-UL | `https://help.branch.io/developer-hub/docs/ios-universal-links` | Four entitlement domains per customer including an `-alternate` host, which exists because iOS does not open the app from a universal link on the domain already being browsed. |
| V-SNG-DL | `https://support.singular.net/hc/en-us/articles/360050910891` | iCloud Private Relay breaks probabilistic attribution because the click and install IP addresses differ — the clearest vendor confirmation that IP matching is the load-bearing mechanism. |
| V-SNG-PRE | `https://support.singular.net/hc/en-us/articles/360031371451` | Vendor-hosted AASA requires the customer's Team ID; Android uses path prefixes plus the SHA-256 fingerprint. |
| SEC-CWE601 | `https://cwe.mitre.org/data/definitions/601.html` and `https://owasp.org/www-community/attacks/open_redirect` | Generic redirect endpoints left over from marketing or link tracking are the archetype of this weakness. |
| SEC-MASTG-A | `https://mas.owasp.org/MASTG/tests/android/MASVS-PLATFORM/MASTG-TEST-0028/` | Deep link testing: a valid Digital Asset Links file over HTTPS for every host; wildcard hosts must serve at the root; pre-Android-12 all-or-nothing verification. |
| SEC-MASTG-I | `https://mas.owasp.org/MASTG/tests/ios/MASVS-PLATFORM/MASTG-TEST-0070/` | Universal link parameters must be validated and malformed URLs discarded. |
| SEC-USENIX | `https://www.usenix.org/conference/usenixsecurity17/technical-sessions/presentation/liu` | Liu, Wang, Pico, Yao, Wang, USENIX Security '17, on large-scale deep link scheme and host collisions across the Play corpus. **The specific collision counts were read from search-index excerpts, not from the paper body — verify verbatim before quoting a number.** |
| SEC-MRC | `https://mmaglobal.com/documents/mobile-application-advertising-measurement-guidelines-v20` | The IAB/MMA/MRC mobile in-app guidelines cover impression counting and viewability. **No retargeting or re-engagement definition was located; PDF text extraction failed.** Treated as evidence that no standards-body definition exists, not as a citation for one. |

## Not verified

Stated as unverified rather than assumed. None blocks starting WO-15, and each names how it is settled.

1. **Whether `Content-Type: application/json` is enforced for AASA on current iOS.** Only the archived guide states it, and Apple's own properties serve a different type successfully. The design sends the correct type; nothing depends on enforcement.
2. **The 128 KB AASA size limit.** Archived only. The 64 KiB self-imposed cap is below any plausible platform limit, so this decision cannot be invalidated by the answer.
3. **Whether iOS still falls back to the root-level AASA path.** Declared deprecated at WWDC19 with removal promised. The design serves `.well-known` only, so it does not matter.
4. **Any limit on associated domains per app, or on hosts an Android app may verify.** No current documentation on either platform. Archived Apple guidance suggested keeping the list to roughly 20–30.
5. **Whether a free Apple Account can enable the Associated Domains capability.** Not stated in primary sources. DL-V-6 observes it.
6. **`app-site-association.cdn-apple.com/a/v1/<domain>`.** Undocumented by Apple; verified live on 2026-08-21 to return `200` with `application/json` for two Apple domains. Used as a checklist tool, never as a dependency.
7. **Whether Google's servers or the device fetch `assetlinks.json` for on-device verification.** The documentation describes the device querying each host. **Do not IP-allowlist the well-known routes**; assume many device addresses.
8. **The 512-character referrer limit for general Play links.** Documented only on the Play Games on PC page. DL-V-2 records the longest string observed intact, which also settles M2's V-5.
9. **Whether a reinstall returns the original install's referrer.** Google's only statement implies the opposite. The design does not depend on the answer; DL-V-2 observes it.
10. **Whether `utm_source=google-play&utm_medium=organic` is Google's organic marker.** Not found on any Google page. The contract already treats `play_organic_marker` as a deployment mapping, which remains correct.
11. **The integer value of the Install Referrer `PERMISSION_ERROR` constant.** Documented in the release notes, absent from the reference page. Switch on the constant; never hard-code a number.
12. **The exact Android 13 page and anchor for intent-filter matching of external intents.** Reached through a search excerpt only. Nothing in this design depends on it beyond the Android 14 and 16 rules, which were read directly.
13. **Every number in the DL-S-8 limits table and the 7-day deferred TTL.** Proposed defaults and thresholds, not measurements — the same status as M2-S-5 and M4-S-5.
14. **Whether Unity's Android activity forwarding and iOS entitlement injection work without hand-editing.** The exact analogue of M2-D-25's `.androidlib` question and M4-D-26's Swift-source question, settled the same way: by building (DL-V-7).
15. **Whether an operator's real deferred-destination coverage is high enough for the feature to be worth its integration cost.** DL-V-3 is the only thing that answers it, and a low number would be a design-level finding rather than a documentation fix.
