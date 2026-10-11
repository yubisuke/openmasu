# Backup, Restore, and Privacy Reapplication

Use the existing CLI and native PostgreSQL 17 `pg_dump` / `pg_restore` tools.
No backup service or second deployment stack is required. This is a stopped-writer,
same-source-revision recovery path, not evidence of a live backup schedule,
off-site durability or a recovery-time objective. Rehearse with synthetic data first.
The frozen `v0.2.0` forward-upgrade path remains in [Safe upgrade](upgrade.md);
its backup declaration and version limits are separate from this current-source CLI.

## Preconditions and custody

- Run from the repository root at the exact clean source revision used for the
  backup, with the pinned Node/npm versions and installed dependencies. Check and
  restore reject a different revision or migration inventory. Use PostgreSQL 17
  server and client tools; provision the existing OpenMasu roles on a new cluster.
- Create, boundary capture and restore require the private
  `OPENMASU_MIGRATION_DATABASE_URL` for a privileged superuser, never an application,
  reader or seed connection. Load it through the operator's protected environment,
  not a command argument, log or public example. Check needs neither DB access nor
  the master key.
- For create, explicitly set `OPENMASU_PAYLOAD_STORE_DIR` to the live payload root.
  For create and restore, supply the matching master key through the existing
  secret store; prefer `OPENMASU_PAYLOAD_MASTER_KEY_FILE`. The existing
  `OPENMASU_PAYLOAD_MASTER_KEY` environment-value mechanism also works. Keep the
  master key outside the backup bundle and independently recoverable.
- Use new private destinations outside the repository, with existing protected
  parent directories. Existing output paths are rejected, not overwritten.
  Restrict OS ACLs, including on Windows; filesystem mode requests alone are not
  an ACL audit. Protect the source payload root and temporary directory too.

Example non-secret path configuration, after the privileged connection has been
loaded privately:

```bash
export OPENMASU_PAYLOAD_STORE_DIR=/private/openmasu-payloads
export OPENMASU_PAYLOAD_MASTER_KEY_FILE=/private/secrets/payload-master-key
```

The database dump, encrypted objects and wrapped keys are one matched backup set.
The manifest records their hashes, source/migration identity, times, privacy
boundary and an opaque master-key alias/check. `--master-key-ref` is an alias such
as `key:operator-reference`, never a key value, subject, credential or private path.
Hashes detect mismatches; the manifest and boundary are trusted operator inputs,
not cryptographic signatures or proof of custody. A dump is executable input:
restore only archives from a trusted source. See PostgreSQL's
[dump warning](https://www.postgresql.org/docs/17/app-pgdump.html).

## Create and check a backup

1. Stop every writer: API, worker, redirector, imports, metric jobs, privacy intake,
   scheduled tasks and all CLI/administrator sessions. Prevent new writers from
   starting until capture and check finish. Keep PostgreSQL running; wait for
   in-flight work to stop. Idle DB sessions also cause create to refuse.
2. Create a new bundle. The acknowledgment does not stop services for you:

   ```bash
   npm run backup:create -- --writers-stopped --output /private/backups/backup-example --master-key-ref key:operator-reference
   ```

   The command rejects other client DB sessions, locks application tables against
   writes while dumping/copying, checks that objects and wrapped keys did not
   change, and verifies wrapped keys against the supplied master key. Success
   reports `backup_complete: true`. Only a complete attempt gets
   `manifest.json`; an interrupted/partial directory is not a usable backup.
3. Capture a separate, fresh privacy boundary from the authoritative source DB,
   still with every writer stopped:

   ```bash
   npm run backup:boundary -- --writers-stopped --output /private/boundaries/boundary-example.json
   ```

   This is a read-only consistent DB capture, not a copied declaration from the
   backup. It writes a new private file outside the repository. Keep it separate
   from the bundle; it records hashes/counts for all recognized deletion requests
   and the tenant set, including requests still processing.
4. Check the matched set:

   ```bash
   npm run backup:check -- --directory /private/backups/backup-example --boundary /private/boundaries/boundary-example.json --maximum-age-hours 24
   ```

   Require exit zero and `backup_valid: true`. This checks manifest identity,
   migration inventory, dump/object/key hashes, backup age and the supplied
   authoritative privacy boundary. It neither connects to a DB nor reads the
   master key, so it is not a restore rehearsal or key-recoverability test.
5. Resume writers only when the operator's stop/restart conditions are satisfied.
   Keep a private receipt and protect/copy the entire bundle using existing
   operator storage controls. Do not publish paths, manifests or private records.

Check and restore default to a maximum backup age of 24 hours. Set a positive
`--maximum-age-hours` explicitly for the deployment's recovery policy. The separate
boundary must always be no more than 15 minutes old, not future-dated and no older
than the backup; there is no CLI override for that limit. A fresh boundary is
needed for every later check or restore. A previously green check does not prove
that a backup includes deletion requests recognized afterwards.

## Schedule with existing operator tools

For example, an existing cron installation can invoke a private wrapper twice
daily. The interval and the 24-hour policy are examples, not deployment defaults:

```cron
0 */12 * * * /private/openmasu-backup.sh >> /private/openmasu-backup.log 2>&1
```

The operator-owned wrapper must serialize runs, load protected configuration,
choose new bundle/boundary paths, then perform the five steps above: stop and
confirm **all** writers, create, capture the fresh source boundary, check, and
restart only if the checks and deployment-specific restart conditions permit it.
For the existing Compose layout, stopping `worker api redirector` is only part of
that stop: external jobs, CLI and administrator writers must also be stopped.
Do not use an unconditional restart-on-exit trap. Preserve failure exit codes and
notify through existing private monitoring; do not embed credentials in cron.

The operator still owns cadence, maximum age, retention/deletion policy, encryption
at rest, off-site copies, storage capacity, key/backup ACLs, alert delivery and
periodic restore drills. The CLI neither uploads nor expires backups.

## Restore into a new target

Never restore over the live database or use `pg_restore --clean` against it.
Keep traffic and privacy intake stopped throughout restoration and cutover.

1. From the authoritative source DB, capture a **new** boundary using
   `backup:boundary` as above after stopping all writers. Use the source that
   includes every recognized deletion, not the candidate backup or a DB restored
   from it. Then load the target cluster's privileged connection privately.
2. Use the same clean source revision, trusted bundle, fresh boundary, matching
   master key and alias. The new payload directory must not exist:

   ```bash
   npm run backup:restore -- --privacy-intake-stopped --directory /private/backups/backup-example --boundary /private/boundaries/restore-boundary-example.json --payload-output /private/restored-payloads-example --master-key-ref key:operator-reference --maximum-age-hours 24
   ```

3. The CLI checks the bundle and key, creates a fresh random `openmasu_restore_*`
   database owned by `openmasu_owner` from `template0`, and sets `CONNECTION LIMIT 0`.
   It restores via privileged `pg_restore --exit-on-error` without `--no-owner`
   or `--role`, retaining original ownership for subsequent migrations and FORCE
   RLS behavior. Do not weaken RLS or grant application roles superuser/BYPASSRLS.
   PostgreSQL connection limits do not block superusers or background workers;
   the operator must control those separately. See
   [restore ownership](https://www.postgresql.org/docs/17/app-pgrestore.html) and
   [database connection limits](https://www.postgresql.org/docs/17/sql-createdatabase.html).
4. The CLI copies both payload directories, verifies the restored schema/privacy
   boundary, drains processing deletion jobs and reapplies completed requests for
   **every tenant**. Unsupported replay inputs or any remaining incomplete privacy
   work stop promotion. Saved grouping, watermark, definition and FX inputs remain
   authoritative; unavailable inputs never become copied historical numbers.
5. It rechecks integrity and the external boundary before lifting the connection
   limit. Require exit zero and `ready: true`; `traffic_restart: "manual"` means
   no traffic, connection configuration or service stack has been switched.
   Run schema, role/isolation, reporting and health checks, verify deleted payloads
   remain unreadable and latest reports exclude redacted evidence, then explicitly
   approve any private cutover. Continue to keep privacy intake stopped until the
   authoritative state and serving target are safely aligned.

If the boundary expires during restore, capture a new authoritative boundary and
retry into another new target; do not extend the timestamp or bypass the check.
A backup missing a later-recognized request is rejected even when its files match.
Choose a newer complete backup. An older backup cannot prove an absent deletion
request existed; if the authoritative source has been lost and no current trusted
boundary is available, this procedure cannot prove the full recognized set and
must not reopen traffic. Public drain/reapply commands do not import missing
requests from an unaudited side file.

On failure keep the target blocked and traffic stopped. The private
`restore-state.json` in the new payload directory records the generated database
and restore phase for diagnosis; `privacy_applied: true` alone does not prove
the connection limit was lifted or traffic was switched. The CLI does not delete
a failed database or payload directory automatically. Inspect the exact private
targets and authorize cleanup separately; never delete the source or backup to
clear an error.

## Manual privacy steps for the frozen upgrade path

[Safe upgrade](upgrade.md) retains its separate `v0.2.0` backup declaration and
forward-migration procedure; the current-source CLI is not a cross-version
restore adapter. For each tenant on that isolated path, run:

```bash
npm run db:drain-privacy-purge -- --tenant tenant-example
npm run db:reapply-privacy -- --tenant tenant-example
```

Require `drained: true`, exit zero and `unsupported_metric_runs: 0`. Repeat both
commands to verify idempotency: no duplicate replacement metric or `privacy_reapply`
audit row. Confirm no processing deletion jobs remain, affected payloads cannot
be decrypted, completed artifacts contain no deletion subject, latest metrics
are recalculated and old runs remain immutable. Historical report watermarks do
not bypass deletion withdrawal. Stalled purge or unsupported replay is a hard stop.

## Repository evidence

`npm run test:backup-restore`, with `OPENMASU_M5_BACKUP_RESTORE=1`, owns synthetic
PostgreSQL 17 dump/restore and privacy reapplication checks. The new CLI workflow
extends that suite with manifest/freshness, incomplete/mismatched backup,
recognized-request boundary, blocked-target and key checks. Runtime CI is the
authoritative PostgreSQL evidence for these additions. The existing frozen
upgrade rehearsal remains in the same suite. A skipped opt-in gate is not a pass.
No repository check proves production durability, custody, recovery time or a
working operator schedule.

PostgreSQL 17 primary references checked on 2026-10-11:

- [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)
- [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)
- [CREATE DATABASE](https://www.postgresql.org/docs/17/sql-createdatabase.html)
- [libpq environment variables](https://www.postgresql.org/docs/17/libpq-envars.html)

The CLI uses a temporary private password file for native tool invocation rather
than putting the password in its argument list. Its source environment and the
temporary directory still require operator access controls.
