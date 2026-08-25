# Initial Threat Model

This is the public M0.4 Contract v0.4 threat model for the contract and its reference evaluators. It describes security properties and release gates, not live defenses, incident response timing, credentials, or personal data.

## Assets and trust boundaries

- Protected evidence and its digests are tenant- and app-scoped.
- Server-generated `record_id` is a global ledger identity; client event IDs are not ledger identities.
- `installation_id` is an app-local, resettable installation anchor. A reinstall or redownload creates a new anchor.
- `click_id` is redirector evidence scoped to one tenant and app.
- Derived attribution, metric, privacy, and reconciliation artifacts must retain enough protected references to be audited without exposing raw evidence.

Untrusted inputs cross the SDK, redirector, import, and fixture boundaries. The PostgreSQL ledger is the authoritative received-evidence store in the future runtime architecture. Edge delivery may be deployed close to users, but must preserve the same authenticated scope, immutable ledger semantics, and portable contract behavior.

## M0.4 Contract v0.4 threats and contract controls

| Threat | Contract control | Evidence |
| --- | --- | --- |
| Client claims another tenant or app | Authenticated server context is compared with client scope; mismatches are rejected. | Tenant-isolation fixture and mutation. |
| A malformed or replayed record ID overwrites evidence | `record_id` is globally unique; every collision is rejected without choosing a winner. | Collision mutation and delivery/rejection artifacts. |
| A reference crosses a tenant or app boundary | Privacy, correction, and refund references resolve only in their enclosing tenant/app scope. | Cross-scope mutations. |
| Two clicks claim one `click_id` | `click_id` is unique within tenant/app. Zero candidates are unknown, one is evaluated, and multiple are unattributed as ambiguous. | Ambiguous-click mutation. |
| Reinstall state erases valid paid evidence | `install_type` is orthogonal to attribution. Paid evidence can yield non-organic attribution for a new reinstall/redownload installation anchor; no-referrer evidence can yield organic. | Fixture 10. |
| Revenue attaches to an uncertain installation | Metric joins require one explicit tenant/app-qualified installation anchor. | Installation-anchor assertions and D0 mutations. |
| A public reference reveals protected evidence or loses handling policy | Every evidence reference requires tenant, app, payload lifecycle, opaque reference, and `access_class`. | Schema/registry checks and the missing-access-class mutation. |
| A predictable click ID permits guessing or click injection | Redirectors generate at least 128 bits from a cryptographically secure random source and encode at least 22 base64url-compatible characters. | Click schema and short-ID mutation. |
| An injected click is silently treated as ordinary evidence | The public evaluator derives CTIT only from server-authoritative click and install times and can emit `click_injection_suspected` without exposing private signals or production thresholds. | Fixture 41 and the 9.999/10.000-second CTIT boundary mutation. |
| Aggregate output is mislabeled as installation evidence | `subject_scope` structurally selects the `aggregate:` or `installation:` subject-reference namespace. | Attribution-schema mutation. |
| A completed deletion request retains its subject identifier | Completion forbids `deletion_subject_ref` and requires an HMAC-SHA-256 `deletion_subject_digest`; the HMAC key remains deployment-private. | Privacy-request schema, fixture 17, and privacy mutations. |
| A malformed calendar timestamp reaches attribution or metrics | Calendar-invalid ingress is rejected as `timestamp_invalid`, its payload is discarded, and only non-identifying metadata remains. | Fixture 20 and timestamp mutations. |
| Replay suspicion is confused with ordinary retry delivery | Replay suspicion produces a public fraud-decision category while duplicate delivery remains an independent ingestion classification. | Fixture 25. |
| Retention expiry silently changes historical metrics | Expired evidence produces a tombstone and an immutable replacement run marked `retention_affected`. | Fixture 26. |
| A provider-reported judgment is mistaken for first-party deterministic attribution | Imported attribution uses the separate `imported` method and `provider_reported` model, with neutral reconciliation reasons. | Fixtures 28-31. |
| An unregistered processing purpose bypasses policy evaluation | Purpose IDs are closed by a registry and schema equality checks; every registered purpose is exercised synthetically. | Fixtures 25, 33, and 34 plus the unknown-purpose mutation. |
| An aggregate Apple postback is presented as installation-level evidence | SKAdNetwork and AdAttributionKit use aggregate subjects, separate methods, explicit signature status, and aggregate-only compatibility rows. | Fixture 34. |
| Public artifacts expose operational defenses | The public envelope contains categories, references, and digests only. Live thresholds, models, watchlists, keys, and response timing remain private. | Schema and text scan. |

## Deterministic selection policy

Contract v0.4 does not select among multiple accepted clicks with one `click_id`: it returns `ambiguous_click_id`. If a later, explicitly versioned contract permits multiple candidates, it must first sort candidates by `redirector_click_at` descending, then `received_at` descending, then `record_id` ascending, and record the selected candidate and all exclusions. That future rule is not active in v0.4.

## M1a runtime threat table

| Component | Boundary and primary threats | Implemented controls | Residual risk |
| --- | --- | --- | --- |
<!-- threat-component:import-worker -->
| `import-worker` | Untrusted export rows, malformed mappings, oversized files, duplicate snapshots, and accidental value logging | Closed mapping schema; declarative conversion; pre-insert limits; row rejection outside the evaluator; content digest and ledger idempotency; count/field-only logs | Live provider export variations remain operator-validated outside the repository. |
<!-- threat-component:max-receiver -->
| `max-receiver` | Forged/tampered postbacks, identifier leakage, replay, burst abuse, and timeout loss | EVENT_TOKEN_ALL with documented fallback; constant-time comparison; strict macro allowlist; IDFA/IDFV/IP boot and request rejection; token bucket; durable inbox before 204; daily aggregate backfill port | Account enablement, provider delivery latency, and live token behavior are unverified without an operator account. |
<!-- threat-component:payload-store -->
| `payload-store` | Plaintext exposure, object swapping, ciphertext tampering, and undecryptable-but-retained deletion residue | AES-256-GCM; random DEK per object; separately wrapped DEK; tenant/app/object AAD; separate object and key files; purge removes both; integration test proves ciphertext-only storage and post-purge decryption failure | Host volume, backup, KEK rotation, and external secret-manager controls remain deployment responsibilities. |
<!-- threat-component:admin-api -->
| `admin-api` | Bearer theft, cross-tenant deletion, excessive requests, identifier retention, and unaudited privileged actions | scrypt verifier only; constant-time check; role capability matrix; at most configured active keys; tenant scope plus per-route app resolution; token bucket; completed artifact retains a digest rather than subject; append-only actor audit; separately HMAC-authenticated on-device deletion | Identity federation, approval workflow, automated rotation UI, and multi-instance rate enforcement remain deployment controls. |
<!-- threat-component:postgres-ledger -->
| `postgres-ledger` | Cross-tenant reads/writes, evidence overwrite, ambiguous delivery identity, and destructive deletion | FORCE RLS with transaction-local tenant; app role lacks DDL/update/delete; reader cannot access verifier/replay-manifest secrets; high-value append-only triggers; separate deliveries and logical IDs; redaction as state/tombstone/correction rows; disposable restore/privacy-reapply integration | High availability, real backup recovery, capacity, patching, and production database hardening require operator evidence. |
<!-- threat-component:runtime-ci -->
| `runtime-ci` | Migration drift, self-consistent evaluator errors, missing runtime security tests, or incomplete dependency inventory | Pinned Linux job; PostgreSQL 17; double migration and schema snapshot; unit/integration; seed-to-golden parity; Compose smoke; component coverage; one CycloneDX SBOM per npm workspace with missing-file failure | CI is synthetic evidence and cannot prove real account, device, campaign, capacity, or production TLS behavior. |

## M2 trust-boundary additions

| Component | Boundary and primary threats | Implemented or required controls | Residual risk |
| --- | --- | --- | --- |
<!-- threat-component:redirector -->
| `redirector` | Open-redirect abuse, slug enumeration, click flooding, source-IP retention, User-Agent fingerprinting, click injection, and redirect availability | Destination allowlist at link creation; stored destination only; CSPRNG slug and click ID; byte-identical safe fallback; bounded in-memory source-IP bucket; no source-IP persistence; country derivation off by default; server-authoritative click time; durable click inbox | A hostile tenant can still publish an approved-domain link with harmful content. Proxy logs and horizontal rate limiting remain deployment controls. |
<!-- threat-component:sdk-ingestion -->
| `sdk-ingestion` | Body tampering, replay, app/installation impersonation, oversized batches, forged deletion, worker crash, and cross-tenant evidence | Raw-body HMAC before JSON parsing; configured tenant/app scope; two-key overlap; per-installation random secret; tenant/app keyed installation digest; constant-time verification; bounded rates and size; deletable non-evidence nonce table; durable encrypted inbox before `202`; append-only processing states; credential-bound deletion and audit | **M2 does not prevent an attacker who possesses the APK from enrolling installations and delivering fabricated installs or events.** Enrollment limits, event idempotency, signatures, nonce expiry, and audit make the activity bounded and visible; M5 reserves integrity evidence but live Play Integrity remains operator work. Compromise of both PostgreSQL and the payload KEK permits request forgery. |
<!-- threat-component:sdk-android -->
| `sdk-android` | Queue leakage, backup-restored identifiers, unauthorized provider reads, consent-withdrawal delivery, and client secret extraction | Excluded storage and backup rules; durable Room queue; purpose-scoped purge; pre-initialization collection disablement; HMAC requests; provider mapping and accessor compile gates; synthetic emulator tests | APK extraction means the app-level SDK secret cannot establish a trusted device. Real-device, Play, Meta, and MAX behavior remains operator evidence. |
<!-- threat-component:unity-bridge -->
| `unity-bridge` | Callback thread misuse, JNI/C ABI lifetime leaks, event-field drift, missing ad-format subscriptions, and generated-project configuration loss | Typed C# bridges; Android object leases; iOS function-pointer request IDs; main-thread dispatcher; 10,000-callback synthetic probe; four-format subscription table; generated-plist/source-copy postprocessor tests | Real Unity Android/iOS export, generated-Xcode compilation, and live MAX behavior remain operator-verified. |

## M3 trust-boundary addition

| Component | Boundary and primary threats | Implemented controls | Residual risk |
| --- | --- | --- | --- |
<!-- threat-component:dashboard -->
| `dashboard` | Admin-key disclosure, session theft, CSRF, cross-tenant app discovery, report-query injection, identifier export, login abuse, and client-side supply-chain growth | scrypt admin-key verification; opaque 32-byte sessions stored only as SHA-256 digests; fixed 12-hour expiry; Strict/Secure/HttpOnly cookie; HMAC synchronizer token and Origin mismatch rejection; bearer/cookie namespace separation; tenant-forced reader RLS; identical app-not-found responses; allowlisted typed filters with bound SQL; aggregate-only raw counts; CSP with no scripts; memory-only source-IP throttling; fixed API runtime SBOM baseline | Production TLS, reverse-proxy log retention, multi-instance rate limiting, browser usability, and real-cardinality query performance remain operator evidence. |

## M4 trust-boundary additions

| Component | Boundary and primary threats | Implemented controls | Residual risk |
| --- | --- | --- | --- |
<!-- threat-component:apple-postback-receiver -->
| `apple-postback-receiver` | Forged Apple postbacks, unsigned-field confusion, transaction replay/conflict, ADAM-ID enumeration, invalid-signature flooding, token disclosure, and aggregate-to-installation identity joins | Generated P-256/ES256 vectors; exact signed-field/JWS verification; explicit unsigned evidence classification; non-enumerating 200 responses; SECURITY DEFINER exact app lookup with forced-RLS ledger writes; transaction idempotency; invalid-signature quota; protected raw AdServices token; aggregate subject namespace and installation-join rejection | A verified signature proves Apple origin, not a genuine install. Live developer-copy delivery, second/third SKAN copies, Apple latency, and provider availability remain operator evidence. |
<!-- threat-component:sdk-ios -->
| `sdk-ios` | IPA secret extraction, queue/credential leakage, restored identifiers, pre-consent Apple reads, callback lifetime misuse, privacy-manifest drift, and undeclared device API access | One excluded/protected storage subtree; WAL queue and process-death tests; `secure_delete`; HMAC shared vectors; collection-default and withdrawal gates; deletion-first reset; no second AdServices read; C ABI allocation table; built-object Required Reason/forbidden-symbol audit; tracking-disabled privacy manifest; dependency-empty runtime SBOM | **M4 does not prevent an attacker who possesses the IPA from enrolling installations or fabricating events.** M5 reserves App Attest evidence, but live App Attest, backup/transfer behavior, App Store privacy review, live MAX, and Unity export remain operator evidence. |

## M5 trust-boundary additions

| Component | Boundary and primary threats | Implemented controls | Residual risk |
| --- | --- | --- | --- |
<!-- threat-component:production-control-plane -->
| `production-control-plane` | Over-privileged administrator keys, stale dashboard sessions, cross-bundle supersession, rule-definition disclosure, and reader access to verifier hashes | Closed `admin/operator/read_only` capability matrix; tenant-wide identity plus per-route app validation; session role revalidation; verifier tables revoked from reader; append-only same-bundle predecessor chain; one root/one successor constraints; artifact-column equality; opaque audit references | Production identity federation, hardware-backed key storage, approval workflow, multi-party authorization, and real rotation drills remain operator controls. |
<!-- threat-component:privacy-restore -->
| `privacy-restore` | Restored encrypted payload resurrection, deletion-ledger loss, replaying an incorrect metric definition, partial purge, and destructive live restore | PostgreSQL custom archive restored only into a new target; separately protected payload snapshot and key; completed-request reapply before traffic; payload purge plus unreadability check; idempotent tombstone/correction/audit append; exact replay manifest; replacement metric supersession; unsupported affected runs fail closed | A backup predating a completed request is unsafe without a later authoritative ledger. Real storage snapshots, key custody, recovery objectives, and operator execution are not CI evidence. |
<!-- threat-component:operational-observability -->
| `operational-observability` | Payload/identifier leakage in logs or labels, unauthenticated metrics, high-cardinality exhaustion, misleading load budgets, and missing distributed trace context | Closed typed log events plus source lint; bounded route/method/status/queue labels; bearer-authenticated `/metrics`; no identifiers or payload values; fixed histogram buckets; synthetic p50/p95/p99 artifact with informational budgets only | Reverse-proxy/platform logs, production alert thresholds, multi-replica aggregation, OpenTelemetry tracing, and representative load remain operator decisions. |
<!-- threat-component:integrity-evidence -->
| `integrity-evidence` | Replayed attestations, treating outage as fraud, trusting one device signal, provider-token disclosure, or attribution changes based on unverified evidence | Optional normalized evidence-only contract field; opaque protected reference; provider/verdict vocabulary; request-hash/challenge guidance; no live verifier or automatic attribution/fraud action; synthetic fixture only | Play/App Attest projects, server verification, rollout, false-positive review, key rotation, and outage behavior are wholly unverified until the operator checklist is completed. |

## Residual risk and release gates

M1-M5 now have local network services, a tenant database, authenticated and role-scoped admin paths, envelope-encrypted protected-object storage, Android/iOS SDKs, Apple receivers, synthetic restore/privacy/load gates, operational metrics, and release inventories. They still cannot prove production TLS termination, external secret-manager operation, real provider/device delivery, representative capacity, availability, backup operations, live integrity or fraud controls, App Store review, or incident response. Those remain operator gates.

The M0.4 Contract v0.4 gate requires the complete fixture and mutation suite plus the identity-only migration proof. The M1a local gate adds the [privacy and security release-gate crosswalk](privacy-security.md#release-gates), ledger-isolation and deletion tests, envelope-encryption evidence, runtime CI, and one SBOM per workspace. M5 adds disposable restore/privacy-reapply, RBAC, observability, and informational synthetic-load evidence. Production transport and operator evidence remain unverified until recorded outside this repository.
