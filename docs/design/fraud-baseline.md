# Deterministic Fraud Design

Status: implemented and synthetically verified. See
[Project status](../STATUS.md) for the evidence vocabulary and open operator
gates.

## Purpose

Fraud output is an auditable classification of recorded evidence, not a hidden
score and not a promise to identify every abusive device. Every public rule is a
pure deterministic function of typed evidence and a registered rule bundle.

## Evidence rules

- Server or platform authoritative time outranks device occurrence time.
- A device-controlled claim remains device-controlled after normalization.
- A signal can affect a decision only when its source, version, and confidence
  are explicit.
- Missing or invalid authority produces a diagnostic or provisional result; it
  is not silently converted into confident fraud.
- The default public policy flags evidence without changing reported metrics.

## Public rule families

- click/referrer ordering and negative clock diagnostics;
- lower and upper click-to-install-time boundaries;
- redirector/referrer agreement;
- source-day click flooding;
- delivery replay and enrollment anomalies;
- bounded prefetch, source-rate, and client-class evidence;
- protected Play Integrity and App Attest verdict normalization.

Negative click-to-install time produces `ctit_clock_anomaly` with a clear/allow
decision. When the configured source-day negative rate is exceeded, affected
time-derived attribution remains provisional.

## Rule-bundle binding

Definitions are registered in the control plane as canonical JSON with a
verified digest. Activation selects one tenant/app revision. Runtime decisions
resolve the active definition and bind bundle ID, version, composite hash, and
revision. Replaying the same recorded evidence against the same revision must
produce the same canonical artifact; changing a threshold changes the hash and,
when applicable, the decision.

Transport, click-injection, aggregate, and integrity decisions use the same
active fraud bundle. The evaluator's built-in definition exists only for
contract fixtures and offline reference use.

## Actions

- `allow`: evidence proceeds without restriction;
- `flag`: evidence proceeds and remains visible for review;
- `quarantine`: evidence is held until a recorded deadline and resolution;
- `exclude`: an explicit policy removes it from net output while gross output
  remains reproducible.

Fraud action does not mutate raw records, deliveries, or logical events.
Exclusion is applied by metric selection and remains attributable to a recorded
decision and rule revision.

## Privacy boundary

The public system does not use third-party IP/device intelligence, fingerprinting,
device graphs, cross-advertiser history, or device-reset linkage. Only
`source_rate_class`, `prefetch_signal`, and `client_class` may leave the click
edge as keyless bounded classifications. No IP literal or User-Agent string may
appear in public schemas, fixtures, emitted artifacts, logs, or documentation
examples.

## Capability limits

OpenMasu cannot reliably detect a real-device farm using the permitted evidence
and deliberately does not classify identifier reset as fraud. Self-hosting also
lacks the cross-advertiser view available to a multi-tenant provider. These are
structural limits, not future accuracy claims.

A device-reported `deep_link_open` is a forgeable evidence surface. Fraud rules
may read it, but forged opens can still inflate re-engagement until a future
server-authority rule is designed from available evidence. This residual
applies to device-reported engagement metrics, not the separately verified
Apple-signed aggregate `aak_attributed_reengagements` series.

## Evidence gates

Pure rule tests, TypeScript/Python fixture parity, bundle mutation and replay,
PostgreSQL aggregate/action tests, no-effect flag tests, protected provider
normalization, artifact scans, quarantine resolution, and gross/net reporting.

## Residual boundary

Live provider projects, threshold calibration, false-positive rates, device-
farm detection, network acceptance, chargeback workflows, and private response
policy remain operator responsibilities.
