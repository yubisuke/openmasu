import type { Pool, PoolClient } from "pg";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { withTenant, uuidV7 } from "./index.js";
import { acquirePrivacyTenantSessionReadFence, acquirePrivacyTenantXactFence } from "./privacy-fence.js";
import { PayloadNotFoundError, type PayloadStore } from "./payload-store.js";

type Scope = { tenantId: string; appId: string };
export type RetentionPolicy = {
  version: 1; enabled: boolean; as_of: string;
  layers: { protected_payload?: { keep_days: number }; expired_request_nonces?: { grace_seconds: number } };
};
type Candidate = { layer: keyof RetentionPolicy["layers"]; target: Record<string, unknown> };
type Plan = { candidates: Candidate[]; dependentRuns: number; unboundRuns: number; moreCandidates: boolean; receipt: string };
type Item = Candidate & { ordinal: number; state: "pending" | "invalidated" };
const maximumCandidates = 1000;
const identifier = /^[A-Za-z0-9._:-]{1,128}$/;
const invalid = (): never => { throw new Error("retention_policy_invalid"); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function keys(v: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(v).some(k => !allowed.includes(k))) invalid();
}

export function parseRetentionPolicy(value: unknown, now = new Date()): RetentionPolicy {
  if (!object(value)) return invalid();
  keys(value, ["version", "enabled", "as_of", "layers"]);
  if (value.version !== 1 || typeof value.enabled !== "boolean" || typeof value.as_of !== "string"
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.as_of)
    || !Number.isFinite(Date.parse(value.as_of)) || new Date(value.as_of).toISOString() !== value.as_of
    || Date.parse(value.as_of) > now.valueOf() || !object(value.layers)) return invalid();
  keys(value.layers, ["protected_payload", "expired_request_nonces"]);
  const layers: RetentionPolicy["layers"] = {};
  for (const [name, field, maximum] of [["protected_payload", "keep_days", 36500], ["expired_request_nonces", "grace_seconds", 31536000]] as const) {
    const layer = value.layers[name];
    if (layer === undefined) continue;
    if (!object(layer)) return invalid(); keys(layer, [field]);
    const amount = layer[field];
    if (!Number.isSafeInteger(amount) || (amount as number) < (field === "keep_days" ? 1 : 0) || (amount as number) > maximum) return invalid();
    if (name === "protected_payload") layers[name] = { keep_days: amount as number };
    else layers[name] = { grace_seconds: amount as number };
  }
  if (!Object.keys(layers).length) return invalid();
  return { version: 1, enabled: value.enabled, as_of: value.as_of, layers };
}
function scopeValues(scope: Scope): [string, string] {
  if (!identifier.test(scope.tenantId) || !identifier.test(scope.appId)) throw new Error("retention_scope_invalid");
  return [scope.tenantId, scope.appId];
}
function cutoff(policy: RetentionPolicy, milliseconds: number): string {
  return new Date(Date.parse(policy.as_of) - milliseconds).toISOString();
}
async function payloadCandidates(client: PoolClient, scope: Scope, policy: RetentionPolicy, reference?: string): Promise<Candidate[]> {
  if (!policy.enabled || !policy.layers.protected_payload) return [];
  const rows = await client.query<{ target: Candidate["target"] }>(`WITH objects AS (
    SELECT 'ingest_batch' AS source_kind,batch.ingest_batch_id::text AS source_id,batch.body_ref AS payload_ref,
      batch.received_at,batch.body_digest AS source_digest,
      ARRAY(SELECT member.record_id FROM ledger.ingest_batch_records AS member WHERE member.tenant_id=$1
        AND member.app_id=$2 AND member.ingest_batch_id=batch.ingest_batch_id ORDER BY member.record_id COLLATE "C") AS record_ids
    FROM ledger.ingest_batches_current AS batch WHERE batch.tenant_id=$1 AND batch.app_id=$2 AND batch.status='processed'
      AND batch.reason_code IS DISTINCT FROM 'post_processing_pending' AND batch.received_at<$3
    UNION ALL
    SELECT 'max_inbox',inbox.inbox_id::text,inbox.raw_query_ref,inbox.received_at,inbox.raw_query_digest,
      ARRAY(SELECT raw.record_id FROM ledger.raw_records AS raw WHERE raw.tenant_id=$1 AND raw.app_id=$2
        AND raw.record_id='record:max:'||inbox.inbox_id::text)
    FROM ledger.ingest_inbox_current AS inbox WHERE inbox.tenant_id=$1 AND inbox.app_id=$2 AND inbox.status='processed' AND inbox.received_at<$3
    UNION ALL
    SELECT 'raw_record',min(raw.record_id),raw.raw_payload_ref,max(raw.received_at),min(raw.payload_sha256),
      array_agg(raw.record_id ORDER BY raw.record_id COLLATE "C")
    FROM ledger.raw_records_current AS raw WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.raw_payload_ref LIKE 'encrypted:%'
      AND NOT EXISTS (SELECT 1 FROM ledger.ingest_batches AS batch WHERE batch.tenant_id=$1 AND batch.body_ref=raw.raw_payload_ref)
      AND NOT EXISTS (SELECT 1 FROM ledger.ingest_inbox AS inbox WHERE inbox.tenant_id=$1 AND inbox.raw_query_ref=raw.raw_payload_ref)
    GROUP BY raw.raw_payload_ref HAVING max(raw.received_at)<$3
  ) SELECT jsonb_build_object('source_kind',source_kind,'source_id',source_id,'payload_ref',payload_ref,
      'received_at',received_at,'source_digest',source_digest,'record_ids',record_ids) AS target
    FROM objects WHERE payload_ref LIKE 'encrypted:%' AND ($4::text IS NULL OR payload_ref=$4)
      AND NOT EXISTS (SELECT 1 FROM ledger.raw_records AS shared WHERE shared.tenant_id=$1
        AND shared.raw_payload_ref=objects.payload_ref AND (shared.app_id<>$2 OR shared.received_at>=$3))
      AND NOT EXISTS (SELECT 1 FROM ledger.ingest_batches AS shared WHERE shared.tenant_id=$1 AND shared.body_ref=objects.payload_ref AND shared.app_id<>$2)
      AND NOT EXISTS (SELECT 1 FROM ledger.ingest_inbox AS shared WHERE shared.tenant_id=$1 AND shared.raw_query_ref=objects.payload_ref AND shared.app_id<>$2)
      AND NOT EXISTS (SELECT 1 FROM ledger.raw_records AS member WHERE member.tenant_id=$1 AND member.app_id=$2
        AND member.record_id=ANY(objects.record_ids) AND member.received_at>=$3)
      AND NOT EXISTS (SELECT 1 FROM ephemeral.adservices_lookups AS work WHERE work.tenant_id=$1 AND work.token_ref=objects.payload_ref)
      AND NOT EXISTS (SELECT 1 FROM ephemeral.integrity_verifications AS work WHERE work.tenant_id=$1
        AND work.token_ref IN (objects.payload_ref,'protected:'||objects.payload_ref))
      AND NOT EXISTS (SELECT 1 FROM ephemeral.google_play_product_verifications AS work WHERE work.tenant_id=$1 AND work.token_ref=objects.payload_ref)
      AND NOT EXISTS (SELECT 1 FROM control.retention_items AS expired WHERE expired.tenant_id=$1 AND expired.app_id=$2
        AND expired.layer='protected_payload' AND expired.target->>'payload_ref'=objects.payload_ref AND expired.state IN ('invalidated','completed'))
    ORDER BY payload_ref COLLATE "C",source_kind,source_id LIMIT 1001`,
  [...scopeValues(scope),cutoff(policy,policy.layers.protected_payload.keep_days*86400000),reference ?? null]);
  return rows.rows.map(row=>({layer:"protected_payload",target:row.target}));
}
async function selection(client: PoolClient, scope: Scope, policy: RetentionPolicy): Promise<Plan> {
  let candidates = await payloadCandidates(client,scope,policy);
  const values = scopeValues(scope);
  if (policy.enabled && policy.layers.expired_request_nonces) {
    const rows = await client.query<{ target: Candidate["target"] }>(`SELECT jsonb_build_object('principal_type',principal_type,
      'principal_key_id',principal_key_id,'nonce_digest',encode(sha256(convert_to(nonce.nonce,'UTF8')),'hex'),
      'row_digest',encode(sha256(convert_to(to_jsonb(nonce.*)::text,'UTF8')),'hex')) AS target FROM ephemeral.request_nonces AS nonce
      WHERE tenant_id=$1 AND app_id=$2 AND expires_at<$3::timestamptz
      ORDER BY principal_type COLLATE "C",principal_key_id COLLATE "C",nonce COLLATE "C" LIMIT 1001`, [...values, cutoff(policy, policy.layers.expired_request_nonces.grace_seconds * 1000)]);
    candidates.push(...rows.rows.map(row => ({ layer: "expired_request_nonces" as const, target: row.target })));
  }
  const moreCandidates = candidates.length > maximumCandidates;
  candidates = candidates.slice(0,maximumCandidates);
  const recordIds = candidates.filter(c => c.layer === "protected_payload").flatMap(c => c.target.record_ids as string[]);
  const impact = recordIds.length ? (await client.query<{ dependent: number; unbound: number }>(`SELECT
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(run.artifact->'evidence_refs','[]'::jsonb)) AS ref
      WHERE ref->>'ref'=ANY($3::text[])))::int AS dependent,
    count(*) FILTER (WHERE jsonb_array_length(coalesce(run.artifact->'evidence_refs','[]'::jsonb))=0
      AND NOT EXISTS (SELECT 1 FROM control.metric_replay_manifests AS manifest WHERE manifest.tenant_id=run.tenant_id
        AND manifest.app_id=run.app_id AND manifest.source_metric_run_id=run.metric_run_id))::int AS unbound
    FROM ledger.metric_runs AS run WHERE run.tenant_id=$1 AND run.app_id=$2`, [...values, recordIds])).rows[0] : { dependent: 0, unbound: 0 };
  return { candidates, dependentRuns: impact.dependent, unboundRuns: impact.unbound, moreCandidates,
    receipt: sha256({ scope, policy, candidates, dependent_runs: impact.dependent, unbound_runs: impact.unbound, more_candidates:moreCandidates }) };
}
function publicPlan(plan: Plan, policy: RetentionPolicy) {
  return { format: "openmasu-retention-v1", enabled: policy.enabled, receipt: plan.receipt,
    candidates: plan.candidates.length, has_more_candidates:plan.moreCandidates, layers: { protected_payload: plan.candidates.filter(c => c.layer === "protected_payload").length,
      expired_request_nonces: plan.candidates.filter(c => c.layer === "expired_request_nonces").length },
    dependent_runs: plan.dependentRuns, unbound_runs: plan.unboundRuns,
    reproducibility_impact: plan.unboundRuns > 0 ? "unknown" : plan.dependentRuns > 0 ? "retention_affected" : "none_recorded",
    blocked: plan.unboundRuns > 0, writes: false };
}

async function snapshot<T>(pool: Pool, scope: Scope, readOnly: boolean, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let releaseFence: (() => Promise<void>) | undefined, begun = false;
  try {
    await client.query("SET statement_timeout='10s'");
    releaseFence = await acquirePrivacyTenantSessionReadFence(client, scopeValues(scope)[0]);
    await client.query(`BEGIN ISOLATION LEVEL REPEATABLE READ${readOnly ? " READ ONLY" : ""}`); begun = true;
    await client.query("SELECT set_config('openmasu.tenant_id',$1,true)", [scope.tenantId]);
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const result = await action(client);
    await client.query("COMMIT"); begun = false;
    return result;
  } finally {
    try { if (begun) await client.query("ROLLBACK"); }
    finally {
      try { await releaseFence?.(); await client.query("RESET statement_timeout"); }
      finally { client.release(); }
    }
  }
}

/** No receipt, job, audit, logical state or file is written by preview. */
export async function previewRetention(pool: Pool, scope: Scope, value: unknown, now = new Date()) {
  const policy = parseRetentionPolicy(value, now);
  return snapshot(pool, scope, true, async client => publicPlan(await selection(client, scope, policy), policy));
}

async function audit(client: PoolClient, scope: Scope, receipt: string, now: string, actorRef?: string): Promise<void> {
  await client.query(`INSERT INTO ledger.audit_logs (audit_log_id,tenant_id,app_id,occurred_at,actor_type,actor_ref,
    action,target_scope,target_ref,policy_version,request_digest,outcome)
    VALUES ($1,$2,$3,$4,$6,$7,'retention_expiry_started','app',$3,'retention-v1',$5,'succeeded')`,
  [uuidV7(), ...scopeValues(scope), now, receipt,actorRef ? "admin_key" : "system_job",actorRef ?? "job:retention_expiry"]);
}

export async function applyRetention(input: { pool: Pool; payloadStore: PayloadStore; scope: Scope; policy: unknown;
  receipt: string; maximumItems?: number; now?: () => Date; actorRef?: string }) {
  const now = () => (input.now?.() ?? new Date()).toISOString();
  const policy = parseRetentionPolicy(input.policy, new Date(now()));
  const maximum = input.maximumItems ?? 20, scope = input.scope, values = scopeValues(scope);
  if (!policy.enabled) throw new Error("retention_disabled");
  if (!/^[a-f0-9]{64}$/.test(input.receipt) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100) throw new Error("retention_arguments_invalid");
  const lock = await input.pool.connect(), lockKey = `openmasu:retention:${scope.tenantId}:${scope.appId}`;
  let locked = false;
  try {
    locked = (await lock.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [lockKey])).rows[0].locked;
    if (!locked) throw new Error("retention_busy");
    await snapshot(input.pool, scope, false, async client => {
      const existing = (await client.query<{ policy: RetentionPolicy }>(`SELECT policy FROM control.retention_receipts
        WHERE tenant_id=$1 AND app_id=$2 AND receipt_digest=$3`, [...values, input.receipt])).rows[0];
      if (existing) {
        if (sha256(existing.policy) !== sha256(policy)) throw new Error("retention_receipt_mismatch");
        return;
      }
      const plan = await selection(client, scope, policy);
      if (plan.receipt !== input.receipt) throw new Error("retention_receipt_mismatch");
      if (plan.unboundRuns) throw new Error("retention_dependencies_unknown");
      await client.query(`INSERT INTO control.retention_receipts (receipt_digest,tenant_id,app_id,policy,candidate_count,dependent_run_count,created_at)
        VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`, [input.receipt,...values,JSON.stringify(policy),plan.candidates.length,plan.dependentRuns,now()]);
      for (const [ordinal,candidate] of plan.candidates.entries()) await client.query(`INSERT INTO control.retention_items
        (receipt_digest,ordinal,tenant_id,app_id,layer,target,updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [input.receipt,ordinal,...values,candidate.layer,JSON.stringify(candidate.target),now()]);
      await audit(client,scope,input.receipt,now(),input.actorRef);
    });
    const items = await withTenant(input.pool, scope.tenantId, async client => (await client.query<Item>(`SELECT ordinal,layer,target,state
      FROM control.retention_items WHERE tenant_id=$1 AND app_id=$2 AND receipt_digest=$3 AND state IN ('pending','invalidated')
      ORDER BY ordinal LIMIT $4`, [...values,input.receipt,maximum])).rows);
    for (const item of items) {
      let state: string = item.state;
      if (state === "pending") state = await withTenant(input.pool, scope.tenantId, async client => {
        await acquirePrivacyTenantXactFence(client,scope.tenantId,"shared");
        if (item.layer === "protected_payload") {
          const current = await payloadCandidates(client,scope,policy,String(item.target.payload_ref));
          if (!current.some(candidate=>sha256(candidate.target)===sha256(item.target))) state = "skipped_changed";
          else {
            await client.query(`INSERT INTO ledger.raw_payload_states (tenant_id,app_id,record_id,lifecycle_status,changed_at)
              SELECT tenant_id,app_id,record_id,'purged',$4 FROM ledger.raw_records_current
              WHERE tenant_id=$1 AND app_id=$2 AND record_id=ANY($3::text[]) AND payload_lifecycle_status='available'
              ON CONFLICT (record_id,lifecycle_status) DO NOTHING`, [...values,item.target.record_ids,now()]);
            state = "invalidated";
          }
        } else {
          await client.query("SET LOCAL TIME ZONE 'UTC'");
          const deleted = await client.query(`DELETE FROM ephemeral.request_nonces AS nonce WHERE tenant_id=$1 AND app_id=$2
            AND principal_type=$3 AND principal_key_id=$4 AND encode(sha256(convert_to(nonce.nonce,'UTF8')),'hex')=$5
            AND encode(sha256(convert_to(to_jsonb(nonce.*)::text,'UTF8')),'hex')=$6`,
          [...values,item.target.principal_type,item.target.principal_key_id,item.target.nonce_digest,item.target.row_digest]);
          state = deleted.rowCount ? "completed" : "skipped_changed";
        }
        await client.query(`UPDATE control.retention_items SET state=$5,updated_at=$6
          WHERE tenant_id=$1 AND app_id=$2 AND receipt_digest=$3 AND ordinal=$4`, [...values,input.receipt,item.ordinal,state,now()]);
        return state;
      });
      if (state === "invalidated") {
        let failed = false;
        try {
          await input.payloadStore.purge(String(item.target.payload_ref));
          try { await input.payloadStore.read(String(item.target.payload_ref)); failed = true; }
          catch (error) { if (!(error instanceof PayloadNotFoundError)) failed = true; }
        } catch { failed = true; }
        await withTenant(input.pool,scope.tenantId,client => client.query(`UPDATE control.retention_items
          SET state=$5,attempts=attempts+1,last_error=$6,updated_at=$7
          WHERE tenant_id=$1 AND app_id=$2 AND receipt_digest=$3 AND ordinal=$4`,
        [...values,input.receipt,item.ordinal,failed ? "invalidated" : "completed",failed ? "payload_purge_failed" : null,now()]).then(()=>undefined));
      }
    }
    return await withTenant(input.pool,scope.tenantId,async client => {
      const counts = (await client.query<{ total: number; completed: number; skipped_changed: number; remaining: number; failed: number }>(`SELECT
        count(*)::int AS total,count(*) FILTER(WHERE state='completed')::int AS completed,
        count(*) FILTER(WHERE state='skipped_changed')::int AS skipped_changed,
        count(*) FILTER(WHERE state IN ('pending','invalidated'))::int AS remaining,
        count(*) FILTER(WHERE last_error IS NOT NULL)::int AS failed FROM control.retention_items
        WHERE tenant_id=$1 AND app_id=$2 AND receipt_digest=$3`, [...values,input.receipt])).rows[0];
      return { format: "openmasu-retention-v1",receipt:input.receipt,processed:items.length,...counts };
    });
  } finally {
    if (locked) await lock.query("SELECT pg_advisory_unlock(hashtextextended($1,0))",[lockKey]);
    lock.release();
  }
}
