# Bounded installation access and portability

Use a freshly signed `POST /v1/privacy/access` with the installation credential.
The cursor never substitutes for authentication, and the installation must match
the credential. Use the existing SDK request-signing protocol for every page.

```json
{
  "installation_id": "installation:synthetic-example",
  "request_type": "portability",
  "pagination": "cursor_v1",
  "page_size": 200
}
```

`request_type` may also be `access`. Responses keep the existing allowlisted
`records`, `attributions` and `verified_commerce_lifecycle` arrays. Version
`internal-v2` adds `cutoff_at`, `returned_count`, `page_size`, `byte_limit`,
`complete` and `next_cursor`. Append the arrays from each page. Send the same
installation, request type and pagination mode, adding the returned `cursor`
in the JSON body. Re-sign the request with a fresh timestamp and nonce. Do not
place cursors in URLs, logs or analytics.

Only `complete: true` with `next_cursor: null` means all three series have been
read. An empty array in one series is not completion. Replaying a page does not
advance server state; deduplicate by the existing scoped references if the
consumer saved a page before losing its checkpoint. The request ID, cutoff and
expiry are fixed; page size may change between 1 and 500 (default 200).

## Bounds and fixed membership

Each response is at most 256 KiB including its continuation token and trailing
newline. A byte boundary can produce fewer rows than requested. Each SQL query
fetches at most `page_size + 1` allowlisted rows; it does not materialize all
subject history in application memory. A 10-second statement timeout bounds
database work. Oversized individual rows fail rather than being omitted.

Keyset order is event time plus record ID, then attribution effective time plus
ID, then commerce effective time plus ID; IDs use deterministic C collation.
The first page captures a PostgreSQL transaction snapshot as well as receipt
cutoff. Internal admission XIDs exclude transactions still uncommitted at that
point, including later commits with backdated receipt/effective timestamps.
This metadata is not a contract field, digest input or exported identifier.
Migration 101 adds nullable metadata to existing rows and defaults for future
inserts without rewriting the ledger; historical NULL rows predate pagination.
The two subject indexes support attribution and commerce keyset reads.

Snapshot semantics use PostgreSQL 17's top-level `pg_current_xact_id()` and
`pg_visible_in_snapshot()` ([official reference](https://www.postgresql.org/docs/17/functions-info.html#FUNCTIONS-PG-SNAPSHOT),
checked 2026-11-06). No database transaction or connection remains open between
HTTP requests, and ingestion is not stopped to start an export.

## Authorization, deletion and expiry

Cursors are AES-256-GCM authenticated ciphertext with a dedicated key derived
from the deployment's installation digest key. They bind tenant, app,
installation, SDK key, installation credential, request type and fixed snapshot.
They expire one hour after the first page, without sliding renewal.

Each page rechecks active credentials under the existing tenant privacy fence.
A recognized tenant privacy change invalidates in-progress exports, even if it
concerns another subject; restart rather than mixing pre/post-deletion pages.
A deleted/revoked credential cannot resume. Raw payloads, credentials, commerce
identifiers and other installations remain excluded. Current retention/lifecycle
status may change; an export never restores erased evidence.

Database restart, restore into another database, or installation digest-key
rotation invalidates old cursors. Start a new export after the operation; do
not splice its pages into the earlier request. Pre-restart/restored row metadata
is treated as historical for new exports. This is not an offline backup API.

Known failures: 400 invalid cursor/scope or pagination arguments; 401 inactive
credential; 409 privacy changed or legacy response requires pagination; 410
expired/unavailable snapshot; 413 oversized row/page; 503 bounded snapshot/query
temporarily unavailable. Never infer completion from an error.

## Legacy compatibility

Requests without `pagination` retain `internal-v1` and the old fields when the
entire response fits 200 total rows and the byte budget. Larger requests return
409 `dsar_pagination_required` with no partial export. They must explicitly opt
into `cursor_v1`; silently truncating a legacy response is not permitted.

## Native SDK and Unity callers

Current source provides `requestPrivacyPage` on Android and iOS, and
`RequestPrivacyPage` on Unity. These are explicit, one-page operations using
the existing installation signing transport. They do not enroll an installation,
enqueue an event, retain a cursor, save a file, open sharing UI, or automatically
fetch the entire history. Published SDK archives contain this API only after a
release built from this source revision.

Pass `access` or `portability`, optional previous `nextCursor`, and a page size
(default 200, range 1–500). The typed result is `page_ready` for a partial page,
`complete` for the last page, or a closed failure state: `reset_pending`,
`context_changed`, `not_enrolled`, `unsupported`, `invalid_request`, or
`request_failed`. Native naming follows language conventions. A failure never
contains a page and is never completion. A `request_failed` result includes HTTP,
network and invalid-response failures without exposing server response bodies.

The page exposes request ID, cutoff, next cursor, completion, returned count and
the bounded JSON payload. That JSON is sensitive even though it uses the server's
field allowlist. Only use it for the host user's explicit access, save or share
action. Do not log the page, cursor or credentials or send them to analytics.
Custom transport support is optional; old implementations return `unsupported`.

```kotlin
sdk.requestPrivacyPage(OpenMasuPrivacyRequestType.PORTABILITY, pageSize = 200) { result ->
  // SDK executor: dispatch to the host UI thread before updating UI.
  // result.page?.nextCursor is used only when the host requests the next page.
}
```

```swift
let result = await sdk.requestPrivacyPage(.portability, pageSize: 200)
// result.page?.payloadJSON is transient Data; no automatic save or share.
```

```csharp
client.RequestPrivacyPage(OpenMasuPrivacyRequestType.Portability, result => {
    // Delivered by the existing Unity main-thread dispatcher.
}, pageSize: 200);
```

Use Unity client methods on the host main thread and pump callbacks as for the
existing SDK methods. Native SDKs reject requests during a pending reset and
discard responses when the installation/credential context changes in flight.
Unity also discards old responses already queued for main-thread delivery when
reset starts. Previously delivered pages belong to the host; the SDK cannot erase
copies the host retained. An old cursor cannot authenticate a new installation.
Preserve request ID and cutoff when assembling pages; after a failed continuation,
do not mix a newly started export into an older one. Collection settings do not
silently initiate or block this explicit privacy request for an enrolled subject.
