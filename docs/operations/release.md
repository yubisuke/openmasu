# Release Runbook

Open MMP currently ships source and reproducible evidence. This runbook does
not publish packages, container images, Maven artifacts, Swift packages, UPM
packages, or npm packages to a public registry.

## Release candidate gate

1. Start from a clean, reviewed branch. Confirm no real data, credentials,
   provider exports, screenshots, private thresholds, or generated local
   secrets are tracked.
2. Confirm the contract package version, migration ledger, schema snapshot,
   fixture counts, and `docs/STATUS.md` agree.
3. Run `npm ci` with Node 22.18.0 and npm 11.6.2, install the hash-pinned Python
   requirements, and run `npm run validate`.
4. Run unit, integration, database-invariant, parity, consistency, privacy
   restore, threat-model, environment-coverage, and operational-log gates.
5. Run Android, iOS, Unity, and emulator/simulator workflows. A successful
   synthetic workflow does not replace the M2/M4 device checklists.
6. Generate CycloneDX JSON SBOMs with `npm run sbom`, the Android SBOM task, and
   the iOS SDK workflow. Confirm every expected workspace and SDK artifact is
   present and the API runtime component baseline is unchanged unless an
   approved dependency change explains it.
7. Review the [informational synthetic load record](../validation/m5-load-results.md). Do not convert its p95
   record into a production service-level objective without a representative
   environment and operator approval.
8. Confirm all GitHub Actions are green at the exact release commit. Action
   SHA changes require their own review and are never incidental release work.
9. Create a signed or annotated source tag only after the owner approves the
   release candidate. Record the exact commit and CI run.

## Source release contents

- contract schemas, registries, specification, and reviewed synthetic fixtures;
- TypeScript and Python contract evaluators;
- API, redirector, worker, runtime, database migrations, and Compose source;
- Android, iOS, and Unity SDK source and sample source;
- architecture, security, operation, and validation documents;
- CycloneDX SBOMs produced by the pinned workflows; and
- CI evidence links and the operator residual checklist.

Do not attach runtime secrets, real data, provider exports, real identifiers,
payload-store snapshots, private rule definitions, production logs, or load
inputs to a public release.

## Rollback

Application rollback must not reverse an already-applied append-only database
migration or resurrect redacted payloads. Restore service binaries from the
last approved source tag while retaining the newer compatible schema, or
restore into a new target using the backup runbook and reapply privacy before
traffic. If compatibility is uncertain, keep traffic stopped and escalate to
the operator; do not use destructive schema rollback commands.

## Remaining operator gates

Branch protection, secret scanning, production TLS, external secret managers,
real backup recovery, real capacity, incident response, distribution signing,
and trademark clearance are not established by this repository. Track them in
`docs/validation/m5-operator-checklist.md`.
