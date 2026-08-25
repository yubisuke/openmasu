# M5 Production Operator Checklist

M5 CI closes only repository-verifiable controls. Every item below remains an
operator or owner responsibility and must be evidenced without committing real
data, credentials, device identifiers, private rule values, or production logs.

## Repository and release governance

- Enable branch protection, required reviews, required CI, secret scanning,
  dependency review, and least-privilege GitHub access.
- Complete project-name and trademark clearance.
- Approve release signing, retention, vulnerability response, and rollback
  ownership.

## Hosting and security

- Terminate TLS 1.2 or later and test certificate renewal, HSTS, reverse-proxy
  header handling, and restricted `/metrics` access.
- Use an external secret manager, documented rotation, and separate database,
  payload, provider, and signing keys.
- Encrypt database volumes, payload storage, backups, and logs; define access,
  retention, deletion, and incident review.
- Replace single-process rate buckets when multiple replicas or measured abuse
  require shared enforcement.
- Define alerts for HTTP error rate/latency, SDK/MAX/AdServices backlog and age,
  database capacity, backup failure, restore failure, and privacy-reapply hard
  stops. Introduce OpenTelemetry only when cross-service tracing or operational
  cardinality justifies the dependency and privacy review.

## Recovery and privacy

- Execute the backup/restore runbook against an isolated representative
  environment. Measure recovery point and recovery time.
- Prove all completed privacy requests survive the selected backup lineage and
  run `db:reapply-privacy` before traffic.
- Run administrator and on-device deletion, recalculate affected metrics, and
  verify dashboard/JSON/CSV outputs and payload unreadability.
- Test incident response for a leaked admin key, SDK key, payload master key,
  database credential, and integrity-provider credential.

## Capacity and platform evidence

- Repeat the 100,000-event and 10,000-MAX-postback measurements in the intended
  topology and at expected cardinality; define budgets only after observation.
- Repeat the M2/M4 device/provider checklists, Unity exports, Apple delivery,
  dashboard usability, and real shadow reconciliation under authorization.
- Configure Play Integrity and App Attest only through the dedicated checklist.
- Confirm the final media-adapter boundary with legal/platform owners. Do not
  claim user-level attribution for a partner-only network.

## Go-live record

The owner records the release commit, source tag, CI runs, SBOM set, deployment
manifest, restore result, privacy-reapply result, capacity result, monitoring
ownership, incident contacts, residual risks, and explicit go/no-go decision.
This record stays outside the public repository.
