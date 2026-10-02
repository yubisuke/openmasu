# Verified Commerce Lifecycle Design

Status: implemented and synthetically verified. See
[Project status](../STATUS.md) for the evidence vocabulary and open operator
gates.

## Financial authority

Provider notifications are state-change signals. They never create settled
purchase or refund money directly. The worker performs an authenticated
authoritative read-back and emits money only from the verified response.

## Google Play

Authenticated Pub/Sub push verifies the expected OIDC audience and subscription
scope before durable admission. Product, initial-subscription, renewal, and
refund paths read back authoritative state. Refund corrections use exact money,
target one eligible settled purchase, and cannot exceed the admitted target
amount.

## App Store

App Store Server Notifications V2 verifies both the outer notification and
nested signed transaction or renewal payload. Revision-based history advances
with an encrypted cursor and processes pages in ascending revision order.
The current Apple history path records verified lifecycle evidence. It does not
yet create installation-bound purchase/refund facts or cohort revenue. That
projection is an explicit remaining implementation step, not implied by a
successful history read-back.

### Installation-bound purchase preparation

`POST /v1/apple/purchases/prepare` is an opt-in prerequisite, not transaction
submission or verification. Configure `OPENMASU_APP_STORE_PURCHASE_ENVIRONMENT`
as `Sandbox` or `Production`; `off` is the default. The client cannot choose the
environment. An existing Apple app registration must include its bundle ID.

Use the existing SDK raw-body HMAC headers with an active **iOS installation**
credential. The closed JSON request contains `request_id` (UUID),
`installation_id`, `product_id`, and `revenue_measurement_consent: true`.
The installation must match the authenticated credential. Persist and reuse
the request UUID for retries of the same product and environment; changed
meaning with the same request UUID returns `409`. Replay, including concurrent
requests, returns the same server-generated `app_account_token` UUID. This is
not a person identifier. It must not be replaced by a client-generated fallback.

The `200` response contains `intent_id`, `app_account_token`, `product_id`,
`environment`, and `state: prepared`. It creates **no financial fact**. Invalid
fields/absent affirmative consent return `400`, invalid authentication or an
inactive/deleted installation returns `401`, another installation or Android
credential returns `403`, missing registration/conflicting retry returns `409`,
and a disabled or unavailable preparation path returns `503`. Never log the
request, token, installation anchor or response body. Cookies do not authenticate
this endpoint; report readers cannot read its protected table.

The token digest, product, registration and environment are bound to the
installation digest. The raw UUID and installation ID are stored only in the
encrypted anchor. Issuance and replay share the tenant privacy fence and recheck
current credentials and recognized revenue-consent withdrawal. Client consent
assertion is not independent proof of consent. Installation deletion prevents
future preparation for that subject; app/tenant deletion retains the existing
receipt-boundary policy, rather than permanently disabling new activity.
All three deletion scopes remove intents and enqueue anchor erasure in the
existing durable purge mechanism. Restore reapplication covers both restored
rows and previously recorded purge references (including object-only restores).

Transaction submission, authoritative history-to-financial projection, and the
public Swift preparation/submission API remain incomplete. Until they are
connected, do not describe this prerequisite as verified iOS purchase revenue.
Future submission must verify the signed token echo, product, bundle and
environment without inferring ownership from time, amount or device signals.

Primary references checked 2026-10-02:

- [StoreKit appAccountToken purchase option](https://developer.apple.com/documentation/storekit/product/purchaseoption/appaccounttoken(_:)):
  the purchase option accepts a UUID and the transaction returns that value.
- [App Store Server API appAccountToken](https://developer.apple.com/documentation/appstoreserverapi/appaccounttoken):
  the service-provided UUID accompanies transaction information. Token reassignment
  and cross-installation account linking are not part of this implementation.

## Privacy and observability

Purchase tokens, order or transaction identifiers, signed payloads, credentials,
and read-back cursors remain protected. Public lifecycle facts use bounded state,
digests, and opaque references. Privacy deletion covers inbox, cursor, payload,
and derived installation-linked state. Metrics and logs expose counts and closed
outcomes only.

## Residual boundary

Live stores, credentials, delivery, quotas, root/key rotation, complete missed-
notification recovery, Apple installation-level revenue binding, entitlement,
tax, and payout remain unverified operator or product concerns.
