# Release Runbook

OpenMasu publishes source tags and downloadable reproducible SDK bundles. This runbook
does not publish Maven, Swift, Unity, npm, container, or hosting artifacts to a
public registry.

The current published prerelease is `v0.3.0-rc.1`. Its annotated tag,
[GitHub Release](https://github.com/yubisuke/openmasu/releases/tag/v0.3.0-rc.1)
and eight public assets point to green commit `90a0f5f`; see the
[publication receipt](../validation/v0.3.0-rc.1-publication.md). `v0.2.0`
remains the latest non-prerelease source line and is unchanged.
A configured version is not publication by
itself: future candidates must not be treated as published unless their
matching annotated tag and GitHub Release point to the same green commit. A
release must describe that exact tag target and must not reuse an older
evidence manifest as proof for a newer commit. Version-bearing source, notes,
manifest, SBOMs, and artifact paths move together. See
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
npm run validate
npm run pilot:preflight
```

The preflight records unavailable device/provider/production gates as `not_run`.
The synthetic pilot in Runtime CI proves the disposable runtime path. Neither
preflight nor CI is live-provider or production evidence. For a local runtime
investigation, `npm run pilot:synthetic -- --disposable` is available; do not
repeat it just because the exact candidate's full Runtime job has passed.

Reuse the full workflow results at the exact candidate commit. Each correctness
suite has one owner; do not stack its focused aliases or repeat it locally after
that owner has passed:

| Evidence | Existing full CI owner |
| --- | --- |
| Schemas, goldens, TypeScript/Python parity, documentation, type checks and SDK packager unit tests | Contract validation on Windows and Linux |
| Runtime unit and application integration behavior, including dashboard consistency and signed ingestion | Runtime's unit and integration suites |
| RLS, role grants, schema idempotency, persisted golden parity and SQL calculations | Runtime's database and metric gates |
| Backup/restore, deletion reapplication and frozen-release upgrade | Runtime's dedicated backup/restore suite, run once with restore enabled |
| Disposable Compose startup, restart and HTTP smoke checks | Runtime's synthetic pilot |
| Operational logging, runtime SBOMs and relevant synthetic performance floors | Runtime's remaining full gates |

Run the pinned Android and iOS workflows at the exact candidate commit. Their
jobs include the Unity package and bridge gates plus the Android emulator and
iOS Simulator gates; there is no separate Unity workflow. Platform CI is
required even when the contributor's local operating system cannot run a
platform gate.

Pull-request path selection never applies to a `main` push or manual workflow
dispatch. Release evidence must come from one of those full-gate events at the
exact candidate commit, not from a pull request whose unrelated steps were
intentionally skipped.

## 3. Verify identities and documentation

Contract CI already checks release identity, documentation inventory and contract
rename compatibility. Use their standalone commands only when investigating a
specific mismatch; do not rerun them after full validation merely to produce a
second receipt.

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

Android CI already performs the two-pass reproducibility check and standalone
Unity package consumer gate. Acquire its bundle at the exact green candidate
commit for publication. If investigating packaging locally before freezing the
candidate, use the existing reproducibility command once:

```bash
python tools/build-sdk-release.py --reproducibility-check
```

It builds both passes and verifies their manifest and bytes; do not precede it
with another `build:sdk-release` run. Packager unit tests already belong to
`validate`; the standalone Unity consumer test is a focused diagnostic, not a
second release checklist after Android CI.

The packager regenerates the ignored SDK SBOM and Android binary inputs from a
clean checkout before it creates the bundle. It does not trust existing
`sbom/` or Gradle `build/` files as release inputs.

The v0.3.0-rc.1 bundle path is
`build/sdk-release/openmasu-sdk-0.3.0-rc.1/`. It is valid release evidence only
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
After creating the annotated tag and acquiring the bundle from its exact
target's full CI, run:

```bash
python tools/build-sdk-release.py --verify-only build/sdk-release/openmasu-sdk-0.3.0-rc.1 --verify-tag
```

This final check requires the annotated `v0.3.0-rc.1` target, current checkout, and
bundle manifest revision to be identical.
Run the verifier from a clean source checkout at that tag. A later `main`
checkout must fail this identity check; do not rebuild or replace the published
bundle to accommodate later documentation or code changes.

Download the `openmasu-sdk-release-bundle` artifact from the full Android workflow
at that exact green `main` commit. Do not use a PR's merge-preview artifact or an
older run, and do not rebuild at a later commit. Verify the downloaded bundle,
then wrap its already verified bytes for public download:

```bash
python tools/build-sdk-release.py --verify-only build/sdk-release/openmasu-sdk-0.3.0-rc.1 --verify-tag --release-assets build/sdk-release-assets/openmasu-sdk-0.3.0-rc.1
```

The output refuses an existing directory and contains eight files: the complete
SDK ZIP, separate Unity and iOS archives, the original manifest, three SDK SBOMs
and an outer `SHA256SUMS`. The ZIP retains the original internal checksums and
Maven layout. Attach these exact files to the matching GitHub prerelease; never
use upload clobber to replace an existing release. Download the published assets
again and verify checksums and manifest identity. Follow
[SDK distribution](../sdk-distribution.md) for consumer commands.

Published `v0.2.0` uses
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
