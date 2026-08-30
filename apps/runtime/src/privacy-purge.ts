import type { Pool } from "pg";
import { uuidV7, withTenant } from "./index.js";
import { PayloadNotFoundError, type PayloadStore } from "./payload-store.js";

type Any = Record<string, any>;

type PrivacyDeletionJob = {
  privacy_request_id: string;
  tenant_id: string;
  app_id: string;
  status: "processing" | "completed";
  completed_at: string | null;
  artifact_template: Any;
  actor_type: "admin_key" | "sdk_installation";
  actor_ref: string;
  request_digest: string;
};

type PayloadPurge = {
  reference_digest: string;
  payload_ref: string;
};

export type PrivacyPurgeRequestResult = {
  readonly state: "missing" | "busy" | "processing" | "completed";
  readonly purged: number;
  readonly artifact?: Any;
};

export type PrivacyPurgeCycleResult = {
  readonly jobs: number;
  readonly completed: number;
  readonly processing: number;
  readonly payloadsPurged: number;
};

function timestamp(now: (() => Date) | undefined): string {
  return (now?.() ?? new Date()).toISOString();
}

async function purgeAndVerify(payloadStore: PayloadStore, reference: string): Promise<void> {
  await payloadStore.purge(reference);
  try {
    await payloadStore.read(reference);
  } catch (error) {
    if (error instanceof PayloadNotFoundError) return;
    throw error;
  }
  throw new Error("privacy_payload_still_readable");
}

export async function processPrivacyDeletionRequest(input: {
  readonly pool: Pool;
  readonly payloadStore: PayloadStore;
  readonly tenantId: string;
  readonly privacyRequestId: string;
  readonly now?: () => Date;
}): Promise<PrivacyPurgeRequestResult> {
  const lockClient = await input.pool.connect();
  const lockKey = `openmasu:privacy-purge:${input.tenantId}:${input.privacyRequestId}`;
  let locked = false;
  try {
    const lock = await lockClient.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
      [lockKey],
    );
    if (!lock.rows[0]?.acquired) return { state: "busy", purged: 0 };
    locked = true;

    const job = await withTenant(input.pool, input.tenantId, async (client) => (await client.query<PrivacyDeletionJob>(
      `SELECT privacy_request_id,tenant_id,app_id,status,completed_at,artifact_template,
              actor_type,actor_ref,request_digest
         FROM control.privacy_deletion_jobs
        WHERE tenant_id=$1 AND privacy_request_id=$2`,
      [input.tenantId, input.privacyRequestId],
    )).rows[0]);
    if (!job) return { state: "missing", purged: 0 };
    if (job.status === "completed") {
      const artifact = await withTenant(input.pool, input.tenantId, async (client) => (await client.query<{ artifact: Any }>(
        "SELECT artifact FROM ledger.privacy_requests WHERE privacy_request_id=$1",
        [input.privacyRequestId],
      )).rows[0]?.artifact);
      if (!artifact) throw new Error("privacy_completed_artifact_missing");
      return { state: "completed", purged: 0, artifact };
    }

    const references = await withTenant(input.pool, input.tenantId, async (client) => (await client.query<PayloadPurge>(
      `SELECT reference_digest,payload_ref
         FROM control.privacy_payload_purges
        WHERE tenant_id=$1 AND privacy_request_id=$2 AND status='queued'
        ORDER BY reference_digest`,
      [input.tenantId, input.privacyRequestId],
    )).rows);
    let purged = 0;
    for (const reference of references) {
      const changedAt = timestamp(input.now);
      try {
        await purgeAndVerify(input.payloadStore, reference.payload_ref);
      } catch {
        await withTenant(input.pool, input.tenantId, async (client) => {
          await client.query(
            `UPDATE control.privacy_payload_purges
                SET attempts=attempts+1,last_error_code='payload_purge_failed',updated_at=$4
              WHERE tenant_id=$1 AND privacy_request_id=$2 AND reference_digest=$3 AND status='queued'`,
            [input.tenantId, input.privacyRequestId, reference.reference_digest, changedAt],
          );
        });
        return { state: "processing", purged };
      }
      await withTenant(input.pool, input.tenantId, async (client) => {
        await client.query(
          `UPDATE control.privacy_payload_purges
              SET status='purged',attempts=attempts+1,last_error_code=NULL,updated_at=$4
            WHERE tenant_id=$1 AND privacy_request_id=$2 AND reference_digest=$3 AND status='queued'`,
          [input.tenantId, input.privacyRequestId, reference.reference_digest, changedAt],
        );
      });
      purged += 1;
    }

    const completedAt = timestamp(input.now);
    const artifact = await withTenant(input.pool, input.tenantId, async (client) => {
      const current = (await client.query<PrivacyDeletionJob>(
        `SELECT privacy_request_id,tenant_id,app_id,status,completed_at,artifact_template,
                actor_type,actor_ref,request_digest
           FROM control.privacy_deletion_jobs
          WHERE tenant_id=$1 AND privacy_request_id=$2 FOR UPDATE`,
        [input.tenantId, input.privacyRequestId],
      )).rows[0];
      if (!current) throw new Error("privacy_deletion_job_missing");
      if (current.status === "completed") {
        const existing = (await client.query<{ artifact: Any }>(
          "SELECT artifact FROM ledger.privacy_requests WHERE privacy_request_id=$1",
          [input.privacyRequestId],
        )).rows[0]?.artifact;
        if (!existing) throw new Error("privacy_completed_artifact_missing");
        return existing;
      }
      const outstanding = Number((await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM control.privacy_payload_purges
          WHERE tenant_id=$1 AND privacy_request_id=$2 AND status<>'purged'`,
        [input.tenantId, input.privacyRequestId],
      )).rows[0]?.count ?? "0");
      if (outstanding !== 0) return undefined;
      const completedArtifact = {
        ...current.artifact_template,
        status: "completed",
        completed_at: completedAt,
      };
      await client.query(
        `INSERT INTO ledger.privacy_requests (
          privacy_request_id,tenant_id,app_id,requested_at,completed_at,status,artifact
        ) VALUES ($1,$2,$3,$4,$5,'completed',$6::jsonb)`,
        [current.privacy_request_id, current.tenant_id, current.app_id,
          String(current.artifact_template.requested_at), completedAt, JSON.stringify(completedArtifact)],
      );
      await client.query(
        `UPDATE control.privacy_deletion_jobs
            SET status='completed',completed_at=$3,updated_at=$3
          WHERE tenant_id=$1 AND privacy_request_id=$2 AND status='processing'`,
        [input.tenantId, input.privacyRequestId, completedAt],
      );
      await client.query(
        `INSERT INTO ledger.audit_logs (
          audit_log_id,tenant_id,app_id,occurred_at,actor_type,actor_ref,
          action,target_scope,target_ref,policy_version,request_digest,outcome,reason_code
        ) VALUES ($1,$2,$3,$4,$5,$6,'privacy_delete','privacy_request',$7,
          'privacy-v0.3',$8,'succeeded',NULL)`,
        [uuidV7(Date.parse(completedAt)), current.tenant_id, current.app_id, completedAt,
          current.actor_type, current.actor_ref, current.privacy_request_id, current.request_digest],
      );
      return completedArtifact;
    });
    return artifact
      ? { state: "completed", purged, artifact }
      : { state: "processing", purged };
  } finally {
    if (locked) {
      try { await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]); }
      catch { /* connection release also frees the session lock */ }
    }
    lockClient.release();
  }
}

export async function processPrivacyDeletionJobs(input: {
  readonly pool: Pool;
  readonly payloadStore: PayloadStore;
  readonly tenantId: string;
  readonly maximumJobs?: number;
  readonly now?: () => Date;
}): Promise<PrivacyPurgeCycleResult> {
  const maximumJobs = input.maximumJobs ?? 100;
  if (!Number.isSafeInteger(maximumJobs) || maximumJobs < 1 || maximumJobs > 1_000) {
    throw new Error("privacy purge maximum jobs must be from 1 through 1000");
  }
  const requestIds = await withTenant(input.pool, input.tenantId, async (client) => (await client.query<{
    privacy_request_id: string;
  }>(
    `SELECT privacy_request_id FROM control.privacy_deletion_jobs
      WHERE tenant_id=$1 AND status='processing'
      ORDER BY requested_at,privacy_request_id LIMIT $2`,
    [input.tenantId, maximumJobs],
  )).rows.map((row) => row.privacy_request_id));
  let completed = 0;
  let processing = 0;
  let payloadsPurged = 0;
  for (const privacyRequestId of requestIds) {
    const result = await processPrivacyDeletionRequest({
      pool: input.pool,
      payloadStore: input.payloadStore,
      tenantId: input.tenantId,
      privacyRequestId,
      now: input.now,
    });
    payloadsPurged += result.purged;
    if (result.state === "completed") completed += 1;
    else processing += 1;
  }
  return { jobs: requestIds.length, completed, processing, payloadsPurged };
}
