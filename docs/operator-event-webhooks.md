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

Registration returns the signing secret once. The list route never returns the
secret or its protected reference:

```http
GET /v1/admin/apps/app-synthetic/operator-webhooks
Authorization: Bearer <tenant-admin-key>
```

The endpoint and event set are immutable. To rotate a receiver or secret,
register a new destination, update the receiver, and disable the old one:

```http
POST /v1/admin/apps/app-synthetic/operator-webhooks/<destination-id>/disable
Authorization: Bearer <tenant-admin-key>
Content-Type: application/json

{}
```

Disabling appends lifecycle state, suppresses pending attempts, and purges the
destination secret plus pending request bodies. Registration and disablement
are audited without logging the secret or request body.

## Verify a request

Each request is `POST` with these headers:

```text
Content-Type: application/json
User-Agent: OpenMasu-Operator-Webhook/1
X-OpenMasu-Delivery-Id: <delivery UUID>
X-OpenMasu-Attempt: <positive integer>
X-OpenMasu-Signature: sha256=<lowercase hex HMAC>
```

Compute HMAC-SHA-256 over the exact received body bytes using the UTF-8 bytes
of the one-time signing secret. Compare the expected and received signature in
constant time before parsing or acting on the JSON. Do not reconstruct or
re-serialize JSON before verification.

The same `delivery_id`, body bytes, and signature are used for every retry;
only `X-OpenMasu-Attempt` changes. Receivers must use `delivery_id` as an
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

Repository tests use only a synthetic loopback receiver. Before a private
deployment enables this feature, follow the
[operator webhook checklist](validation/operator-event-webhook-checklist.md).
That checklist is optional operator evidence and must remain outside this
public repository when it contains deployment details.
