# Initial Threat Model

This is the public M0.2 Contract v0.2 threat model for the contract and its reference evaluators. It describes security properties and release gates, not live defenses, incident response timing, credentials, or personal data.

## Assets and trust boundaries

- Protected evidence and its digests are tenant- and app-scoped.
- Server-generated `record_id` is a global ledger identity; client event IDs are not ledger identities.
- `installation_id` is an app-local, resettable installation anchor. A reinstall or redownload creates a new anchor.
- `click_id` is redirector evidence scoped to one tenant and app.
- Derived attribution, metric, privacy, and reconciliation artifacts must retain enough protected references to be audited without exposing raw evidence.

Untrusted inputs cross the SDK, redirector, import, and fixture boundaries. The PostgreSQL ledger is the authoritative received-evidence store in the future runtime architecture. Edge delivery may be deployed close to users, but must preserve the same authenticated scope, immutable ledger semantics, and portable contract behavior.

## M0.2 Contract v0.2 threats and contract controls

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

Contract v0.2 does not select among multiple accepted clicks with one `click_id`: it returns `ambiguous_click_id`. If a later, explicitly versioned contract permits multiple candidates, it must first sort candidates by `redirector_click_at` descending, then `received_at` descending, then `record_id` ascending, and record the selected candidate and all exclusions. That future rule is not active in v0.2.

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
| `admin-api` | Bearer theft, cross-tenant deletion, excessive requests, identifier retention, and unaudited privileged actions | scrypt verifier only; constant-time check; at most two active keys; configured tenant/app scope; token bucket; completed artifact retains a digest rather than subject; append-only actor audit; device path fails closed with 501 | Dynamic key-rotation UI and on-device authentication are not implemented in M1a. |
<!-- threat-component:postgres-ledger -->
| `postgres-ledger` | Cross-tenant reads/writes, evidence overwrite, ambiguous delivery identity, and destructive deletion | FORCE RLS with transaction-local tenant; app role lacks DDL/update/delete; high-value append-only triggers; separate deliveries and logical IDs; redaction as state/tombstone/correction rows | Backup restore, high availability, and production database hardening require operator evidence. |
<!-- threat-component:runtime-ci -->
| `runtime-ci` | Migration drift, self-consistent evaluator errors, missing runtime security tests, or incomplete dependency inventory | Pinned Linux job; PostgreSQL 17; double migration and schema snapshot; unit/integration; seed-to-golden parity; Compose smoke; component coverage; five CycloneDX SBOMs with missing-file failure | CI is synthetic evidence and cannot prove real account, device, campaign, capacity, or production TLS behavior. |

## Residual risk and release gates

M1a now has a local network service, tenant database, authenticated admin path, envelope-encrypted protected-object store, and synthetic runtime security gates. It still cannot prove production TLS termination, external secret-manager operation, real provider delivery, capacity, availability, backup recovery, live fraud controls, or incident response. Those remain operator and later production gates.

The M0.2 Contract v0.2 gate requires the complete fixture and mutation suite. The M1a local gate adds the [privacy and security release-gate crosswalk](privacy-security.md#release-gates), ledger-isolation and deletion tests, envelope-encryption evidence, runtime CI, and one SBOM per workspace. Production transport and operational evidence remain unverified until an operator records them outside this repository.
