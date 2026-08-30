# Release Runbook

OpenMasu publishes source tags and reproducible local SDK bundles. This runbook
does not publish Maven, Swift, Unity, npm, container, or hosting artifacts to a
public registry.

The source and SDK are configured for candidate `v0.2.0`. A configured version
is not publication by itself: a candidate must not be treated as published
unless the matching annotated tag and GitHub Release point to the same green
commit. A release must describe that exact tag target and must not reuse an
older evidence manifest as proof for a newer commit. Version-bearing source,
notes, manifest, SBOMs, and artifact paths move together. See
[Release records](../releases/README.md).

## 1. Freeze the candidate

1. Select one reviewed commit on a release branch.
2. Confirm the worktree is clean and all intended changes are committed.
3. Confirm no real data, credentials, exports, screenshots, private thresholds,
   generated secrets, or local payload stores are tracked.
4. Record the intended source version, SDK version, Contract v0.4 patch level,
   and release-note path.

## 2. Reproduce repository evidence

Use the pinned Node, npm, and Python versions:

```bash
npm ci
python -m pip install --require-hashes --requirement requirements-contract.txt
npm run pilot:preflight
npm run pilot:synthetic -- --disposable
npm run validate
```

The preflight records unavailable device/provider/production gates as `not_run`.
The synthetic pilot proves the disposable runtime path. Neither is live-provider
or production evidence.

Run the relevant additional gates:

```bash
npm test
npm run test:integration
npm run test:db-invariants
npm run verify:parity
npm run test:metric-parity
npm run test:dashboard-parity
npm run test:privacy-e2e
npm run test:backup-restore
npm run check:threat-model
npm run check:operational-logs
```

Run the pinned Android, iOS, Unity, emulator, and simulator workflows at the
exact candidate commit. Platform CI is required even when the contributor's
local operating system cannot run a platform gate.

Pull-request path selection never applies to a `main` push or manual workflow
dispatch. Release evidence must come from one of those full-gate events at the
exact candidate commit, not from a pull request whose unrelated steps were
intentionally skipped.

## 3. Verify identities and documentation

```bash
npm run check:release-version
npm run check:doc-drift
npm run verify:contract-rename
```

Confirm:

- SDK runtime constants, samples, package manifests, build tools, and SBOM names
  carry the same release version;
- root contract packages retain their independent Contract v0.4 identity;
- `README.md`, `docs/STATUS.md`, release notes, and the SDK bundle path refer to
  the intended candidate;
- the active validation inventory matches the contract specification and
  roadmap;
- post-tag development is not described as part of an older tag.

## 4. Build reproducible SDK artifacts

```bash
npm run sbom
npm run test:sdk-release-tool
npm run build:sdk-release
python tools/build-sdk-release.py --reproducibility-check
npm run check:sdk-release
npm run test:unity-upm
```

The configured v0.2.0 bundle path is
`build/sdk-release/openmasu-sdk-0.2.0/`. It is valid release evidence only
at the exact source commit named by the matching annotated tag, after every
required full platform gate is green for that commit.

Verify the Android AAR/POM files, Unity UPM archive, Swift source archive,
normalized CycloneDX SBOMs, `release-manifest.json`, and `SHA256SUMS`. The two
packaging passes must be byte-identical.
OpenMasu Maven modules derive their internal dependency versions from the one
SDK version being packaged; only third-party dependencies carry independent
version pins.

| Artifact | Repository output | Not provided |
| --- | --- | --- |
| Android | five local AAR/POM pairs | Maven registry publication and signing |
| Unity | self-contained local UPM `.tgz`, standalone Gradle gate, and synthetic Unity 6 Android export probe | OpenUPM publication, Unity 2022.3 proof, and physical-device proof |
| iOS | deterministic Swift source ZIP | binary XCFramework, registry publication, and distribution signing |

## 5. Review the release boundary

Release notes must state:

- what OpenMasu is;
- which capabilities are implemented and synthetically verified;
- the exact Contract v0.4 patch level;
- real-provider, real-device, store, domain, production, capacity, backup, and
  operator evidence that remains unverified;
- that the candidate is not described as production-ready or a proven MMP
  replacement.

The synthetic load record is informational and must not become a production
service-level objective without representative measurement.

## 6. Tag and publish

Before any GitHub write, verify the authenticated account, exact repository,
visibility, tag name, commit, and explicit authorization for that operation.
Confirm every required workflow is green on the exact commit. Create an
annotated or signed tag and release only after the release owner approves it.
After creating the annotated tag and rebuilding the bundle at its target, run:

```bash
python tools/build-sdk-release.py --verify-only build/sdk-release/openmasu-sdk-0.2.0 --verify-tag
```

This final check requires the annotated `v0.2.0` target, current checkout, and
bundle manifest revision to be identical.

Candidate `v0.2.0` uses
[its own synthetic evidence manifest](../validation/v0.2.0-synthetic-evidence.md).
The published rc.4 and preceding records remain immutable historical evidence.

## Public release contents

- contract schemas, registries, specification, and reviewed synthetic fixtures;
- TypeScript and Python evaluators;
- API, redirector, worker, runtime, database, and Compose source;
- Android, iOS, and Unity SDK and sample source;
- reproducible local SDK artifacts and their manifests;
- architecture, security, operations, status, and validation documents;
- SBOMs and checksums generated by the pinned workflows.

Never attach runtime secrets, real data, exports, identifiers, payload-store
snapshots, private rule definitions, provider responses, or production logs.

## Rollback

Application rollback must not reverse an append-only migration or resurrect
redacted payloads. Restore an earlier compatible application against the newer
schema, or restore into a new target and reapply privacy state using the backup
runbook. If compatibility is uncertain, keep traffic stopped; do not use a
destructive schema rollback.

Production TLS, secret management, backup schedules, real restore evidence,
incident response, distribution signing, capacity, and trademark registration
remain operator or release-owner gates.
