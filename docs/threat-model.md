# Initial Threat Model

This is the public M0.1 threat model for the contract and its reference evaluators. It describes security properties and release gates, not live defenses, incident response timing, credentials, or personal data.

## Assets and trust boundaries

- Protected evidence and its digests are tenant- and app-scoped.
- Server-generated `record_id` is a global ledger identity; client event IDs are not ledger identities.
- `installation_id` is an app-local, resettable installation anchor. A reinstall or redownload creates a new anchor.
- `click_id` is redirector evidence scoped to one tenant and app.
- Derived attribution, metric, privacy, and reconciliation artifacts must retain enough protected references to be audited without exposing raw evidence.

Untrusted inputs cross the SDK, redirector, import, and fixture boundaries. The PostgreSQL ledger is the authoritative received-evidence store in the future runtime architecture. Edge delivery may be deployed close to users, but must preserve the same authenticated scope, immutable ledger semantics, and portable contract behavior.

## M0.1 threats and contract controls

| Threat | M0.1 control | Evidence |
| --- | --- | --- |
| Client claims another tenant or app | Authenticated server context is compared with client scope; mismatches are rejected. | Tenant-isolation fixture and mutation. |
| A malformed or replayed record ID overwrites evidence | `record_id` is globally unique; every collision is rejected without choosing a winner. | Collision mutation and delivery/rejection artifacts. |
| A reference crosses a tenant or app boundary | Privacy, correction, and refund references resolve only in their enclosing tenant/app scope. | Cross-scope mutations. |
| Two clicks claim one `click_id` | `click_id` is unique within tenant/app. Zero candidates are unknown, one is evaluated, and multiple are unattributed as ambiguous. | Ambiguous-click mutation. |
| Reinstall state erases valid paid evidence | `install_type` is orthogonal to attribution. Paid evidence can yield non-organic attribution for a new reinstall/redownload installation anchor; no-referrer evidence can yield organic. | Fixture 10. |
| Revenue attaches to an uncertain installation | Metric joins require one explicit tenant/app-qualified installation anchor. | Installation-anchor assertions and D0 mutations. |
| Public artifacts expose operational defenses | The public envelope contains categories, references, and digests only. Live thresholds, models, watchlists, keys, and response timing remain private. | Schema and text scan. |

## Deterministic selection policy

M0.1 does not select among multiple accepted clicks with one `click_id`: it returns `ambiguous_click_id`. If a later, explicitly versioned contract permits multiple candidates, it must first sort candidates by `redirector_click_at` descending, then `received_at` descending, then `record_id` ascending, and record the selected candidate and all exclusions. That future rule is not active in M0.1.

## Residual risk and release gates

M0.1 has no network service, credentials, tenant database, or production fraud controls. It cannot prove runtime authentication, authorization, retention execution, availability, backup recovery, or protection against live abuse. Those remain release gates.

The M0.1 contract gate requires the complete fixture and mutation suite, the [privacy and security release-gate crosswalk](privacy-security.md#release-gates), and the [roadmap M0.1 status](roadmap.md#m01-contract-hardening). Before M1 accepts runtime code, a private vulnerability-reporting path, ledger-isolation tests, deletion recalculation, and an SBOM for every runtime artifact are required.
