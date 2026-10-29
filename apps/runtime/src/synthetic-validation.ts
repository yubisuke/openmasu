import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTenant } from "./index.js";

export const SYNTHETIC_VALIDATION_EVENTS = ["install", "session_start", "custom_event", "ad_revenue", "purchase", "refund", "deep_link_open"] as const;
export type SyntheticValidationEvent = typeof SYNTHETIC_VALIDATION_EVENTS[number];
export type SyntheticValidationDefinition = { ttl_seconds: number; expected_events: SyntheticValidationEvent[]; expected_custom_keys: string[] };
export const syntheticValidationLimits = { batches: 50, events: 200, sessionsPerTenant: 20, cleanupPerCycle: 50, metricRuns: 100 } as const;
export class SyntheticValidationError extends Error {
  constructor(readonly code: "validation_request_invalid" | "validation_session_unavailable" | "validation_session_expired"
    | "validation_session_limit" | "validation_capacity_reached" | "synthetic_deployment_required", readonly status: number) { super(code); }
}
const invalid = () => new SyntheticValidationError("validation_request_invalid", 400);
export function parseSyntheticValidationDefinition(value: unknown): SyntheticValidationDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !["ttl_seconds", "expected_events", "expected_custom_keys"].includes(key))) throw invalid();
  const ttl = body.ttl_seconds ?? 600, events = body.expected_events ?? ["install", "session_start"], keys = body.expected_custom_keys ?? [];
  if (!Number.isSafeInteger(ttl) || (ttl as number) < 60 || (ttl as number) > 1800
    || !Array.isArray(events) || events.length < 1 || events.length > SYNTHETIC_VALIDATION_EVENTS.length
    || events.some(event => !SYNTHETIC_VALIDATION_EVENTS.includes(event)) || new Set(events).size !== events.length
    || !Array.isArray(keys) || keys.length > 16 || keys.some(key => typeof key !== "string"
      || !/^[a-z][a-z0-9_]{0,63}$/.test(key) && key !== "openmasu.conversion_value_updated")
    || new Set(keys).size !== keys.length || keys.length > 0 && !events.includes("custom_event")) throw invalid();
  return { ttl_seconds: ttl as number, expected_events: [...events].sort(), expected_custom_keys: [...keys].sort() };
}
export function syntheticValidationToken(): string { return randomBytes(32).toString("base64url"); }
export function syntheticValidationTokenDigest(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)
    || Buffer.from(value, "base64url").toString("base64url") !== value) throw invalid();
  return createHash("sha256").update(value).digest("hex");
}
export async function assertSyntheticValidationDeployment(client: PoolClient): Promise<void> {
  const rows = (await client.query<{ purpose: string }>("SELECT purpose FROM control.deployment_purpose WHERE singleton")).rows;
  if (rows.length !== 1 || rows[0].purpose !== "synthetic_disposable") throw new SyntheticValidationError("synthetic_deployment_required", 403);
}
export type SyntheticValidationMark = { record_id: string; event_class: SyntheticValidationEvent | "other"; custom_key_index: number | null };

/** Called only inside durable admission's transaction, after the privacy fence. */
export async function attachSyntheticValidationReceipt(client: PoolClient, input: {
  tenantId: string; appId: string; token: unknown; receipt: string; batchId: string;
  records: readonly { record_id: string; event_name: unknown; payload?: { event_key?: unknown } }[];
}): Promise<void> {
  const digest = syntheticValidationTokenDigest(input.token);
  await assertSyntheticValidationDeployment(client);
  const row = (await client.query<{ session_id: string; expected_custom_keys: string[]; expired: boolean; batch_count: number; event_count: number }>(
    `SELECT session_id,expected_custom_keys,expires_at<=clock_timestamp() AS expired,batch_count,event_count
       FROM ephemeral.synthetic_validation_sessions WHERE tenant_id=$1 AND app_id=$2 AND token_digest=$3 FOR UPDATE`,
    [input.tenantId, input.appId, digest])).rows[0];
  if (!row) throw new SyntheticValidationError("validation_session_unavailable", 404);
  if (row.expired) throw new SyntheticValidationError("validation_session_expired", 410);
  if (row.batch_count >= syntheticValidationLimits.batches || row.event_count + input.records.length > syntheticValidationLimits.events) {
    throw new SyntheticValidationError("validation_session_limit", 409);
  }
  const marks: SyntheticValidationMark[] = input.records.map(record => {
    const key = record.payload?.event_key;
    const index = record.event_name === "custom_event" && typeof key === "string" ? row.expected_custom_keys.indexOf(key) : -1;
    return { record_id: record.record_id,
      event_class: SYNTHETIC_VALIDATION_EVENTS.includes(record.event_name as SyntheticValidationEvent) ? record.event_name as SyntheticValidationEvent : "other",
      custom_key_index: index >= 0 ? index : null };
  });
  await client.query(`UPDATE ephemeral.synthetic_validation_sessions SET batch_count=batch_count+1,event_count=event_count+$3
    WHERE tenant_id=$1 AND session_id=$2`, [input.tenantId, row.session_id, marks.length]);
  await client.query(`INSERT INTO ephemeral.synthetic_validation_receipts
    (tenant_id,app_id,session_id,receipt,ingest_batch_id,event_marks) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
  [input.tenantId, input.appId, row.session_id, input.receipt, input.batchId, JSON.stringify(marks)]);
}

/** Bounded worker mutation; status reads never sweep or prolong a session. */
export async function cleanupSyntheticValidations(pool: Pool, tenantId: string): Promise<number> {
  return withTenant(pool, tenantId, async client => {
    await client.query("SET LOCAL statement_timeout='5s'");
    const result = await client.query(`DELETE FROM ephemeral.synthetic_validation_sessions WHERE tenant_id=$1 AND session_id IN (
      SELECT session_id FROM ephemeral.synthetic_validation_sessions WHERE tenant_id=$1 AND expires_at<=clock_timestamp()
      ORDER BY expires_at,session_id LIMIT $2 FOR UPDATE SKIP LOCKED)`, [tenantId, syntheticValidationLimits.cleanupPerCycle]);
    return result.rowCount ?? 0;
  });
}
