# Payload wrapping-key rotation

The payload store encrypts each object with a random data-encryption key (DEK).
The deployment's master key wraps those DEKs. `npm run payload:rewrap` replaces
the wrappers without decrypting or rewriting payload bodies, ledger references,
contract artifacts or reviewed fixtures. It is an **offline, single-host**
operation on the existing local filesystem, not an online KMS or an automatic
key-retirement service. No new dependency or provider connection is required.

## Before starting

- Use a clean, source-matched deployment containing this command. Older runtime
  releases cannot read the new wrapper format. Do not downgrade the binary after
  rotation; recovery uses a matched pre-rotation backup and its old key instead.
- Stop **all** API, worker, redirector, scheduled tasks, imports, privacy intake
  and operator commands. Keep PostgreSQL running. Drain existing work and prevent
  clients from restarting until cutover. The CLI uses the backup superuser and
  stopped-writer table/advisory locks; any other client DB session refuses it.
  The acknowledgment flag does not stop services for you.
- First make and check a matched [backup](backup-restore.md), keeping its source
  revision, privacy boundary and old key independently recoverable. Rotation
  does not update existing backup bundles or waive restored privacy reapplication.
- Prepare a distinct random target secret of at least 32 bytes in an
  operator-protected file **outside the repository and payload root**. Use private
  OS permissions/ACLs; do not place either secret in arguments, logs or an Issue.
  The payload root, its state and temporary files are trusted operator storage.
- Configure `OPENMASU_MIGRATION_DATABASE_URL`, `OPENMASU_PAYLOAD_STORE_DIR` and
  the **old** `OPENMASU_PAYLOAD_MASTER_KEY_FILE` through the existing protected
  environment. The existing environment-value master-key mechanism also works,
  but do not set both forms. Keep the target file separate; do not change the
  runtime master key yet.

## Run and resume

Choose opaque, non-identifying key aliases. The first `--from-key-ref` names the
legacy master key; later rotations must use the active recorded alias.

```bash
npm run payload:rewrap -- --writers-stopped \
  --from-key-ref key:previous --to-key-ref key:next \
  --target-key-file /private/secrets/payload-next --limit 500
```

Each invocation processes at most `--limit` wrappers (default 500, range
1–1000). Repeat the **same command and same secrets** while services stay stopped.
The store persists its cursor; the command does not need an operator-supplied
cursor or an all-record manifest. Filename enumeration uses bounded memory but
still scans the directory, so total downtime depends on object count and local
storage. No fixed recovery-time promise is made.

The counts-only JSON receipt reports `phase`, `processed`,
`verified_key_checks`, `cutover_ready` and `old_backup_key_custody_required`.
It never prints secrets, plaintext, object references or private paths.

1. `rewrapping`: wrappers move to version 2 with an authenticated target-key
   reference. Mixed old/new wrappers are expected only during this stopped phase.
2. `verifying`: a new, bounded full pass authenticates every surviving wrapper
   with the target key. Finishing replacement alone is not permission to retire
   the old key. `verified_key_checks` counts examined keys, not a live-object total.
3. `ready` and `cutover_ready: true`: all remaining wrappers passed. Only now
   replace the master secret used by **every** runtime/CLI with the target secret,
   keeping its recorded alias for future backup `--master-key-ref` arguments.
   Restart services manually and check readiness with the normal operator process.

For the supplied Compose installation, mount the protected target-key directory
read-only into the existing `operations` service and run the same command there:

```bash
docker compose --profile operations run --rm --no-deps \
  -v /private/secrets:/private/rotation:ro operations run payload:rewrap -- \
  --writers-stopped --from-key-ref key:previous --to-key-ref key:next \
  --target-key-file /private/rotation/payload-next --limit 500
```

Keep the deployment's existing Compose project name and environment-file options.
After `cutover_ready`, a trusted operator must replace only the payload-master
entry in the protected `app-secrets` volume's `runtime.env` and the deployment's
private host `.env`/secret source. Update the seed secret copy too if that profile
exists; never run seed against a persistent deployment. All copies must agree
before restart. Preserve every unrelated credential and volume. Re-running
bootstrap intentionally preserves existing secrets and **does not** perform this
cutover; configuration plan/apply excludes secrets as well. The command does not
mount secret volumes writable or silently alter deployment credential files.

Pending rotation refuses ordinary payload reads, writes and backup creation.
The recorded key check also refuses stale writers after cutover. Purge remains
available: replacement, ordinary write and purge use the same short filesystem
lease, so a deleted key is never reconstructed by resume. Busy operations fail
closed after five seconds; durable jobs retain their normal retry behavior.
This coordination is not permission to operate a live deployment during rotation.

### Interrupted process

A normal failure releases the lease; correct the reported error and repeat the
command. A killed process can leave a stale lease or encrypted staging file.
Same-host process death is recovered automatically only when the owner PID is
absent (or Linux process-start identity differs). Use unique host/container
hostnames, as the supplied Compose configuration does. A lease from a different
or unverifiable host is never automatically stolen.
After independently confirming that **every client, including the previous
rewrap process, is stopped**, repeat once with `--recover-stale-lock` added.
Recovery removes only the known lease/owner metadata and two known staging
files, not keys, objects or the checkpoint. It never expires or steals a live
lease automatically. Do not use this flag to bypass an active/busy command.

Each replacement is flushed to a temporary file and renamed before checkpoint
advance. Resume accepts an already-replaced wrapper at an unadvanced cursor.
The synthetic process-kill test covers that boundary and a waiting privacy purge;
it is not proof of power-loss behavior on every filesystem. Network filesystems,
uncoordinated direct edits and older binaries are outside this operation's scope.

## Backup custody and retirement

New backups include the non-secret `wrapping-key-state.json` and its manifest
checksum. Check/restore reject missing, mismatched or in-progress state. The
opaque manifest key alias must match the active state; key material remains
outside the bundle. Pre-rotation backups without the optional state checksum
remain readable with their original source revision and original key.

`cutover_ready` permits **live-store cutover only**. The tool never deletes secret
files and always reports `old_backup_key_custody_required: true`. Keep each old
key recoverable while any retained backup needs it, and until a matched restore
rehearsal and the deployment's retention policy permit retirement. A new key
cannot restore an old backup. Never copy an old key file back into a live payload
store to repair a purge; restore through the isolated, privacy-reapplying path.

## Evidence and implementation references

The existing payload-store tests cover legacy reads, bounded resume, wrong
identity/key refusal, target verification, unchanged ciphertext, process death
between replacement/checkpoint and competing purge. The existing backup gate
executes the CLI and restores both wrapper generations with privacy reapplication.
Real deployments, key custody and power-loss recovery remain operator work.

The implementation keeps AES-256-GCM and binds the wrapper version/key reference
through [Node authenticated additional data](https://nodejs.org/docs/latest-v22.x/api/crypto.html#ciphersetaadbuffer-options).
It uses the existing filesystem and [rename operation](https://nodejs.org/docs/latest-v22.x/api/fs.html#fsrenameoldpath-newpath-callback),
not a database transaction over external files. These primary API references
were checked on 2026-11-07.
