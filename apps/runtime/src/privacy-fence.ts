import type { Pool, PoolClient } from "pg";

const identifierPattern = /^[A-Za-z0-9._:-]{1,128}$/;
const digestPattern = /^[a-f0-9]{64}$/;

export type PrivacyProjectionScope = {
  readonly entryId: string;
  readonly tenantId: string;
  readonly appId: string;
  readonly subjectDigest?: string | null;
  readonly receivedAt: string;
};

export type PrivacyDeletionScope = {
  readonly tenantId: string;
  readonly appId: string;
  readonly deletionScope: "installation" | "app" | "tenant";
  readonly subjectDigest: string;
};

export type PrivacyProjectionFence = {
  readonly blockedEntryIds: ReadonlySet<string>;
  release(): Promise<void>;
};

function assertIdentifier(name: string, value: string): void {
  if (!identifierPattern.test(value)) throw new Error(`invalid ${name}: ${value}`);
}

function validateProjectionScope(scope: PrivacyProjectionScope): void {
  assertIdentifier("privacy fence entry identifier", scope.entryId);
  assertIdentifier("privacy fence tenant identifier", scope.tenantId);
  assertIdentifier("privacy fence app identifier", scope.appId);
  if (scope.subjectDigest && !digestPattern.test(scope.subjectDigest)) {
    throw new Error("privacy fence subject digest is invalid");
  }
  if (!Number.isFinite(Date.parse(scope.receivedAt))) {
    throw new Error("privacy fence received timestamp is invalid");
  }
}

function tenantLockKey(tenantId: string): string {
  return `openmasu:privacy-tenant:${tenantId}`;
}

function appLockKey(tenantId: string, appId: string): string {
  return `openmasu:privacy-app:${tenantId}:${appId}`;
}

function subjectLockKey(tenantId: string, appId: string, subjectDigest: string): string {
  // Keep the pre-existing key namespace so installation credential admission and
  // deletion recognition remain mutually exclusive across this upgrade.
  return `openmasu:privacy-subject:${tenantId}:${appId}:${subjectDigest}`;
}

async function xactLock(client: PoolClient, key: string, shared: boolean): Promise<void> {
  await client.query(
    `SELECT ${shared ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock"}(hashtextextended($1,0))`,
    [key],
  );
}

/**
 * Take the shared hierarchy used by one projection transaction. Deletion uses
 * exclusive locks at the scope it removes, so it either snapshots this write or
 * commits first and is observed by privacyProjectionIsBlocked().
 */
export async function acquirePrivacyProjectionXactFence(
  client: PoolClient,
  scope: PrivacyProjectionScope,
): Promise<void> {
  validateProjectionScope(scope);
  await xactLock(client, tenantLockKey(scope.tenantId), true);
  await xactLock(client, appLockKey(scope.tenantId, scope.appId), true);
  if (scope.subjectDigest) {
    await xactLock(client, subjectLockKey(scope.tenantId, scope.appId, scope.subjectDigest), true);
  }
}

/** Acquire parent locks in one global order before the exclusive deletion lock. */
export async function acquirePrivacyDeletionXactFence(
  client: PoolClient,
  scope: PrivacyDeletionScope,
): Promise<void> {
  assertIdentifier("privacy fence tenant identifier", scope.tenantId);
  assertIdentifier("privacy fence app identifier", scope.appId);
  if (!digestPattern.test(scope.subjectDigest)) throw new Error("privacy fence subject digest is invalid");
  await xactLock(client, tenantLockKey(scope.tenantId), scope.deletionScope !== "tenant");
  if (scope.deletionScope === "tenant") return;
  await xactLock(
    client,
    appLockKey(scope.tenantId, scope.appId),
    scope.deletionScope === "installation",
  );
  if (scope.deletionScope === "installation") {
    await xactLock(
      client,
      subjectLockKey(scope.tenantId, scope.appId, scope.subjectDigest),
      false,
    );
  }
}

/**
 * An installation deletion blocks the matching subject. App and tenant
 * deletions block only work received at or before their recognition boundary,
 * whether purge is still processing or complete; later lawful processing
 * remains possible.
 */
async function blockedProjectionEntryIds(
  client: PoolClient,
  scopes: readonly PrivacyProjectionScope[],
): Promise<Set<string>> {
  if (scopes.length === 0) return new Set();
  for (const scope of scopes) validateProjectionScope(scope);
  const tenantId = scopes[0].tenantId;
  if (scopes.some((scope) => scope.tenantId !== tenantId)) {
    throw new Error("privacy fence tenant scope mismatch");
  }
  const result = await client.query<{ entry_id: string }>(
    `WITH projection_scope AS (
       SELECT input.entry_id,input.app_id,input.subject_digest,input.received_at
         FROM jsonb_to_recordset($1::jsonb) AS input(
           entry_id text,app_id text,subject_digest text,received_at timestamptz
         )
     )
     SELECT scope.entry_id
       FROM projection_scope AS scope
      WHERE EXISTS (
       SELECT 1
         FROM control.privacy_deletion_jobs AS job
        WHERE job.tenant_id=$2 AND job.status='processing'
          AND (
            (scope.subject_digest IS NOT NULL AND job.app_id=scope.app_id
              AND job.artifact_template->>'deletion_scope'='installation'
              AND job.artifact_template->>'deletion_subject_digest'=scope.subject_digest)
            OR (
              control.canonical_timestamp_value(job.requested_at) >= scope.received_at
              AND (
                job.artifact_template->>'deletion_scope'='tenant'
                OR (job.app_id=scope.app_id AND job.artifact_template->>'deletion_scope'='app')
              )
            )
          )
       UNION ALL
       SELECT 1
         FROM ledger.privacy_requests AS request
        WHERE request.tenant_id=$2 AND request.status='completed'
          AND (
            (scope.subject_digest IS NOT NULL AND request.app_id=scope.app_id
              AND request.artifact->>'deletion_scope'='installation'
              AND request.artifact->>'deletion_subject_digest'=scope.subject_digest)
            OR (
              control.canonical_timestamp_value(request.requested_at) >= scope.received_at
              AND (
                request.artifact->>'deletion_scope'='tenant'
                OR (request.app_id=scope.app_id AND request.artifact->>'deletion_scope'='app')
              )
            )
          )
       LIMIT 1
     )
      ORDER BY scope.entry_id COLLATE "C"`,
    [JSON.stringify(scopes.map((scope) => ({
      entry_id: scope.entryId,
      app_id: scope.appId,
      subject_digest: scope.subjectDigest ?? null,
      received_at: scope.receivedAt,
    }))), tenantId],
  );
  return new Set(result.rows.map((row) => row.entry_id));
}

export async function privacyProjectionIsBlocked(
  client: PoolClient,
  scope: PrivacyProjectionScope,
): Promise<boolean> {
  return (await blockedProjectionEntryIds(client, [scope])).has(scope.entryId);
}

async function releaseSessionLocks(client: PoolClient, keys: readonly string[]): Promise<void> {
  for (const key of [...keys].reverse()) {
    await client.query("SELECT pg_advisory_unlock_shared(hashtextextended($1,0))", [key]);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("privacy fence cleanup failed");
}

/**
 * Hold shared session locks across the SDK evaluator, ledger writes, auxiliary
 * queue writes, and terminal inbox state. The state check runs only after every
 * lock is held, closing the decode-to-projection deletion race.
 */
export async function acquirePrivacyProjectionSessionFence(
  pool: Pool,
  tenantId: string,
  scopes: readonly PrivacyProjectionScope[],
): Promise<PrivacyProjectionFence> {
  assertIdentifier("privacy fence tenant identifier", tenantId);
  for (const scope of scopes) {
    validateProjectionScope(scope);
    if (scope.tenantId !== tenantId) throw new Error("privacy fence tenant scope mismatch");
  }
  const keys = [
    tenantLockKey(tenantId),
    ...[...new Set(scopes.map((scope) => appLockKey(tenantId, scope.appId)))].sort(),
    ...[...new Set(scopes.flatMap((scope) => scope.subjectDigest
      ? [subjectLockKey(tenantId, scope.appId, scope.subjectDigest)]
      : []))].sort(),
  ];
  const client = await pool.connect();
  const acquired: string[] = [];
  let transactionOpen = false;
  try {
    for (const key of keys) {
      await client.query("SELECT pg_advisory_lock_shared(hashtextextended($1,0))", [key]);
      acquired.push(key);
    }
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT set_config('openmasu.tenant_id', $1, true)", [tenantId]);
    const blocked = await blockedProjectionEntryIds(client, scopes);
    await client.query("COMMIT");
    transactionOpen = false;
    let released = false;
    return {
      blockedEntryIds: blocked,
      release: async () => {
        if (released) return;
        released = true;
        try {
          await releaseSessionLocks(client, acquired);
          client.release();
        } catch (error) {
          // A pooled connection with an unreleased session lock must never be
          // returned to the pool. Passing an error destroys that connection.
          client.release(asError(error));
          throw error;
        }
      },
    };
  } catch (error) {
    let cleanupError: unknown;
    if (transactionOpen) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) { cleanupError = rollbackError; }
    }
    try { await releaseSessionLocks(client, acquired); } catch (unlockError) { cleanupError ??= unlockError; }
    if (cleanupError) client.release(asError(cleanupError));
    else client.release();
    throw error;
  }
}
