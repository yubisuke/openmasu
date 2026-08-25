import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { uuidV7, withTenant } from "./index.js";
import type { PayloadStore } from "./payload-store.js";

export type DurableBatchInput = {
  tenantId: string;
  appId: string;
  producer: string;
  body: Buffer;
  eventCount: number;
  receivedAt: string;
  sdkKeyId?: string;
  installationKeyId?: string;
  requestNonce?: string;
  requestTimestampMs?: number;
};

export async function appendDurableBatch(
  pool: Pool,
  payloadStore: PayloadStore,
  input: DurableBatchInput,
): Promise<string> {
  if (!Number.isInteger(input.eventCount) || input.eventCount < 1 || input.eventCount > 100) {
    throw new Error("event_count_out_of_range");
  }
  const ingestBatchId = uuidV7(Date.parse(input.receivedAt));
  const bodyDigest = createHash("sha256").update(input.body).digest("hex");
  const bodyRef = await payloadStore.write(
    { tenantId: input.tenantId, appId: input.appId, objectId: `ingest-batch-${ingestBatchId}` },
    input.body,
  );
  try {
    await withTenant(pool, input.tenantId, async (client) => {
      await client.query(
        `INSERT INTO control.apps (tenant_id, app_id, created_at)
         VALUES ($1,$2,$3) ON CONFLICT (tenant_id, app_id) DO NOTHING`,
        [input.tenantId, input.appId, input.receivedAt],
      );
      const artifact = {
        ingest_batch_id: ingestBatchId,
        tenant_id: input.tenantId,
        app_id: input.appId,
        producer: input.producer,
        received_at: input.receivedAt,
        body_digest: bodyDigest,
        event_count: input.eventCount,
        ...(input.sdkKeyId ? { sdk_key_id: input.sdkKeyId } : {}),
        ...(input.installationKeyId ? { installation_key_id: input.installationKeyId } : {}),
      };
      await client.query(
        `INSERT INTO ledger.ingest_batches (
          ingest_batch_id, tenant_id, app_id, producer, sdk_key_id,
          installation_key_id, received_at, body_ref, body_digest, event_count,
          request_nonce, request_timestamp_ms, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
        [
          ingestBatchId, input.tenantId, input.appId, input.producer,
          input.sdkKeyId ?? null, input.installationKeyId ?? null,
          input.receivedAt, bodyRef, bodyDigest, input.eventCount,
          input.requestNonce ?? null, input.requestTimestampMs ?? null,
          JSON.stringify(artifact),
        ],
      );
      await client.query(
        `INSERT INTO ledger.ingest_batch_states (
          ingest_batch_id, tenant_id, app_id, status, changed_at, artifact
        ) VALUES ($1,$2,$3,'pending',$4,$5::jsonb)`,
        [ingestBatchId, input.tenantId, input.appId, input.receivedAt, JSON.stringify({
          ingest_batch_id: ingestBatchId, status: "pending", changed_at: input.receivedAt,
        })],
      );
    });
  } catch (error) {
    await payloadStore.purge(bodyRef);
    throw error;
  }
  return ingestBatchId;
}
