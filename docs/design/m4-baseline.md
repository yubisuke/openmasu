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

## Conversion policy

Conversion schema and value policy are versioned and bound to emitted lifecycle
evidence. Historical aggregate metrics use the watermark and policy fixed by the
recorded run rather than the latest policy.

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
and installation-level Apple revenue binding remain unverified.
