# Android, Unity, and Redirector Design

Status: implemented and synthetically verified. See
[Project status](../STATUS.md) for the evidence vocabulary and open operator
gates.

## Measurement flow

1. The redirector resolves a stored link, records a random `click_id`, and
   redirects to an allowlisted destination.
2. For Android store links, the click ID is placed in the Install Referrer
   payload without campaign or user attributes.
3. The Android SDK reads authoritative referrer timestamps and submits typed
   install evidence through a durable signed batch.
4. The worker processes the inbox asynchronously through the same evaluator used
   by imports and fixtures.
5. The Unity package exposes the native Android behavior through a versioned C#
   API.

## Authentication and replay

SDK enrollment provisions a public key ID and secret. Each installation receives
an installation-scoped credential. Requests sign method, path, key ID, body
digest, timestamp, and nonce with HMAC-SHA256. The API verifies size, timestamp,
nonce, key status, installation scope, and signature before durable admission.

On-device deletion requires the installation credential and may address only
that installation. Success revokes the credential and applies the privacy
lifecycle.

## Redirect safety

Tracking links store their destination at creation time. Only HTTPS origins in
the deployment allowlist and explicit supported store destinations are allowed.
Request input cannot override a stored destination. Random slugs are the
default; aliases are an explicit deployment choice. The portable Node service
is implemented. A Cloudflare adapter is a future optional port and is not
shipped; any such port must preserve redirector-core contract parity.

## SDK queue

The Android queue is bounded, durable, and ordered. Exact retry of an identical
event ID is idempotent; reusing an event ID with changed name, purpose, or
payload is a conflict. Collection disablement blocks new records. Withdrawal
purges queued records. Identifier reset does not preserve a link to the prior
installation.

Foreground delivery uses a short in-process path; WorkManager provides the
durable network-connected backstop. Backup exclusion and secure-delete settings
reduce transfer and local recovery risk without claiming perfect device erasure.

Unity Android App Links are build-time configuration, not a runtime-only SDK
option. `ProjectSettings/OpenMasuAndroidSettings.json` generates one verified
`http`/`https` intent filter per normalized host in the selected Unity activity.
The generated manifest stores that host set as metadata, and SDK initialization
requires it to match `OpenMasuOptions.DeepLinkHosts` exactly. An absent settings
file generates no OpenMasu filter, and the checked-in library manifest contains
no synthetic default host. Custom schemes remain operator-owned separate
filters. This follows Android's guidance to declare App Link hosts in the
manifest and publish matching domain association statements:

- <https://developer.android.com/training/app-links/add-applinks> (accessed 2026-08-30)
- <https://developer.android.com/training/app-links/configure-assetlinks> (accessed 2026-08-30)

## Supported adapters

- Google Play Install Referrer;
- typed Meta Install Referrer evidence with server-managed decryption keys;
- AppLovin MAX impression-level revenue;
- custom events and first-party purchase or refund events;
- Unity Android bridge and sample.

These adapters do not create general partner-network user-level attribution.

## Evidence gates

Pure JVM tests, SQLite process-death tests, Gradle build, Android emulator,
Install Referrer compile probe, synthetic Meta vectors, MAX serialization,
Unity C# compile probe, SBOM, runtime ingest, replay, reset, and deletion tests.

## Residual boundary

Real devices, Play tracks, live Meta/MAX projects, actual Unity exports,
background delivery under production power policies, and live threshold quality
remain operator checks.
