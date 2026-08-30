# Operator bulk event exports

OpenMasu can write selected accepted events to operator-owned S3-compatible
object storage. This path complements low-latency
[operator event webhooks](operator-event-webhooks.md): webhooks notify a
receiver event by event, while bulk exports produce deterministic gzip NDJSON
objects with durable keyset checkpoints.

The feature is disabled and deny-all by default. It is provider-neutral and
does not implement another MMP's file layout.

## Export boundary

An app destination selects one or more of:

- `session_start`
- `custom_event`
- `purchase`
- `refund`
- `ad_revenue`

Every event uses the same closed `openmasu.operator_event.v1` object as the
webhook path. The export does not contain raw payloads, record IDs, logical
event IDs, installation IDs, transaction IDs, advertising IDs, provider click
IDs, or platform-authority payloads. Event, subject, and transaction references
are HMAC-scoped to the destination and cannot be joined across destinations.

Each object is gzip-compressed UTF-8 NDJSON:

1. one `openmasu.operator_event_export_manifest.v1` row;
2. zero or more `privacy_deletion` rows;
3. zero or more event rows.

The manifest records the destination, app, generation time, row count, SHA-256
of the uncompressed data rows, and safe before/after cursor evidence. The
cursor's record component is a destination-scoped HMAC reference, never the
internal record ID used by PostgreSQL ordering. Object bytes and the object key
remain identical across a retry. The default object key is:

```text
<prefix>/date=YYYY-MM-DD/<destination>-<export>.ndjson.gz
```

## Storage and credentials

OpenMasu implements the narrow S3 `PutObject` and `HeadObject` surface with AWS
Signature Version 4. It works with path-style, SigV4-compatible endpoints such
as Amazon S3 and Cloudflare R2. Registration requires:

- an exact HTTPS endpoint origin;
- bucket, optional prefix, and signing region (`auto` for R2);
- selected event names and an explicit canonical-UTC `start_at`;
- access key ID, secret access key, and optional session token.

Credentials are encrypted through the payload store and are never returned or
listed. Use a dedicated least-privilege credential restricted to the target
bucket and prefix. The worker needs object write permission and object read
permission for the metadata-only `HeadObject` replay check; it does not need
bucket listing or deletion authority.

Production egress requires both:

```dotenv
OPENMASU_OPERATOR_BULK_EXPORTS_ENABLED=on
OPENMASU_OPERATOR_BULK_EXPORT_DESTINATION_ALLOWLIST=https://account.r2.cloudflarestorage.com
```

The allowlist contains exact origins separated by commas. HTTPS, public DNS,
address validation, and connection pinning are mandatory outside explicit
synthetic tests. Redirects are rejected.

## Registration

An administrator can use the app dashboard or the management API:

```http
POST /v1/admin/apps/<app-id>/operator-bulk-exports
Authorization: Bearer <admin-key>
Content-Type: application/json

{
  "endpoint_url": "https://account.r2.cloudflarestorage.com",
  "bucket_name": "synthetic-example-bucket",
  "object_prefix": "openmasu/events",
  "region": "auto",
  "events": ["custom_event", "purchase", "refund"],
  "start_at": "2026-08-30T00:00:00.000Z",
  "access_key_id": "<protected-access-key-id>",
  "secret_access_key": "<protected-secret-access-key>",
  "session_token": "<optional-protected-session-token>"
}
```

`start_at` is the explicit backfill boundary. Registration never probes by
writing an object; the worker begins after the durable destination is active.
List and disable routes are:

```text
GET  /v1/admin/apps/<app-id>/operator-bulk-exports
POST /v1/admin/apps/<app-id>/operator-bulk-exports/<destination-id>/disable
```

Disablement is irreversible. It suppresses and purges pending encrypted object
bodies and purges the destination credentials.

## Delivery and recovery

The worker advances `(received_at, record_id)` and deletion-sequence cursors
only after storage confirms the object. It sends `If-None-Match: *` and stores
the gzip SHA-256 in `x-amz-meta-openmasu-sha256`. If a retry finds an existing
key, a signed `HeadObject` must return the same digest before OpenMasu treats it
as success. A different object at that key is a terminal conflict.

Timeouts, throttling, selected conflict responses, and server errors use the
durable bounded retry schedule. Redirects, invalid endpoints, authorization
failures, digest conflicts, and malformed protected state fail closed. Pending
objects stay encrypted and are purged after success, terminal failure,
disablement, or privacy suppression.

## Privacy deletion rows

At deletion recognition, OpenMasu suppresses every pending object for the
affected destination before creating a destination-scoped `privacy_deletion`
row. Subsequent discovery omits tombstoned events and exports that deletion row
with the same `subject_ref` used by earlier destination events.

This notice lets the operator find and delete downstream subject data. It
cannot recall an object that the external storage system already accepted.
The storage account owner remains responsible for lawful basis, access,
retention, deletion, replication, backup, and incident response.

## Verification boundary

Repository tests use only synthetic credentials, a loopback object receiver,
and official AWS SigV4 examples. They prove request signing, deterministic
bytes, durable retry, cursor ordering, privacy suppression, and credential
non-disclosure. They do not prove a live Amazon S3 or Cloudflare R2 account,
production DNS/TLS, IAM policy, regional behavior, lifecycle rules, capacity,
cost, alerting, or operator acceptance. Use the
[operator checklist](validation/operator-bulk-export-checklist.md) for those
optional private checks.
