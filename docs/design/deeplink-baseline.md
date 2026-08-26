# Deep Link and Re-engagement Design

Status: implemented and synthetically verified.

## Capability statement

Direct deep linking is deterministic on Android and iOS. Deferred deep linking
is deterministic on Android through Install Referrer. OpenMasu does not offer
iOS deferred deep linking.

## Link ownership and destinations

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

## Deliberate omissions

- iOS deferred deep links;
- Apple Ads campaign-level deferred destinations;
- AdAttributionKit re-engagement claims without supported public evidence;
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
