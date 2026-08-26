# Android, Unity, and Redirector Design

Status: implemented and synthetically verified.

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
default; aliases are an explicit deployment choice. A portable Node service and
optional Cloudflare adapter share the same redirector core.

## SDK queue

The Android queue is bounded, durable, and ordered. Exact retry of an identical
event ID is idempotent; reusing an event ID with changed name, purpose, or
payload is a conflict. Collection disablement blocks new records. Withdrawal
purges queued records. Identifier reset does not preserve a link to the prior
installation.

Foreground delivery uses a short in-process path; WorkManager provides the
durable network-connected backstop. Backup exclusion and secure-delete settings
reduce transfer and local recovery risk without claiming perfect device erasure.

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
