# iOS and Apple Measurement Design

Status: implemented and synthetically verified.

## First-party SDK

The Swift Package mirrors the Android lifecycle: installation-scoped identity,
bounded persistent queue, signed delivery, collection disablement, withdrawal,
reset, advertising revenue, settled commerce events, and Unity bridge. It does
not collect IDFA, require ATT, or implement fingerprinting. The privacy manifest
describes the shipped SDK behavior.

The installation identity is not stored in the Keychain because transfer and
reinstall persistence would conflict with reset semantics. Backup exclusions
are applied to SDK storage.

## AdServices

The device obtains an attribution token; the server performs the protected
lookup and normalizes only supported outcomes. Raw tokens and responses remain
encrypted. Attributed, not-attributed, expired, and unavailable outcomes remain
distinct.

## Apple aggregate postbacks

SKAdNetwork and AdAttributionKit developer postback copies enter dedicated
receivers. The receiver verifies the supported signed envelope against an
explicit production or allowed-development key environment, rejects replay or
conflict by transaction ID, and persists protected evidence before asynchronous
evaluation.

Aggregate postbacks are grouped and reported by receive-date authority. They
never become installation identity and never merge with deterministic
installation-level attribution.

Contract patch v0.4.10 accepts Apple's current `re-engagement` conversion type
only for click-through winning postbacks. It remains aggregate evidence and is
reported in `aak_attributed_reengagements`, separately from `download` and
`redownload` in `aak_attributed_installs`.

## Conversion policy

Conversion schema and value policy are versioned and bound to emitted lifecycle
evidence. Historical aggregate metrics use the watermark and policy fixed by the
recorded run rather than the latest policy.

The SDK may target install or re-engagement postbacks on iOS 18+ and may use an
opaque conversion tag on iOS 18.4+. A requested type or tag fails closed on an
older OS rather than broadening to every active postback. Conversion tags are
transient platform bookmarks and are not analytics payloads, identifiers, or
log fields. The host application must explicitly opt in to re-engagement
developer-copy delivery. Overlapping conversions are a separate, default-off
opt-in; when enabled, the host application owns protected tag mapping,
persistence, and retrieval while OpenMasu supplies only parsing and targeted
update helpers. The Unity postprocessor writes both Info.plist Booleans from
explicit project settings and keeps them false by default.

## Unity bridge

The Unity package contains source-matched Swift and Objective-C bridge code and
one C# API shared with Android. CI checks the shipping products, sample, native
symbols, wrapper versions, and package artifact without committing build output.

## Evidence gates

Swift tests, synthetic signature and replay vectors, source-only audit, macOS
Simulator builds, generated privacy manifest checks, Unity compile probe, SDK
release identity, SBOM, and server runtime tests.

## Residual boundary

Real devices, Apple developer delivery, AdServices production responses, live
postback keys, store review, privacy disclosure approval, domain association,
caller-owned conversion-tag persistence, and installation-level Apple revenue
binding remain unverified.
