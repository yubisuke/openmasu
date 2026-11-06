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
into `cursor_v1`; silently truncating a legacy response is not permitted. Native
SDK convenience APIs for assembling pages are a separate feature; this signed
HTTP operation is available now.
