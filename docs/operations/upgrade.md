# Upgrade without losing evidence

The supported source is published `v0.2.0` at
`68b8c483a30c3804a216a655d964788d0204185f`, PostgreSQL 17, with 48 migrations.
The next supported target is the configured `v0.3.0-rc.1` source candidate,
**only after its annotated tag and exact-commit full CI evidence are published**.
This path is a stopped-writer upgrade, not zero-downtime deployment.

## One ordered procedure

1. Record the source tag/commit and all tenant IDs privately. Stop API, worker,
   redirector, import, metric and administrator writers. Do not run seed, reset,
   `down --volumes`, or a down migration. Keep traffic stopped on any error.
2. Follow [Backup and restore](backup-restore.md): create a PostgreSQL 17 custom
   archive and an archive of **both** encrypted objects and wrapped-key directories
   at the same stopped boundary. Preserve the matching master key out of band.
   The database must include every recognized privacy request, including durable
   processing jobs; an older backup cannot substitute for that authoritative state.
3. Record this closed JSON declaration **outside the public repository**. Replace
   placeholder digests with SHA-256 of the actual private files. Snapshot/key
   references are opaque labels, never keys, paths, credentials or subjects.

   ```json
   {
     "format": "openmasu-upgrade-backup-v1",
     "source_tag": "v0.2.0",
     "source_revision": "68b8c483a30c3804a216a655d964788d0204185f",
     "postgres_major": 17,
     "migration_digest": "d4c18ba078913cfefa420ea6adfcf3d7386994a614f3b197e6222276bc4905c6",
     "database_sha256": "<64 lowercase hex characters>",
     "payload_sha256": "<64 lowercase hex characters>",
     "payload_snapshot_id": "snapshot:operator-boundary",
     "master_key_ref": "key:operator-reference",
     "privacy_boundary_at": "2026-10-02T00:00:00.000Z"
   }
   ```

   The migration digest hashes compact JSON of ordered `{version,name,checksum}`
   rows for the frozen 48 files (LF-normalized SQL SHA-256). The preflight verifies
   archive bytes, source identity, PostgreSQL major and a contiguous migration
   prefix. The snapshot label/time/key reference are an operator declaration,
   **not proof** of backup completeness, authenticity or correct secret custody.
4. Check out the target annotated tag in a clean checkout, use the pinned tool
   versions, run `npm ci`, and provision the existing private migration connection.
   Run the read-only preflight before any role/DDL change:

   ```bash
   npm run db:upgrade:preflight -- --from=v0.2.0 --to=v0.3.0-rc.1 --backup=/private/upgrade.json --database-backup=/private/openmasu.dump --payload-backup=/private/payloads.tar
   ```

   Exit zero and `status: ready` are required. Output is aggregate-only and includes
   the target and applied/pending counts, not backup contents, key labels or paths.
   Unknown versions, dirty/wrong target, major mismatch, gaps, altered SQL, extra
   migrations and checksum mismatches refuse with exit 2. Database reads use a
   read-only transaction and a five-second statement timeout.
5. Run `npm run db:migrate`, then rerun preflight: pending must be zero. The existing
   advisory lock and per-file transaction remain authoritative. Migration checksum
   validation now occurs before roles are changed. A failed file rolls back its DDL
   and migration record; already committed earlier files remain. Repair the cause,
   rerun preflight, and rerun the same migration command—never delete its metadata.
6. Run `npm run db:schema:check`, role/invariant checks and health checks. For **each
   tenant**, drain pending privacy purge and reapply completed requests using the
   existing backup runbook. Require `drained: true`, exit zero and
   `unsupported_metric_runs: 0`; repeat for idempotency. Legacy metric meaning is
   left unknown, not reconstructed from current definitions. Affected legacy runs
   without replay inputs remain a hard operational stop.
7. Check preserved ledger/run counts and recorded artifact digests, unreadable
   deleted payloads, immutable history and reader isolation. Only then restart
   writers/traffic **manually**. Record elapsed/stopped time and environment privately.

## Recovery, not destructive rollback

On failure leave traffic stopped. Continue the same checksummed forward migration,
or restore the complete matched backup into a **new isolated PostgreSQL 17 target**.
Provision roles and create the new database with `OWNER openmasu_owner`. Restore
through the privileged bootstrap/admin connection using `pg_restore --exit-on-error`
without `--no-owner` or `--role`: this retains the archive's original object owners
for subsequent forward DDL, while COPY runs with the privilege needed for FORCE RLS
tables. PostgreSQL custom-format dumps retain ownership metadata even when
`pg_dump --no-owner` was supplied. The destination's database owner also permits
creation in the default `public` schema; a database-level CREATE grant alone does
not. Do not weaken RLS or grant BYPASSRLS to application roles. Never restore over the live DB.
Drain/reapply recognized privacy state before reports or traffic. An earlier app
may be used only if its schema compatibility is established; no automatic rollback,
table deletion or resurrection of deleted payloads is provided.

## Synthetic evidence

One version-to-version case extends `npm run test:backup-restore` (PostgreSQL 17
tools enabled in existing Runtime CI). It loads the exact frozen tag's 48 SQL files,
inserts reviewed synthetic ledger/metric artifacts using only old columns, dumps
and restores to a separate DB, checks the backup hashes, injects failure during
migration 050, verifies rollback, resumes through the target, and reapplies deletion
to a restored encrypted payload snapshot. The unrelated historical metric/ledger
remain byte-identical; new comparison context stays NULL. JSON output records elapsed
time and the isolated absent-writer boundary. No real recovery time, production
durability, zero downtime or backup schedule is established by this test.

Ownership behavior checked against PostgreSQL 17 primary documentation on 2026-10-02:

- https://www.postgresql.org/docs/17/app-pgdump.html
- https://www.postgresql.org/docs/17/app-pgrestore.html
