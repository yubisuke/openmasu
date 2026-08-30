# Server-to-Server Events

OpenMasu accepts selected first-party events from an app operator's trusted
backend at `POST /v1/events/server`. This path is provider-neutral: it does not
emulate another MMP's wire format, require an advertising identifier, or grant
the caller attribution or platform-verification authority.

## Supported event classes

The initial server path accepts:

- `session_start`
- `custom_event`
- `ad_impression`
- `ad_view`
- `ad_revenue`
- `purchase`
- `refund`

Each `payload` must satisfy the corresponding active Contract v0.4 event
schema. The server assigns tenant, app, authenticated producer,
`contract_version`, `schema_version`, record and delivery IDs,
`occurred_at_source=server`, `received_at`, and the processing purpose. A
caller cannot submit `click`, `install`, consent-control, platform-postback, or
deep-link authority through this endpoint.

An HTTP `202` means that the authenticated body was durably admitted to the
inbox. It does not mean every record passed contract evaluation. The worker
turns a schema-invalid record into the ordinary non-identifying rejection
artifact and completes the batch without crashing or partially projecting it.

## Issue and rotate a key

An administrator can issue a key through the zero-JavaScript dashboard or the
management API:

```http
POST /v1/admin/apps/app-local/server-keys
Authorization: Bearer <admin-key>
Content-Type: application/json

{"producer":"postback:first-party"}
```

The response returns `server_key_id`, `server_key`, and `producer`. Copy the
secret immediately; list operations never return it again. A producer may have
at most two active keys during rotation. Issue a successor, move callers to it,
then retire the predecessor. The last active key for a producer cannot be
retired.

The producer is immutable and must match `postback:<kind>`. Use a stable,
deployment-owned kind such as `postback:first-party`; do not name another
provider unless the key actually authenticates that provider-controlled
receiver.

## Sign a batch

Send these headers:

```text
x-openmasu-app-id
x-openmasu-server-key-id
x-openmasu-timestamp-ms
x-openmasu-nonce
x-openmasu-signature
```

The nonce is 22 to 128 URL-safe Base64 characters. The timestamp is Unix time
in milliseconds. The hexadecimal signature is HMAC-SHA-256 over this exact
UTF-8 canonical string:

```text
openmasu-server-v1
POST
/v1/events/server
<app-id>
<server-key-id>
<timestamp-ms>
<nonce>
<lowercase SHA-256 hex of the exact request body bytes>
```

This synthetic Node.js example uses no external package:

```js
import { createHash, createHmac, randomBytes } from "node:crypto";

const appId = "app-local";
const keyId = process.env.OPENMASU_EXAMPLE_SERVER_KEY_ID;
const secret = process.env.OPENMASU_EXAMPLE_SERVER_KEY;
if (!keyId || !secret) throw new Error("synthetic example key is required");

const body = Buffer.from(JSON.stringify({
  records: [{
    producer_version: "backend-example-1",
    event_id: `event:synthetic:${Date.now()}`,
    event_name: "custom_event",
    occurred_at: new Date().toISOString(),
    processing_sequence: 1,
    payload: {
      event_name: "custom_event",
      installation_id: "installation:synthetic-example",
      event_key: "synthetic_backend_event"
    }
  }]
}));
const timestamp = Date.now();
const nonce = randomBytes(18).toString("base64url");
const digest = createHash("sha256").update(body).digest("hex");
const canonical = ["openmasu-server-v1", "POST", "/v1/events/server",
  appId, keyId, timestamp, nonce, digest].join("\n");
const signature = createHmac("sha256", secret).update(canonical).digest("hex");

const response = await fetch("http://localhost:8080/v1/events/server", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-openmasu-app-id": appId,
    "x-openmasu-server-key-id": keyId,
    "x-openmasu-timestamp-ms": String(timestamp),
    "x-openmasu-nonce": nonce,
    "x-openmasu-signature": signature
  },
  body
});
console.log(response.status, await response.text());
```

## Privacy and authority boundaries

A batch may contain no installation identifier, or every record must name the
same `installation_id`. Mixed-subject batches are rejected. This constraint
lets an installation deletion purge a pending encrypted body without deleting
another subject's data. The endpoint rejects a subject already marked deleted
or withdrawn for any purpose represented in the batch, and the worker repeats
that check before projection to close the acceptance-to-processing race.

The endpoint rejects caller-supplied platform signatures, integrity verdicts,
import/provider context, store-verification claims, and protected authority
extensions. Server authentication proves which deployment key sent the body;
it does not prove that a device, store, ad network, or platform produced the
underlying business fact.

Production operators must terminate TLS before this endpoint, keep key secrets
outside source control, set deployment-specific rate and body limits, and
rotate keys through the append-only lifecycle. The repository tests only
synthetic keys and events; it does not prove production network, capacity, or
operator-secret handling.
