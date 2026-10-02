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
The Apple history path records verified lifecycle evidence and projects
purchase/refund transaction-price bases only when an active, installation-bound
purchase intent can be verified. A successful unbound history read-back is not
cohort revenue. The public Swift preparation/submission APIs connect the same
authenticated installation to this path without emitting a second client purchase.

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

### Signed submission and authoritative projection

Pass the prepared UUID through StoreKit's `appAccountToken` purchase option.
Submit the returned signed transaction to `POST /v1/apple/purchases/submit`
with the same installation's raw-body HMAC authentication. Its closed JSON body
contains `intent_id`, `installation_id`, `signed_transaction`, and
`revenue_measurement_consent: true`. Configure trusted Apple roots through
`OPENMASU_APPLE_ROOT_SHA256`; missing roots or a disabled environment return
`503`. Signature/bundle/environment failures return `400`; mismatched intent,
installation, token or product returns `403`. No caller-supplied amount is used.

`202 { intent_id, state: "pending" }` means durable admission, not a completed
sale. The response never contains the transaction identifier or signed payload.
Replaying the same signed evidence does not enqueue a duplicate. The existing
Commerce worker reads authoritative transaction history, independently verifies
every signed transaction, and checks the active intent, registration, credential
and recognized revenue-consent withdrawal again. Server API credentials must be
configured separately; API admission does not prove those credentials work.

An echoed prepared token binds its exact product/bundle/environment. A renewal
without a token may use a single previously verified original-transaction
binding. An unknown token never falls back to a different binding. Product
changes, ambiguous originals, account linking and token reassignment are not
inferred. Unsupported/unbound rows remain non-monetary lifecycle outcomes.

Purchase, refund correction, protected binding, encrypted signed evidence,
lifecycle progress and page checkpoint commit in the same database transaction.
Competing notifications serialize by provider transaction; invalid pages and
storage failures leave no partial financial facts. Refund targets use an opaque
identifier for one purchase, not the shared subscription-series identifier.
The raw original identifier remains only in protected evidence; its digest is
used for verified renewal binding. Previously admitted refund amounts are
subtracted from the current signed refund basis so polling or a partial-to-full
update does not duplicate a deduction. A smaller basis does not silently undo
an old deduction: refund reversal remains the explicit follow-up below.

The existing late-input recalculation API can incorporate these newly received
facts into saved cohort revenue, total-net LTV and ROAS. Old metric runs remain
immutable. It is an explicit recalculation request, not an automatic claim that
all history has arrived. API, worker, metric and privacy integration tests use
synthetic ES256 signatures and injected provider responses; they do not prove
live certificate rotation, StoreKit delivery or platform approval.

All three deletion scopes erase submitted evidence, transaction evidence and
purchase anchors and cancel queued work. An installation deletion also covers
SDK submissions before their first financial binding. The shared tenant fence
prevents in-flight read-back from publishing after deletion, and restore
reapplication includes recorded purge references after object-only restores.

Primary references checked 2026-10-02:

- [StoreKit appAccountToken purchase option](https://developer.apple.com/documentation/storekit/product/purchaseoption/appaccounttoken(_:)):
  the purchase option accepts a UUID and the transaction returns that value.
- [App Store Server API appAccountToken](https://developer.apple.com/documentation/appstoreserverapi/appaccounttoken):
  the service-provided UUID accompanies transaction information. Token reassignment
  and cross-installation account linking are not part of this implementation.
- [StoreKit signed transaction representation](https://developer.apple.com/documentation/storekit/verificationresult/jwsrepresentation-21vgo):
  the host submits the JWS, not a reconstructed transaction or a client amount.
- [Finishing a transaction](https://developer.apple.com/documentation/storekit/transaction/finish()):
  content delivery and finishing remain host responsibilities, independent of measurement.

### Swift host integration

After successful initialization, the public Swift SDK exposes
`prepareAppStorePurchase(productId:requestId:revenueMeasurementConsent:)` and
`submitAppStorePurchase(prepared:signedTransaction:revenueMeasurementConsent:)`.
Both require affirmative measurement consent and current collection/installation
state. In-flight responses are not adopted after a consent change, disable/re-enable
cycle or reset. The server's privacy checks still govern requests already sent.

Preparation is a typed server-issued UUID; submission returns only a matching
pending intent, never recognized money. A failed response does not generate a
fallback token, purchase or retry with a new request identity. The host owns
protected retry persistence and the independent StoreKit payment/entitlement
lifecycle. The SDK never stores signed transactions in the ordinary event queue.
Do not combine this path with `trackSettledPurchase` for the same transaction.
See the [iOS SDK guide](../../sdk/ios/README.md#verified-app-store-measurement)
and its compiled StoreKit sample. Custom event transports remain compatible;
the optional purchase transport capability fails explicitly if unavailable.
Unity's vendored Swift is identical; the C# purchase helper surface remains
outside this Swift connection.

Synthetic URL-protocol tests exercise raw-body HMAC, strict response scope,
same-request retries, pending-only admission and consent/reset races without
network access. The macOS CI gate compiles the StoreKit sample and runs the
package tests on macOS and an iOS Simulator. This is not real-store delivery proof.

### Monetary projection boundary

The signed-transaction normalizer calls the configured signature verifier before reading claims and requires
an exact registered bundle/environment match. Raw transaction identifiers and
the echoed token are protected working data; never log or expose them in reports.

Only `inAppOwnershipType=PURCHASED` is eligible for purchaser-linked money.
Family-shared, organization-assigned, missing and unknown ownership remain
non-monetary. Missing price or currency is unavailable, not a zero-price sale.
Price is an integer in milliunits (scale 3), already including the purchased
quantity. Multiplying it by quantity would inflate revenue.

A refund requires a revocation timestamp and an explicit monetary revocation
type. `REFUND_FULL` uses the transaction-price basis. `REFUND_PRORATED` also
requires the provider's percentage in milli-percent: multiplying the integer
price by that integer percentage gives an exact derived basis at scale 8.
The normalizer does not round this intermediate value. It is **not** a claim
about the provider's settled refund, tax treatment or developer payout. Family
or organization access revocation, an unknown type, or a revocation date alone
does not establish refunded money. Contradictory full-refund percentages are
not projected.

`REFUND_REVERSED` needs a separate append-only link to the previously admitted
refund. The current settled-only metric contract cannot cancel that deduction
by appending a reversed row. [Refund reversal follow-up #209](https://github.com/yubisuke/openmasu/issues/209)
covers this narrow gap; do not synthesize another purchase or rewrite old runs.

Additional primary references checked 2026-10-02:

- [Signed transaction payload](https://developer.apple.com/documentation/appstoreserverapi/jwstransactiondecodedpayload).
- [Price](https://developer.apple.com/documentation/appstoreserverapi/price):
  milliunits include quantity; financial/accounting reporting is a separate source.
- [Ownership](https://developer.apple.com/documentation/appstoreserverapi/inappownershiptype):
  purchaser and beneficiary access must remain distinct.
- [Revocation type](https://developer.apple.com/documentation/appstoreserverapi/revocationtype)
  and [percentage](https://developer.apple.com/documentation/appstoreserverapi/revocationpercentage):
  explicit full/prorated refund evidence and its integer percentage basis.
- [Notification type](https://developer.apple.com/documentation/appstoreservernotifications/notificationtype):
  refund, refund reversal and Family Sharing access loss are different events.

## Privacy and observability

Purchase tokens, order or transaction identifiers, signed payloads, credentials,
and read-back cursors remain protected. Public lifecycle facts use bounded state,
digests, and opaque references. Privacy deletion covers inbox, cursor, payload,
and derived installation-linked state. Metrics and logs expose counts and closed
outcomes only.

## Residual boundary

Live stores, credentials, delivery, quotas, root/key rotation, complete missed-
notification recovery, Unity C# purchase helpers, cross-product/account relinking,
refund reversal, entitlement, tax and payout
remain unfinished or unverified operator/product concerns.
