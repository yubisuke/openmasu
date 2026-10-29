# Deep Link and Re-engagement Design

Status: implemented and synthetically verified. See
[Project status](../STATUS.md) for the evidence vocabulary and open operator
gates.

## Capability statement

Direct deep linking is deterministic on Android and iOS. Deferred deep linking
is deterministic on Android through Install Referrer. OpenMasu does not offer
iOS deferred deep linking.

## Link ownership and destinations

An operator can **Pause**, **Resume**, or **Archive** a measurement link from the
dashboard. `POST /v1/admin/apps/<app-id>/tracking-links/<link-id>/resume` resumes
only a paused link, keeping its slug, destination and original link record.
Pause emits no click; the first ordinary open after resume records a click again.
Archived links remain terminal. Concurrent or repeated resume has one successful
transition and a conflict for the other operation, not duplicate history. Each
successful transition and its audit entry are committed atomically; the existing
app scope, operate capability and dashboard CSRF protections apply.

Operators can preview a registered link without recording a click from its
dashboard **Preview without recording a click** link, or read
`GET /v1/admin/apps/<app-id>/tracking-links/<link-id>/preview?platform=android`.
The explicit platform is `android`, `ios` or `other`; optional `path` uses the
same bounded direct-path grammar, and `dlp_<name>` accepts only registered
parameter names. Duplicate/unknown query fields are refused. Invalid parameter
values are dropped by the ordinary binder and shown as a count.

The reader-only projection uses the live shared resolver and configured fallback
URL/referrer budget. It shows destination, paused/archived/platform/path fallback,
permitted parameters and deferred-payload budget, with a fixed 44-character
synthetic click placeholder. It does not contact the destination or create a
click, install, outbox entry or job. Custom HTTPS links retain their stored URL;
preview does not invent path/query forwarding. Preview is not a test of an
installed app, public association, real device or store.

Each tenant registers a link host that is unique across the deployment. A
single-tenant deployment may use an explicit fixed-tenant mode. Link creation
accepts only a closed destination grammar and an allowlisted HTTPS or supported
store origin. The request that opens a link cannot replace the stored
destination.

Public Android `assetlinks.json` and Apple
`apple-app-site-association` documents are generated deterministically from
registered applications. They are public routes and never use IP allowlists or
click-path classification.

## Direct delivery

Android App Links and iOS Universal Links pass a closed OpenMasu destination to
the native SDK. The SDK parses and reports the open but does not navigate; the
host application decides whether and how to navigate. Unity receives the same
typed result through the native bridge.

When collection is disabled or consent is withdrawn, the SDK may still return a
navigation destination to the host app but must not enqueue measurement
evidence.

## Android deferred delivery

The redirector places a compact click reference in the Play Install Referrer
payload. The SDK resolves the recorded destination after first launch, validates
its TTL, and consumes it exactly once for the installation lifecycle. Reinstall
and identifier reset do not resurrect a consumed destination.

Campaign details remain in the server-side link record; the referrer does not
carry a user or campaign payload.

## Re-engagement attribution

Re-engagement uses an engagement subject scope and never replaces or re-credits
install attribution. A device-reported open is forgeable evidence and is not
equivalent to a redirector-observed click. Inactivity can be an eligibility
condition but is not itself attribution evidence.

Daily deep-link opens and engagement attribution are reported separately from
install metrics. Organic, non-organic, and unattributed status remains explicit.

This device-reported engagement surface is not Apple's aggregate
AdAttributionKit re-engagement postback. Apple-signed aggregate postbacks have
no installation identity and are reported only in
`aak_attributed_reengagements`; see the
[iOS and Apple measurement design](m4-baseline.md#apple-aggregate-postbacks).

## Deliberate omissions

- iOS deferred deep links;
- Apple Ads campaign-level deferred destinations;
- device-level AdAttributionKit re-engagement attribution without supported
  public evidence. Contract patch v0.4.10 accepts Apple-signed aggregate
  re-engagement postbacks, but never turns them into a device-level open;
- custom-scheme routing as the default secure path;
- any SDK-controlled automatic navigation.

## Evidence gates

Contract/evaluator parity, destination grammar, host uniqueness, association
generation, route precedence, referrer byte budget, TTL and exactly-once state,
SDK parsers, consent behavior, engagement/install separation, Android toolchain,
iOS builds, and Unity compile probes.

## Residual boundary

Real domains, platform association propagation, signing identities, devices,
stores, reinstall behavior, production navigation UX, and long-running
re-engagement observation remain operator checks.
