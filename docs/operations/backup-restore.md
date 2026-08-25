# Backup, Restore, and Privacy Reapplication

This runbook covers the repository-supported PostgreSQL 17 custom-format
backup and restore path. It is not evidence that a particular deployment has a
working backup schedule, off-site storage, recovery objective, or external key
manager. Run the procedure first in an isolated environment with synthetic
data.

## Required backup set

A recoverable OpenMasu backup has three separately protected parts:

1. a PostgreSQL custom-format archive created while API, worker, redirector,
   import, and administrative writers are quiesced;
2. one consistent snapshot of the encrypted payload object and wrapped-key
   directories; and
3. the payload master key from the deployment's out-of-band secret manager.

The database archive contains the append-only privacy-request ledger. A backup
that predates a completed deletion request cannot prove that request existed.
Before serving a restored system, the operator must restore an authoritative
ledger that includes every completed request or choose a newer backup. The
public reapply command does not accept an unaudited side file and does not
invent missing requests.

## Create a backup

1. Stop or quiesce every writer. Confirm no import or privacy job is running.
2. Record the PostgreSQL major version, application commit, contract version,
   payload-store snapshot identifier, and backup time outside this public
   repository.
3. Create the database archive with PostgreSQL 17 tools:

   ```bash
   pg_dump --format=custom --no-owner --file openmasu.dump "$OPENMASU_MIGRATION_DATABASE_URL"
   ```

4. Snapshot both payload-store object and wrapped-key directories while they
   remain quiesced. Encrypt the snapshot and database archive at rest.
5. Store the payload master key separately. Never put it in the archive,
   repository, command history, or evidence report.
6. Resume writers only after all parts have a common recorded boundary.

## Restore into a new target

Never use `pg_restore --clean` against the live database. Treat dump contents
as trusted executable input and restore only a backup produced by the approved
deployment.

1. Provision the OpenMasu database roles in a new PostgreSQL 17 cluster. Create
   an empty destination database; do not point application traffic at it.
2. Restore the archive:

   ```bash
   pg_restore --exit-on-error --no-owner --dbname "$OPENMASU_MIGRATION_DATABASE_URL" openmasu.dump
   ```

3. Restore the matching encrypted object and wrapped-key snapshot. Configure
   the same out-of-band payload master key and application database role.
4. For each tenant present in the restored database, run:

   ```bash
   npm run db:reapply-privacy -- --tenant tenant-example
   ```

5. The command must exit zero and report `unsupported_metric_runs: 0`. A
   nonzero unsupported count is a hard stop: do not serve reports until the
   missing versioned replay input has been resolved through an approved newer
   backup or migration.
6. Verify that protected references affected by completed requests cannot be
   decrypted, completed artifacts contain no deletion subject, replacement
   metrics are the latest runs, old runs remain immutable, and one idempotent
   `privacy_reapply` audit row exists per request.
7. Repeat the command. Counts may describe the same requests, but it must not
   create another replacement or audit row.
8. Run schema, integration, reporting, and health checks before allowing
   traffic.

## Repository evidence

`npm run test:backup-restore` uses only synthetic fixture data. With
`OPENMASU_M5_BACKUP_RESTORE=1`, CI creates a PostgreSQL 17 custom archive,
restores it into a new disposable database, restores a synthetic encrypted
payload snapshot, reapplies completed privacy requests, and proves the payload
is unreadable and the recalculated latest export excludes redacted evidence.
The test does not prove storage durability, a recovery-time objective, or an
operator's credentials and access controls.

Primary references were checked on 2026-08-20:

- https://www.postgresql.org/docs/17/backup-dump.html
- https://www.postgresql.org/docs/17/app-pgrestore.html
