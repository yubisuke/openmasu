# OpenMasu Android SDK

## Access and portability

Current source provides the optional `OpenMasuPrivacyTransport` capability and
`sdk.requestPrivacyPage` for one signed, bounded page at a time. Existing custom
transports remain compatible. See [portable export](../../docs/operations/portable-export.md#native-sdk-and-unity-callers)
for request types, completion, reset guards and host-owned save/share behavior.
This source API is not a claim that older published SDK assets include it.

The Android SDK is a source-distributed Kotlin/Gradle project for first-party
events, Google Play Install Referrer, optional Meta Install Referrer, AppLovin
MAX impression-level revenue, signed delivery, and consent/reset lifecycle. The
minimum Android API level is 24.

For compiled, version-bound AAR/POM downloads rather than building the entire
repository, follow [SDK distribution](../../docs/sdk-distribution.md). The
configured candidate must have its matching verified tag and public assets;
source setup alone is not publication.

## Modules

- `core`: installation identity, bounded SQLite queue, HMAC transport, consent,
  reset, direct deep links, and first-party events;
- `installreferrer`: Google Play Install Referrer reader and typed authority;
- `metareferrer`: optional typed Meta Install Referrer adapter;
- `max`: provider-neutral MAX revenue mapping;
- `unitybridge`: Java surface used by the Unity UPM package;
- `sample`: synthetic native integration sample.

No module contains a deployment credential, campaign value, advertising ID, or
real provider response.

## Local gates

Use the pinned JDK and Android SDK versions from
`.github/workflows/sdk-android.yml`:

```bash
./sdk/android/gradlew -p sdk/android androidAcceptance verifySdkSbom --no-daemon
dotnet run --project sdk/unity/tests/UnityCompileProbe.csproj --configuration Release
```

The authoritative emulator gate runs the sample on API 36 in GitHub Actions.
Building locally without that emulator result is not device-delivery evidence.

## Queue and lifecycle

The queue is bounded by record count and logical UTF-8 bytes. A normal retry is
idempotent only when every persisted field is identical. A deterministic
commerce retry may use a new occurrence time and queue sequence, but its event
ID, event name, purpose, consent revision, and payload must match. Any other event-ID reuse, or a
processing sequence already owned by another event, raises
`queue_event_conflict` before eviction. Android and iOS run the same synthetic
cases from `sdk/queue-semantics-vectors.json`. Collection disablement blocks new
measurement. Withdrawal purges consent-required queued records. Installation
reset sends the credential-bound deletion request before generating an
unrelated replacement identity. The SDK uses the canonical
`POST /v1/privacy/installation` route; the server also retains the older
`POST /v1/privacy/on-device` route as an authenticated compatibility alias.

Reset persists a deletion receipt before sending. HTTP 202 means pending, not
completion: collection and ordinary delivery stay stopped, and initialize,
flush/background delivery, or another reset resumes status checking after restart.
Only confirmed completion switches to one replacement installation. Consent and
explicit collection disablement survive the switch. A pending reset callback is
`false`; retry it to observe completion. The built-in transport supports receipts;
custom transports can opt into `OpenMasuDeletionTransport` (legacy transports must
only report success after synchronous deletion completes). See the
[receipt protocol](../../docs/privacy-security.md#sdk-deletion-receipts).

SDK storage is excluded from backup and transfer where Android supports both
the modern data-extraction rules and legacy backup attributes. SQLite
`secure_delete` is a limited local measure, not a guarantee that every device
storage copy is erased.

## Purpose-scoped consent (current source)

Declare the host application's policy before initializing or recording measurement.
The SDK does not choose a legal basis. `updateConsent(state, policyVersion)` remains
the all-purpose API; `updateConsentForPurpose` changes only one of `attribution`,
`analytics`, or `revenue_measurement`:

```kotlin
sdk.updateConsent("granted", "synthetic-policy-v1")
sdk.updateConsentForPurpose("analytics", "withdrawn", "synthetic-policy-v1")
// Attribution and revenue keep their own state; analytics cannot enqueue.
```

States are `granted`, `not_required`, `denied`, `withdrawn`, and `unknown`.
Only explicit `granted` or `not_required` releases a purpose's local barrier;
`unknown` does not clear it. Each definitive declaration advances a durable revision.
Measurements retain their enqueue-time revision. Changing a purpose discards that
purpose's older queued measurements, including work waiting on the executor; a
later grant cannot revive them. Other purposes keep their revisions and queues.
Legacy unversioned records remain unversioned until a declaration changes their
purpose. The existing Room queue migrates in place without deleting other records.

Consent and revision counters survive restart and installation reset. Delivery
prefixes at most three current declarations, with stable per-credential event IDs,
so queue eviction or reset does not lose the policy context. This is bounded
metadata in existing private storage, not a second delivery queue. Consent controls
use the non-disableable `fraud_prevention` purpose. A callback reports local queue
admission, not server recognition. An oversized notification can return `false`
while still installing the local barrier and purging the affected queue; it is
not smuggled into a later batch. Retry with a bounded policy value. Requests already
in flight cannot be recalled; server receipt ordering and privacy fences remain
authoritative. See the [contract](../../spec/event-metric-contract-v0.4.md).

This source API is not included by implication in older published SDK assets.

## Local diagnostics

`sdk.diagnosticsSnapshot { snapshot -> ... }` asynchronously reads local state
on Room's read executor, independently of network delivery. It does not initialize
the SDK, generate an installation ID, enroll, flush, or upload diagnostics.
The typed snapshot contains collection enablement, the consent barrier,
reset-pending and enrolled flags, queue-health aggregates, and the last observed
enrollment/delivery/deletion attempt's timestamp, closed result and HTTP class.
The closed attempt metadata survives reopening, including background delivery
from another SDK instance. No identifier, secret, URL, payload or response body
is returned. Do not update Android UI directly from the completion callback.

Current Android source also returns `purposeConsent`: exactly the three measurement
purposes, each with state, optional revision, and blocked flag. The existing aggregate
`consentBarrierActive` and `CONSENT_BLOCKED` retry state mean at least one purpose is
blocked, not that every purpose is stopped. Consult the per-purpose entries before
interpreting other-purpose delivery as a contradiction.

`ACCEPTED` means HTTP 202 admission, **not ledger completion**. Authentication
rejection, rate limiting and network unavailability remain distinct. Existing
custom transports remain compatible and report `CUSTOM_SUCCESS` or
`CUSTOM_FAILURE`; an unknown custom failure is not assumed to mean offline.
Custom HTTP transports may opt into `OpenMasuDiagnosticTransport` and the closed
`OpenMasuTransportFailure` errors. `PENDING` means local work remains, not a
promised retry time. See [measurement health](../../docs/measurement-health.md#local-sdk-diagnostics-are-separate).

## Short-lived synthetic validation sessions

On a disposable synthetic deployment, an administrator can create a short-lived
validation session and supply its one-time token and expiry to a synthetic test
app. Call `sdk.setSyntheticValidationSession(token, expiresAtMs)` to opt in and
`sdk.clearSyntheticValidationSession()` to opt out. These calls only update local
settings: they do not create an identifier, enroll, send, enable collection or
relax consent. The built-in transport supports this capability; a custom transport
must implement `OpenMasuSyntheticValidationTransport`, otherwise setting fails
explicitly with `UnsupportedOperationException`.

The token must be canonical base64url for 32 bytes, without padding (43 characters).
Expiry must be in the future and at most 30 minutes away. Server expiry and the
`synthetic_disposable` deployment restriction remain authoritative. Active opt-in
survives reopening/background work in the existing private SDK storage. Only the
signed batch envelope gets `validation_session_token`; queue events, diagnostics,
logs and enrollment requests do not. Expired settings send ordinary unlabelled
batches under the unchanged collection/consent rules. Withdrawal, denial and
installation reset clear the setting. HTTP 202 still means admission, not a
successful validation or metric result; follow receipts in the administrator UI.
Never use this facility with real data or persist its token in application logs.

## Install Referrer and deep links

Install Referrer preserves Google Play response state and both client and
server timestamps available from the pinned library. Server timestamps are the
authoritative attribution-window evidence; device occurrence time is retained
but does not replace them.

Direct App Links are parsed and returned to the host application. The SDK never
navigates automatically. Android deferred destinations use an OpenMasu click
reference carried through Install Referrer, expire under server policy, and are
consumed once per installation lifecycle.

## Local release artifacts

The release build produces five AARs and a CycloneDX SBOM. The repository
packager assembles them with the Unity and Swift source artifacts into the local
release bundle described by [the release runbook](../../docs/operations/release.md).
OpenMasu does not publish a Maven registry artifact or signing identity.

## Validation boundary

The repository gates are synthetic. Physical devices, Play tracks, background
delivery under real power policies, live Meta/MAX signals, and actual host-app
integration remain private operator evidence in
[the Android checklist](../../docs/validation/m2-device-checklist.md).
