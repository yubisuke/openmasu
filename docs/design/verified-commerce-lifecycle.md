# Verified Commerce Lifecycle Design

Status: implemented and synthetically verified.

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
Refund history produces corrections only after the signed and read-back state is
accepted.

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
