# Threat Model

## Scope and assumptions

This model covers the public reference deployment and SDKs. Internet clients,
mobile devices, import files, callback senders, administrators, and restore
media are untrusted until the relevant boundary authenticates and validates
them. A self-hosting operator controls deployment secrets and infrastructure.

The public repository contains only synthetic data. Live provider accounts,
fraud policy, alert routing, and incident response are deployment concerns.

## Assets

- tenant and application separation;
- protected payloads, credentials, provider tokens, and transaction references;
- immutable evidence and privacy lifecycle state;
- attribution, fraud, reconciliation, and metric reproducibility;
- tracking-link destinations and host ownership;
- release artifacts, SBOMs, and contract identity.

## Component threats and controls

<!-- threat-component:admin-api -->
**Management API:** key theft, cross-app reference, privilege confusion, CSRF,
and unsafe mutation. Controls include tenant-scoped keys, RBAC, route-declared
auth, explicit app validation, opaque sessions, Origin/CSRF checks, rate limits,
and immutable audit records.

<!-- threat-component:redirector -->
**Redirector:** open redirect, destination override, slug enumeration, click
flooding, and raw IP retention. Controls include stored destinations, HTTPS
origin allowlists, random slugs, indistinguishable misses, bounded click-only
classification, and no raw IP in durable artifacts.

<!-- threat-component:sdk-ingestion -->
**SDK ingest:** forged batches, replay, cross-install deletion, oversized input,
in-flight projection after deletion, and synchronous partial writes. Controls
include SDK and installation credentials, canonical HMAC, timestamp/nonce replay
windows, limits, durable inbox admission, schema validation, a
tenant/app/installation privacy fence held through projection and auxiliary
queueing, deletion-state rechecks after payload decoding, and transactional
per-record persistence.

<!-- threat-component:server-event-ingestion -->
**Server event ingest:** backend-key theft, forged or replayed bodies,
cross-app scope, authority escalation, mixed-subject deletion, oversized input,
and acceptance-to-processing withdrawal races. Controls include dedicated
rotatable keys, exact raw-body HMAC, timestamp/nonce windows, server-assigned
scope and purpose, a closed event allowlist, contract validation in the worker,
per-key and per-app limits, single-subject batch enforcement, protected-claim
rejection, durable inbox admission, and a second withdrawal check before
projection.

<!-- threat-component:import-worker -->
**Import worker:** malicious mapping or CSV/JSON shape, invalid payload, partial
ledger state, duplicate event ID, and accidental source disclosure. Controls
include closed mapping schemas, linting, compiled contract validators, row-level
rejections, atomic writes, idempotency keys, and aggregate-only compatibility
output.

<!-- threat-component:max-receiver -->
**Mediation receiver:** forged revenue callback, replay, identifier leakage, and
misclassification as attribution. Controls include callback authentication,
bounded fields, durable inbox state, protected raw references, and a separate
revenue evidence class.

<!-- threat-component:payload-store -->
**Payload store:** plaintext disclosure, path traversal, stale encryption keys,
and resurrection after deletion. Controls include opaque references, envelope
encryption, allowlisted storage roots, purge/crypto-erasure, and privacy
reapplication after restore.

<!-- threat-component:postgres-ledger -->
**PostgreSQL:** cross-tenant reads, overprivileged roles, mutation of received
evidence, missing grants, and inconsistent transactions. Controls include
forced RLS, role separation, append-only triggers, a complete CI grant matrix,
foreign keys, canonical artifacts, and explicit transactions.

<!-- threat-component:sdk-android -->
**Android SDK:** queue loss, secret extraction, backup transfer, changed-payload
event-ID reuse, and fabricated device evidence. Controls include bounded durable
storage, exact duplicate/conflict semantics, HMAC credentials, backup exclusion,
reset lifecycle, and server-authority classification. A compromised device can
still fabricate device-reported events.

<!-- threat-component:sdk-ios -->
**iOS SDK:** the same queue, credential, backup, reset, and fabricated-evidence
risks plus privacy-manifest drift. Controls include native parity tests,
Keychain-free installation identity, backup exclusion, privacy manifest, and
source/built-product audits.

<!-- threat-component:unity-bridge -->
**Unity bridge:** native signature drift, duplicate SDK copies, wrong wrapper
version, and lost lifecycle calls. Controls include a versioned UPM package,
compile probes, native dependency pinning, source parity, samples, and release
identity checks.

<!-- threat-component:app-association -->
**Association files:** tenant host collision, hostile destination grammar,
cache/propagation failure, and accidental IP restriction. Controls include
deployment-wide host uniqueness, validated destinations, deterministic public
documents, and public unauthenticated routes with no click-path filtering.

<!-- threat-component:dashboard -->
**Dashboard:** session theft, XSS, CSRF, confused authentication, sensitive
cache, and report divergence. Controls include hashed absolute-expiry cookies,
strict cookie attributes, CSP, no JavaScript, output escaping, CSRF/Origin,
`no-store`, reader RLS, and shared API/dashboard encoders.

<!-- threat-component:apple-postback-receiver -->
**Apple postbacks:** forged signatures, wrong environment, replay/conflict,
tenant enumeration, and mixing aggregate with installation data. Controls
include signed-envelope verification, explicit key environment, transaction-ID
state, non-enumerating tenant resolution, and separate aggregate series.

<!-- threat-component:fraud-engine -->
**Fraud engine:** unbound thresholds, non-reproducible decisions, metric changes
from a default flag, clock anomalies, and privacy-invasive signals. Controls
include registered definitions and digests, composite bundle hashes, pure rules,
explicit provisional time handling, gross/net separation, and a closed bounded
signal set.

<!-- threat-component:integrity-verifier -->
**Integrity verifier:** forged provider response, raw token disclosure,
incorrect project configuration, and treating unavailable evidence as success.
Controls include server-side provider verification, protected references,
closed neutral verdicts, policy provenance, and fail-closed configuration.

<!-- threat-component:google-play-product-verifier -->
**Google Play verifier:** forged notification, stale purchase state, duplicated
money, credential leakage, and refund mismatch. Controls include authenticated
notifications, authoritative API read-back, revision/idempotency state,
protected tokens, exact money, and correction constraints.

<!-- threat-component:verified-commerce-lifecycle -->
**Commerce lifecycle:** out-of-order revisions, missed notifications, unsafe
cursor storage, double refunds, and public provider identifiers. Controls
include ascending revision cursors, encrypted payload/cursor state, bounded
retry, authoritative read-back, per-target refund caps, and opaque public refs.

<!-- threat-component:google-data-manager-delivery -->
**Conversion delivery:** unauthorized export, replay, provider payload leakage,
ambiguous delivery status, concurrent provider sends, and a late worker
overwriting a reclaimed delivery. Controls include explicit enablement,
eligible event selection, service authentication, one database-clock claim per
row, token-fenced transactional completion, expired-claim recovery, a stable
digest-checked transaction ID, bounded status vocabulary, and sanitized logs.
If a process loses the provider response or stops after provider acceptance but
before local completion, an expired claim may resend the same transaction ID.
Provider-side duplicate handling and exactly-once delivery remain unverified.

<!-- threat-component:operator-event-webhooks -->
**Operator event webhooks:** unauthorized disclosure, SSRF and DNS rebinding,
secret theft, replayed receiver effects, redirect escape, deletion races, and
identifier leakage. Controls include default-off enablement, exact HTTPS-origin
allowlists, public-address DNS validation and connection pinning, no redirects,
one-time encrypted destination secrets, exact-body HMAC, stable delivery IDs,
a closed minimal envelope, encrypted durable retries, and one shared record
lock for dispatch and deletion recognition.

<!-- threat-component:operator-bulk-exports -->
**Operator bulk event exports:** credential theft, SSRF and DNS rebinding,
overwrite or retry divergence, cursor skips, cross-destination correlation,
deletion races, and identifier leakage. Controls include default-off
enablement, exact HTTPS-origin allowlists, public-address DNS validation and
connection pinning, no redirects, encrypted least-privilege credentials,
SigV4, conditional object creation, digest-verified identical replay, durable
keyset cursors, a closed destination-scoped row type, deletion-first selection,
and destination locks shared with deletion recognition and disablement.

<!-- threat-component:production-control-plane -->
**Control plane:** key misuse, stale rule activation, scheduler overlap, and
unaudited configuration. Controls include minimum RBAC, encrypted secrets,
append-only revision history, tenant/job leases, retry state, and audit events.

<!-- threat-component:scheduled-metrics -->
**Scheduled metrics:** definition substitution, overlapping series, clock or
watermark drift, cross-tenant execution, and a crash leaving committed output
without an advanced checkpoint. Controls include immutable JCS-digested
definitions, disjoint active metric-name sets per app, UTC target dates and
fixed watermarks, tenant-scoped RLS and advisory locks, persisted pending work,
deterministic run identifiers, and byte-identical replay verification.

<!-- threat-component:privacy-restore -->
**Restore path:** deleted payload resurrection and exposure before privacy state
is reapplied. Controls require restoration into a new target, writer isolation,
completed-request reapplication, verification, and release only after the
privacy gate passes.

<!-- threat-component:operational-observability -->
**Logs and metrics:** raw payload or high-cardinality identifier disclosure.
Controls include closed event schemas, aggregate counters, authenticated metrics,
payload scans, and no user/provider identifiers in labels.

<!-- threat-component:integrity-evidence -->
**Public integrity artifacts:** exposing provider tokens or presenting a device
claim as verified. Controls limit artifacts to platform, verdict, evaluation
time, policy version, and a protected opaque reference assigned by the server.

<!-- threat-component:runtime-ci -->
**CI and supply chain:** unpinned actions, dependency substitution, credential
leakage, stale SBOMs, and tests that rewrite evidence. Controls include full SHA
pins, exact toolchains, lockfiles, SBOM checks, real-data guardrails, read-only
validation, and immutable reviewed goldens.

## Residual risks

- A compromised client can fabricate device-reported events, including
  `deep_link_open`; current fraud rules can inspect the evidence but cannot make
  it server-observed.
- The reference fraud boundary cannot reliably detect real-device farms and
  deliberately does not link identifier resets.
- Bounded source/client classes can create aggregate facts about co-located
  traffic and may create false positives.
- Tenant cycles use a bounded FIFO coordinator, deduplicate active and queued
  tenants, and retain serial job order within each tenant in one worker process.
  A slow provider no longer blocks every independent tenant while a coordinator
  slot is free.
- Scheduler leases and job transactions have separate pools sized from the
  same concurrency setting. Completion and failure reuse the held lease
  connection, while the job pool reserves two connections per slot for nested
  privacy work.
- A slow tenant still consumes one slot. SDK and MAX inboxes use bounded FIFO
  slices, but a slow row, backlog that spans many cycles, or enough slow tenants
  to fill all slots can delay later work and remains an operational capacity
  risk.
- Tenant/job leases do not provide tenant-wide ordering across multiple worker
  replicas. The reference deployment uses one replica; independently scaling
  workers requires an explicit interleaving review. Shutdown drain is bounded,
  and deadline expiry deliberately fails the process so the supervisor can
  report and replace it.
- Synthetic platform vectors do not prove production keys, projects, delivery,
  or provider behavior.
- Synthetic server-event vectors do not prove backend integration, sustained
  capacity, production TLS, or operator key custody. A stolen active server key
  can submit plausible first-party events within its event allowlist until it
  is retired.
- Synthetic operator-webhook vectors do not prove receiver availability,
  production DNS/TLS, capacity, secret custody, or downstream deletion. A
  receiver learns every field in the selected closed event class, and a request
  already transmitted before deletion recognition cannot be recalled.
- A slow operator-webhook receiver holds the bounded per-record dispatch lock
  until that attempt finishes. The timeout limits the interval but does not
  eliminate database contention or delay within that tenant.
- Synthetic object-store vectors do not prove live S3/R2 IAM policy, DNS/TLS,
  retention, replication, throughput, cost, alerting, or downstream deletion.
  A storage operator can retain or copy an object after receipt, and a deletion
  row is an auditable instruction rather than remote erasure proof.
- Self-hosting operators remain responsible for TLS, secret custody, host
  security, backup media, alert routing, and incident response.

## Release boundary

No release is production-approved by this threat model. A release may state
which synthetic controls passed and which private operator gates remain open.
See [Project status](STATUS.md), [Privacy and security](privacy-security.md),
the roadmap's [optional operator evidence](roadmap.md#optional-operator-evidence),
and [Validation checklists](validation/README.md).
