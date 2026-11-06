# Source-free runtime image archives

The runtime packager builds the existing Dockerfile into one Linux/amd64 image
for bootstrap, migrations, API, worker, redirector and operator commands. The
bundle contains the existing Compose file plus an image-only override, not a
second deployment topology. Operators need Docker Engine, Compose 2.32.4 or newer,
a POSIX shell and `sha256sum`; they do not need a source checkout or host
Node/npm/Python/Git/PostgreSQL client tools.

## Candidate versus published release

Full Runtime CI uploads `runtime-image-archive` after the existing isolated pilot
has booted that archive in a source-free directory. Download the artifact from the
exact successful run and extract its single source-revision directory. A PR run
contains its merge-preview revision: it is not a main/tag release artifact.
Untagged builds have version `0.1.0-dev.<source-sha-prefix>` and `source_tag: null`.
They are development candidates, not a published stable deployment target.

No existing SDK/source release gains these files retroactively. The runtime
version is independent of SDK and contract versions; all three are recorded in
`runtime-manifest.json`. A release owner must approve a new annotated
`runtime-v<version>` tag and exact-source CI before public release publication.
Registry publishing, image signing, ARM64, production qualification and offline
installation are not provided. PostgreSQL and the optional Caddy proxy still use
the images declared by Compose.

## Load and start

Use a new deployment directory. Obtain the trusted publisher's `SHA256SUMS`
receipt independently of an untrusted mirror; archive hashes are integrity checks,
not publisher signatures. The bundle includes `INSTALL.md` with its exact source.

```sh
sh runtime.sh verify
sh runtime.sh load
cp .env.example .env
# Edit .env for public URLs and non-secret settings; keep generated secrets private.
sh runtime.sh compose up -d --wait --no-build
sh runtime.sh compose ps
```

`load` checks every downloaded file before `docker image load`, then verifies the
loaded image's fixed identity and deployment files. The override pins the local
image ID and uses `pull_policy: never`, so a mutable tag cannot silently choose a
different OpenMasu image. The image ID is the Docker configuration digest, **not**
a registry manifest digest. The archive's separate SHA-256 covers its layers;
the manifest binds source revision/tag, version, SDK/contract identities, deployment
files and the generated CycloneDX inventory (installed npm and Alpine packages).
Builds record their exact bytes; no cross-build byte reproducibility claim is made.

The default deployment is persistent and cannot run synthetic seed. Initial
bootstrap generates the private `.env` and named secret volumes as in the source
installation. Keep the directory, Compose project name and those volumes stable.
Never use `down --volumes` for an installation whose ledger you need to retain.
The optional proxy still uses the supplied `config/Caddyfile`; configure public
TLS and network exposure using [Single-host deployment](single-host.md).

## Operator commands without host tooling

The opt-in `operations` profile uses the same image with privileged migration
credentials and app/payload access. It is not a long-running network service.
Only a trusted deployment operator may run it. PostgreSQL 17 client binaries are
included for the existing backup CLI. Do not expose secrets in command arguments.

For a same-image backup/restore rehearsal, follow all custody and freshness rules
in [Backup and restore](backup-restore.md). Example commands, after stopping every
writer and preventing new writers or privacy intake as required by that runbook:

```sh
sh runtime.sh compose stop api worker redirector
# BACKUP_DIR is an existing protected absolute directory outside the deployment.
sh runtime.sh compose --profile operations run --rm --no-deps -v "$BACKUP_DIR:/private" operations run backup:create -- --writers-stopped --output /private/bundle-new --master-key-ref key:operator-reference
sh runtime.sh compose --profile operations run --rm --no-deps -v "$BACKUP_DIR:/private" operations run backup:boundary -- --writers-stopped --output /private/boundary-new.json
sh runtime.sh compose --profile operations run --rm --no-deps -v "$BACKUP_DIR:/private" operations run backup:check -- --directory /private/bundle-new --boundary /private/boundary-new.json
sh runtime.sh compose --profile operations run --rm --no-deps -v "$BACKUP_DIR:/private" operations run backup:restore -- --directory /private/bundle-new --boundary /private/boundary-new.json --payload-output /private/restored-new --master-key-ref key:operator-reference --privacy-intake-stopped
```

The restore creates a new isolated database and restores objects/keys into a new
private directory. It drains recognized privacy work and keeps traffic restart
manual. It does **not** redirect the existing Compose database or replace its
payload volume. Keep writers stopped and complete the runbook's promotion checks;
do not point old writers at a partially restored target. Preserve the master key
independently of the backup. Archive, encrypted payload and private receipts never
belong in a public repository or CI artifact.

For forward upgrade, use [Safe upgrade](upgrade.md)'s recognized source versions,
stopped-writer boundary, matched private backup declaration and migration checks.
The source-free equivalent of its preflight is:

```sh
sh runtime.sh compose --profile operations run --rm --no-deps -v "$BACKUP_DIR:/private" operations run db:upgrade:preflight -- --from=v0.2.0 --to=runtime-v<approved-version> --backup=/private/upgrade.json --database-backup=/private/openmasu.dump --payload-backup=/private/payloads.tar
```

Use the exact target tag in the verified runtime manifest, not an SDK version or
the placeholder above. Untagged candidates refuse deployment upgrade preflight.
Do not run `compose up` before a required upgrade preflight: its migration service
applies forward DDL. With writers stopped, run the preflight and explicit migrate
service first, rerun preflight/schema checks, drain/reapply privacy for every tenant,
and only then restart writers manually. Keep the same project/volumes and original
private `.env`; load the new image and replace only the verified non-secret bundle
files. Do not copy `.env.example` over an existing `.env`.

## Build and publication

Maintainers build from a clean committed checkout (not an operator prerequisite):

```sh
npm run build:runtime-artifact -- --output=build/runtime-release/candidate
# Release owner: after approving and creating the exact annotated runtime tag:
npm run build:runtime-artifact -- --output=build/runtime-release/tagged --tag=runtime-v<approved-version>
```

Packaging refuses an existing output directory, dirty source, lightweight tag or
tag pointing to another commit. Only `git archive HEAD` enters the build context;
local secrets, real-data directories, payloads and caches are never copied in.
The image's fixed `.runtime-identity.json` hashes source and migration files;
backup/upgrade commands validate it rather than trusting an environment override.

Run the existing pilot once with `--artifact` for the selected candidate instead
of also running its source-build path. Runtime CI already owns this gate:

```sh
npm run pilot:synthetic -- --disposable --artifact
```

It loads the archive into an otherwise source-free directory, checks running image
IDs, empty startup, backup/create/check/restore and a 48-migration-to-current
upgrade using image-shipped tools, then reuses all existing seed/parity, restart,
configuration, readiness and HTTP checks. Backup proof here uses the empty initial
ledger; the existing backup suite owns populated/recognized-deletion cases. Both
run in the same full Runtime job. This is synthetic evidence, not a live restore
or production capacity claim. Temporary containers/networks/volumes are reclaimed;
the public artifact contains only the image, manifest, SBOM and non-secret setup.

Before a release, acquire the exact tagged candidate, verify all hashes and image
identity, publish the complete directory as a release archive without overwriting
an existing release, and re-download/verify it. Record the source and Runtime run
in the release receipt. Development CI artifacts expire; they are not a permanent
release channel. See [Release runbook](release.md).

For approved tagged publication, dispatch the existing Runtime workflow **at that
tag** with `runtime_artifact_tag=runtime-v<approved-version>`. The same full pilot
packages and verifies tagged bytes; download its `runtime-image-archive` rather
than relabelling a previous untagged artifact. The builder checks the annotated
tag's peeled commit against HEAD before building. This input does not create a
tag, publish a release or bypass the release-owner approval.

Primary Docker/Alpine references checked 2026-11-06:

- https://docs.docker.com/reference/cli/docker/image/save/
- https://docs.docker.com/reference/cli/docker/image/load/
- https://docs.docker.com/reference/compose-file/merge/
- https://github.com/docker/compose/releases/tag/v2.32.3 (local image-ID fix)
- https://github.com/docker/compose/releases/tag/v2.32.4 (corrected version reporting)
- https://pkgs.alpinelinux.org/package/v3.22/main/x86_64/postgresql17-client
