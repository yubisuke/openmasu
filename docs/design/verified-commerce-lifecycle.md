# Verified Commerce Lifecycle

Status: Implemented with synthetic evidence (2026-08-25)

OpenMasu treats provider notifications as authenticated state-change signals, not as monetary truth. Protected notification bodies and provider responses are envelope-encrypted. Public ledger artifacts contain only bounded state, timestamps, digests, and exact money that an authoritative provider read-back returned.

## Lifecycle mapping

| Provider signal or read-back | Provider-neutral state | Financial correction |
| --- | --- | --- |
| Google subscription purchased, renewed, recovered, restarted | subscription state evidence | None from the notification; a separately verified processed order may create purchase money |
| Google canceled, paused, on hold, grace period, deferred, expired, revoked, price/item changes | subscription state evidence | None |
| Google voided or partial-refund signal | refund read-back pending | Exact processed full or partial refund from the Orders API creates one `refund` correction |
| Apple subscribed, renewed, changed renewal preference/status, grace/billing-retry/expired signals | lifecycle evidence | None from the notification |
| Apple refund, revoke, refund reversed signals | refund-history read-back pending | A verified transaction-history or refund-history record supplies the financial classification |

The rule is intentionally asymmetric: a provider signal may make state newer, but only an authenticated API response can change settled net revenue. Refunds reuse the existing provider-neutral `refund` event and point at an already verified purchase. Their deterministic event digest and ledger idempotency key prevent double subtraction.

## Google Play path

The public Pub/Sub endpoint verifies Google's OIDC JWT, resolves the registered Android package without request-provided tenant scope, enforces a closed RTDN shape, encrypts the decoded provider body, and records a deployment-global notification digest. All documented subscription notification types are retained as non-financial lifecycle facts. Subscription state is re-read with `purchases.subscriptionsv2.get`. Voided or partially refunded orders are re-read with `orders.get`; only processed refund-history amounts are normalized.

The read-back queue is durable, tenant-scoped, retry-bounded, exponential-backoff controlled, and idempotent. A 429 or 5xx retains work. A permanent non-200 response terminates the item without creating money. Historical rows created before verified order bindings existed may require an operator reconciliation because OpenMasu deliberately does not retain raw order IDs in ledger artifacts.

## App Store path

The App Store Server Notifications V2 endpoint uses the unverified outer payload only to find a pre-registered bundle/app pair. It then verifies the outer JWS and every nested transaction or renewal JWS against a configured Apple root fingerprint, certificate validity, ES256, environment, bundle, and App Apple ID scope. The notification UUID is the replay boundary. The full signed payload stays encrypted.

The worker calls transaction history or refund history with a short-lived ES256 App Store Server API token. Revision cursors are encrypted and processed in ascending order. Every returned signed transaction is verified again before a safe lifecycle fact is appended. Store transaction identifiers are stored only as SHA-256 digests. This repository does not contain Apple credentials, production roots, transaction identifiers, or live App Store evidence.

## Privacy, retention, and observability

Installation-, app-, and tenant-scope deletion purges matching notification and cursor ciphertext. Append-only safe facts retain digests only where the deletion policy permits. The worker emits a bounded `commerce_readback_cycle` structured record containing only tenant scope and counts. No token, order ID, transaction ID, signed payload, provider body, credential, IP address, or User-Agent is logged or emitted in public artifacts.

## Residual boundary

- Live provider credentials, quota behavior, notification delivery, certificate rotation, and store-console configuration are operator evidence.
- Apple history requires a verified original transaction from a notification or an operator-authorized protected seed; OpenMasu cannot enumerate an account without one.
- App Store transactions are retained as verified lifecycle evidence, but installation-level revenue requires a separate host-owned binding that is not inferred from Apple identifiers.
- Current Google subscription state is authoritative at read time; a latest-state response alone cannot reconstruct every missed intermediate renewal.
- Entitlement, acknowledgement, tax, payout, and customer-support workflows are outside this measurement component.

