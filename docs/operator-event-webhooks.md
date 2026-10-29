# Operator Event Webhooks

OpenMasu can deliver a closed subset of accepted first-party events to an
operator-owned HTTPS receiver. This is an outbound integration surface. It is
separate from the inbound [server-to-server event API](server-to-server-events.md),
provider callbacks, imports, and conversion-delivery adapters.

The feature is disabled and deny-all by default. Enabling it does not prove
that a production receiver, DNS configuration, TLS certificate, alert path, or
capacity target works. Use only synthetic values in this public repository.

## Supported events and authority boundary

A destination selects one or more of these event names:

- `session_start`
- `custom_event`
- `purchase`
- `refund`
- `ad_revenue`

Only an event accepted into the OpenMasu ledger after the destination was
registered can enter its durable webhook outbox. Registration never backfills
older ledger history. Install, click, deep-link, consent-control,
platform-signature, provider-authority, and imported-attribution events are not
available on this surface. A webhook does not upgrade the authority of its
source evidence.

The JSON envelope is closed:

```json
{
  "schema": "openmasu.operator_event.v1",
  "delivery_id": "018f0000-0000-7000-8000-000000000001",
  "emitted_at": "2026-08-30T00:00:01.000Z",
  "app_id": "app-synthetic",
  "event": {
    "name": "custom_event",
    "event_ref": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "occurred_at": "2026-08-30T00:00:00.000Z",
    "subject_ref": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "details": {
      "event_key": "synthetic_example"
    }
  }
}
```

`event_ref`, optional `subject_ref`, and optional `transaction_ref` are
destination-scoped HMAC-SHA-256 references. They cannot be joined across two
destinations. The body never includes raw installation, event, logical-event,
record, transaction, advertising, or provider-click identifiers; raw payloads,
attributes, credentials, and protected payload references are also excluded.

Event details are limited to the fields needed for that event class:

| Event | Details |
| --- | --- |
| `session_start` | empty object |
| `custom_event` | `event_key` |
| `purchase` / `refund` | exact integer money, currency, optional financial status, optional destination-scoped transaction reference |
| `ad_revenue` | exact integer money, currency, revenue source, and optional bounded network/country dimensions |

## Enable a synthetic or private deployment

Set all of these values in the deployment environment before registration:

```dotenv
OPENMASU_OPERATOR_WEBHOOKS_ENABLED=on
OPENMASU_OPERATOR_WEBHOOK_DESTINATION_ALLOWLIST=https://events.example.invalid
OPENMASU_OPERATOR_WEBHOOK_TIMEOUT_MS=5000
OPENMASU_OPERATOR_WEBHOOK_MAX_ATTEMPTS=8
```

The allowlist contains comma-separated exact origins, not URL prefixes. An
empty allowlist rejects every destination. Production destinations must use
HTTPS, cannot contain URL credentials, query parameters, or fragments, and
must resolve only to public addresses. OpenMasu resolves the hostname for each
attempt and pins the selected address into the connection; redirects are never
followed. Loopback HTTP is available only through an explicit test-only code
path and cannot be enabled from deployment environment variables.

The reference Compose bootstrap forwards the four variables above. A custom
deployment must apply equivalent egress controls and must not treat the
allowlist as a substitute for network policy.

## Register and disable a destination

An administrator can use the zero-JavaScript dashboard on the application page
or the management API:

```http
POST /v1/admin/apps/app-synthetic/operator-webhooks
Authorization: Bearer <tenant-admin-key>
Content-Type: application/json

{
  "endpoint_url": "https://events.example.invalid/openmasu",
  "events": ["custom_event", "purchase"]
}
```

Registration returns `signing_revision: 1` and the signing secret once. New
destinations use separate random keys for stable references and request signing.
The list route returns the current revision and the latest 50 revision metadata
entries (state, creation, overlap deadline and retirement time), never a secret
or its protected reference:

```http
GET /v1/admin/apps/app-synthetic/operator-webhooks
Authorization: Bearer <tenant-admin-key>
```

The endpoint and event set are immutable. To change the receiver or event set,
register a new destination and disable the old one. To rotate only its signing
secret **without changing subject/event/transaction references**, use the same
destination:

```http
POST /v1/admin/apps/app-synthetic/operator-webhooks/<destination-id>/signing-keys
Authorization: Bearer <tenant-admin-key>
Content-Type: application/json

{"expected_revision": 1, "overlap_seconds": 3600}
```

This returns the successor `signing_revision`, `created_at`,
`previous_valid_until` and `signing_secret` once. Configure the receiver with the
returned key immediately and accept the prior revision during overlap. New
deliveries use the successor; already queued deliveries and retries keep their
original revision, body, delivery ID and signature. The endpoint does not verify
that the receiver installed the key. If the one-time response is lost, the key
cannot be retrieved again; inspect metadata and explicitly retire/rotate again
when permitted rather than assuming it was delivered.

`expected_revision` must be the current positive integer revision. A stale
revision returns `409` without another key or history entry. Overlap defaults to
3,600 seconds and must be an integer from 0 through 86,400 (24 hours). The deadline
is exclusive. Only the current and immediately previous signing keys can remain
usable: a further rotation is rejected while the previous key overlaps. Wait for
its deadline or explicitly retire it first:

```http
POST /v1/admin/apps/app-synthetic/operator-webhooks/<destination-id>/signing-keys/retire
Authorization: Bearer <tenant-admin-key>
Content-Type: application/json

{"signing_revision": 1, "expected_revision": 2}
```

Retirement is final; it cannot retire the current key. Repeating retirement of an
already retired revision is harmless and returns its original retirement time.
Retirement suppresses remaining attempts bound to that revision and purges their
protected bodies. At expiry, the worker refuses old-key transmission rather than
silently signing an old request with the new key. Retrying the rotation operation
cannot overwrite an existing revision. Concurrent lifecycle operations and
dispatch use the same destination lock; a send already authorized under that
lock may complete before retirement is acknowledged.

The application dashboard exposes the same rotate/retire forms only to
administrators. The list/history is metadata-only; POST success is the only
one-time secret display. Registration, rotation and retirement are audited without
secret values or receiver response bodies.

Existing destinations migrate their original signing key to revision 1 and
retain the same bytes as their immutable reference-HMAC key. **Retiring this
legacy signing revision revokes signing authority but does not erase that shared
reference key**: it remains protected until the whole destination is disabled.
This preserves previously issued references. New destinations have independent
reference keys; retired independent signing keys are purged. Expired-key use is
blocked even before explicit retirement; retire expired revisions to purge their
independent protected keys.

To stop the destination completely:

```http
POST /v1/admin/apps/app-synthetic/operator-webhooks/<destination-id>/disable
Authorization: Bearer <tenant-admin-key>
Content-Type: application/json

{}
```

Disabling appends lifecycle state, suppresses pending attempts, and purges every
signing revision, the immutable reference key, and pending request bodies. It
cannot be re-enabled. Repeating disable does not append another lifecycle state;
it permits cleanup to be retried after an interrupted post-commit purge.
Disablement is audited without logging the secret or request body.

## Verify a request

Each request is `POST` with these headers:

```text
Content-Type: application/json
User-Agent: OpenMasu-Operator-Webhook/1
X-OpenMasu-Delivery-Id: <delivery UUID>
X-OpenMasu-Attempt: <positive integer>
X-OpenMasu-Key-Revision: <positive signing revision>
X-OpenMasu-Signature: sha256=<lowercase hex HMAC>
```

Compute HMAC-SHA-256 over the exact received body bytes using the UTF-8 bytes
of that delivery's revision-specific one-time signing secret. Select only a
locally configured, currently accepted revision; the header is a key selector,
not proof of authenticity. Compare the expected and received signature in
constant time before parsing or acting on the JSON. Do not reconstruct or
re-serialize JSON before verification.

The same `delivery_id`, body bytes, signing revision and signature are used for
every allowed retry; only `X-OpenMasu-Attempt` changes. Receivers must use `delivery_id` as an
idempotency key. A `2xx` response succeeds. `408`, `425`, `429`, `5xx`, DNS
unavailability, transport failure, and timeout retry with bounded exponential
delay. Redirects and other `4xx` responses fail terminally. The reference
configuration attempts at most eight times and caps each request at 64 KiB.

## Privacy and deletion ordering

Pending bodies are encrypted and referenced from a durable outbox. Immediately
before network transmission, the worker rechecks destination state, payload
lifecycle, withdrawal state, and privacy tombstones.

Deletion recognition and webhook transmission take the same per-record lock.
If deletion obtains it first, the pending request is suppressed and purged. If
the worker obtains it first, the bounded request completes before deletion is
recognized; deletion does not retroactively recall a body already transmitted.
Successful, failed, retry, and suppressed attempts append non-identifying
delivery metadata to the ledger.

## Observe and validate

Authenticated `/metrics` output includes the fixed-label
`operator_webhooks` backlog and the `operator_webhook_delivery` job status.
Receiver response bodies are not retained or logged.

An authenticated read-only operator can inspect complete app-scoped state
counts and at most 50 recently updated rows for both webhook deliveries and
bulk-export batches at:

```text
GET /v1/admin/apps/<app-id>/operator-delivery-health
```

The webhook rows contain only the delivery and destination IDs, event name,
state, attempts, next activity, HTTP status, safe reason, and timestamps. They
exclude logical-event and record IDs, request references and digests, signing
secrets, payloads, and stored artifacts. The same bounded state is shown on the
server-rendered app dashboard. `succeeded` means that the configured receiver
returned a successful HTTP response; it is not proof of downstream processing
or exactly-once effect.

Repository tests use only a synthetic loopback receiver. Before a private
deployment enables this feature, follow the
[operator webhook checklist](validation/operator-event-webhook-checklist.md).
That checklist is optional operator evidence and must remain outside this
public repository when it contains deployment details.
