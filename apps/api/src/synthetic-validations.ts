import type { Pool } from "pg";
import { assertSyntheticValidationDeployment, parseSyntheticValidationDefinition, syntheticValidationLimits,
  syntheticValidationToken, syntheticValidationTokenDigest, SyntheticValidationError, uuidV7, withTenant,
  type SyntheticValidationDefinition } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";

const unavailable = () => new SyntheticValidationError("validation_session_unavailable", 404);
const validId = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export type SyntheticValidationCreated = { session_id: string; session_token: string; expires_at: string };
export type ValidationCounts = { accepted: number; rejected: number; duplicate: number; unresolved: number };
export type ValidationReceipt = ValidationCounts & { validation_receipt: string; processing_state: "queued" | "processed" | "failed" | "post_processing";
  rejection_reasons: { reason: string; count: number }[]; metric_state: "saved_input_reference" | "not_observed" | "unknown_limit"; saved_input_references: number };
export type SyntheticValidationStatus = { session_id: string; expires_at: string; batch_count: number; event_count: number;
  expectations: (ValidationCounts & { event_name: string; custom_key?: string })[]; receipts: ValidationReceipt[] };

export async function createSyntheticValidation(pool: Pool, identity: AppAdminIdentity, body: unknown): Promise<SyntheticValidationCreated> {
  const definition = parseSyntheticValidationDefinition(body), token = syntheticValidationToken(), sessionId = uuidV7();
  return withTenant(pool, identity.tenantId, async client => {
    await client.query("SET LOCAL statement_timeout='5s'");
    await assertSyntheticValidationDeployment(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`synthetic-validation:${identity.tenantId}`]);
    await client.query(`DELETE FROM ephemeral.synthetic_validation_sessions WHERE tenant_id=$1 AND session_id IN (
      SELECT session_id FROM ephemeral.synthetic_validation_sessions WHERE tenant_id=$1 AND expires_at<=clock_timestamp()
      ORDER BY expires_at,session_id LIMIT $2 FOR UPDATE SKIP LOCKED)`, [identity.tenantId, syntheticValidationLimits.cleanupPerCycle]);
    const count = Number((await client.query("SELECT count(*)::int AS count FROM ephemeral.synthetic_validation_sessions WHERE tenant_id=$1", [identity.tenantId])).rows[0].count);
    if (count >= syntheticValidationLimits.sessionsPerTenant) throw new SyntheticValidationError("validation_capacity_reached", 409);
    const row = (await client.query<{ expires_at: Date }>(`INSERT INTO ephemeral.synthetic_validation_sessions
      (session_id,tenant_id,app_id,token_digest,created_at,expires_at,expected_events,expected_custom_keys)
      VALUES ($1,$2,$3,$4,statement_timestamp(),statement_timestamp()+$5::int*interval '1 second',$6::text[],$7::text[])
      RETURNING expires_at`, [sessionId, identity.tenantId, identity.appId, syntheticValidationTokenDigest(token), definition.ttl_seconds,
      definition.expected_events, definition.expected_custom_keys])).rows[0];
    return { session_id: sessionId, session_token: token, expires_at: row.expires_at.toISOString() };
  });
}

export async function closeSyntheticValidation(pool: Pool, identity: AppAdminIdentity, id: string): Promise<{ status: "closed" }> {
  if (!validId(id)) throw unavailable();
  return withTenant(pool, identity.tenantId, async client => {
    await assertSyntheticValidationDeployment(client);
    const row = await client.query(`DELETE FROM ephemeral.synthetic_validation_sessions
      WHERE tenant_id=$1 AND app_id=$2 AND session_id=$3`, [identity.tenantId, identity.appId, id]);
    if (row.rowCount !== 1) throw unavailable();
    return { status: "closed" };
  });
}

/** Reader-only receipt projection. Never decrypt evidence or use app-wide event counts. */
export async function syntheticValidationStatus(pool: Pool, identity: AppAdminIdentity, id: string): Promise<SyntheticValidationStatus> {
  if (!validId(id)) throw unavailable();
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('openmasu.tenant_id',$1,true)", [identity.tenantId]);
    await client.query("SET LOCAL statement_timeout='5s'");
    await assertSyntheticValidationDeployment(client);
    const args = [identity.tenantId, identity.appId, id];
    const session = (await client.query<SyntheticValidationDefinition & { expires_at: Date; batch_count: number; event_count: number }>(
      `SELECT expected_events,expected_custom_keys,expires_at,batch_count,event_count FROM ephemeral.synthetic_validation_sessions
       WHERE tenant_id=$1 AND app_id=$2 AND session_id=$3 AND expires_at>clock_timestamp()`, args)).rows[0];
    if (!session) throw unavailable();
    type Row = { receipt: string; status: string; batch_reason: string | null; record_id: string; event_class: string;
      custom_key_index: number | null; ingestion_status: string | null; duplicate_resolution: string | null; reason: string | null };
    const rows = (await client.query<Row>(`SELECT receipt.receipt,batch.status,batch.reason_code AS batch_reason,
      mark.record_id,mark.event_class,mark.custom_key_index,delivery.ingestion_status,delivery.duplicate_resolution,
      CASE WHEN rejection.reason_code IN ('payload_schema_invalid','event_id_conflict','timestamp_invalid','consent_withdrawn')
        THEN rejection.reason_code WHEN rejection.reason_code IS NOT NULL THEN 'other' ELSE NULL END AS reason
      FROM ephemeral.synthetic_validation_receipts receipt
      JOIN ledger.ingest_batches_current batch USING (tenant_id,app_id,ingest_batch_id)
      CROSS JOIN LATERAL jsonb_to_recordset(receipt.event_marks) mark(record_id text,event_class text,custom_key_index integer)
      LEFT JOIN ledger.ingest_batch_records member ON member.tenant_id=receipt.tenant_id AND member.app_id=receipt.app_id
        AND member.ingest_batch_id=receipt.ingest_batch_id AND member.record_id=mark.record_id
      LEFT JOIN LATERAL (SELECT ingestion_status,duplicate_resolution FROM ledger.event_deliveries
        WHERE tenant_id=receipt.tenant_id AND app_id=receipt.app_id AND record_id=member.record_id ORDER BY ledger_seq DESC LIMIT 1) delivery ON true
      LEFT JOIN LATERAL (SELECT reason_code FROM ledger.rejections
        WHERE tenant_id=receipt.tenant_id AND app_id=receipt.app_id AND record_id=member.record_id ORDER BY rejection_seq DESC LIMIT 1) rejection ON true
      WHERE receipt.tenant_id=$1 AND receipt.app_id=$2 AND receipt.session_id=$3
      ORDER BY receipt.created_at,receipt.receipt,mark.record_id LIMIT 201`, args)).rows;
    if (rows.length > syntheticValidationLimits.events) throw new Error("validation_projection_limit");
    const zero = (): ValidationCounts => ({ accepted: 0, rejected: 0, duplicate: 0, unresolved: 0 });
    const expectations: SyntheticValidationStatus["expectations"] = [
      ...session.expected_events.map(event_name => ({ event_name, ...zero() })),
      ...session.expected_custom_keys.map(custom_key => ({ event_name: "custom_event", custom_key, ...zero() })),
    ];
    const receipts = new Map<string, ValidationReceipt>();
    const acceptedRefs: { receipt: string; record_id: string }[] = [];
    for (const row of rows) {
      let receipt = receipts.get(row.receipt);
      if (!receipt) {
        receipt = { validation_receipt: row.receipt, ...zero(), processing_state: row.status === "failed" ? "failed"
          : row.status === "pending" ? "queued" : row.batch_reason === "post_processing_pending" ? "post_processing" : "processed",
          rejection_reasons: [], metric_state: "not_observed", saved_input_references: 0 };
        receipts.set(row.receipt, receipt);
      }
      const outcome: keyof ValidationCounts = row.ingestion_status === "rejected" ? "rejected"
        : row.ingestion_status === "accepted" ? row.duplicate_resolution === "duplicate_delivery" ? "duplicate" : "accepted" : "unresolved";
      receipt[outcome]++;
      for (const expected of expectations) if (expected.event_name === row.event_class && (expected.custom_key === undefined
        || row.custom_key_index !== null && session.expected_custom_keys[row.custom_key_index] === expected.custom_key)) expected[outcome]++;
      if (outcome === "accepted") acceptedRefs.push({ receipt: row.receipt, record_id: row.record_id });
      if (outcome === "rejected") {
        const reason = row.reason ?? "other", found = receipt.rejection_reasons.find(value => value.reason === reason);
        if (found) found.count++; else receipt.rejection_reasons.push({ reason, count: 1 });
      }
    }
    if (acceptedRefs.length) {
      // Exactly this session's accepted record IDs, never a duplicate's foreign canonical record.
      const matches = (await client.query<{ receipt: string; matches: number; limited: boolean }>(`WITH candidates AS MATERIALIZED (
        SELECT metric_run_id,artifact FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2
        ORDER BY computed_at DESC,metric_run_id DESC LIMIT 101
      ), bounded AS (SELECT * FROM candidates LIMIT 100)
      SELECT input.receipt,count(DISTINCT metric.metric_run_id)::int AS matches,(SELECT count(*)>100 FROM candidates) AS limited
      FROM jsonb_to_recordset($3::jsonb) input(receipt text,record_id text)
      LEFT JOIN bounded metric ON metric.artifact->'evidence_refs' @> jsonb_build_array(jsonb_build_object('tenant_id',$1::text,'app_id',$2::text,'ref',input.record_id))
      GROUP BY input.receipt`, [identity.tenantId, identity.appId, JSON.stringify(acceptedRefs)])).rows;
      for (const match of matches) {
        const receipt = receipts.get(match.receipt)!;
        receipt.saved_input_references = match.matches;
        receipt.metric_state = match.matches > 0 ? "saved_input_reference" : match.limited ? "unknown_limit" : "not_observed";
      }
    }
    if (session.expires_at.getTime() <= Number((await client.query("SELECT extract(epoch FROM clock_timestamp())*1000 AS now")).rows[0].now)) throw unavailable();
    await client.query("COMMIT");
    return { session_id: id, expires_at: session.expires_at.toISOString(), batch_count: session.batch_count,
      event_count: session.event_count, expectations, receipts: [...receipts.values()] };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
