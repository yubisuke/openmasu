import type { PoolClient } from "pg";
import { uuidV7, measurementClasses, type MeasurementClasses } from "@openmasu/runtime";
import type { Any, Correction, Delivery, LogicalEvent, RawRecord, Rejection } from "./model.js";

export async function storedArtifact(
  client: PoolClient,
  insert: string,
  insertValues: unknown[],
  select: string,
  selectValues: unknown[],
): Promise<Any> {
  const inserted = await client.query<{ artifact: Any }>(insert, insertValues);
  const artifact = inserted.rows[0]?.artifact ?? (await client.query<{ artifact: Any }>(select, selectValues)).rows[0]?.artifact;
  if (!artifact) throw new Error("ledger insert did not return an artifact");
  return artifact;
}

export async function persistRawWithClient(client: PoolClient, artifact: RawRecord, policyDigest: string): Promise<Any> {
  return storedArtifact(
    client,
    `INSERT INTO ledger.raw_records (
      record_id, tenant_id, app_id, producer, producer_version, event_id, delivery_id,
      event_name, schema_version, payload_sha256, occurred_at, occurred_at_source,
      received_at, raw_payload_ref, processing_purpose_id,
      consent_evaluation_policy_version, consent_decision_reason_code,
      withdrawal_recognized_at, alternative_legal_basis_id,
      alternative_legal_basis_policy_version, policy_digest, artifact
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb
    ) ON CONFLICT (record_id) DO NOTHING RETURNING artifact`,
    [
      artifact.record_id, artifact.tenant_id, artifact.app_id, artifact.producer,
      artifact.producer_version, artifact.event_id, artifact.delivery_id, artifact.event_name,
      artifact.schema_version, artifact.payload_sha256, artifact.occurred_at,
      artifact.occurred_at_source, artifact.received_at, artifact.raw_payload_ref,
      artifact.processing_purpose_id, artifact.consent_evaluation_policy_version,
      artifact.consent_decision_reason_code, artifact.withdrawal_recognized_at ?? null,
      artifact.alternative_legal_basis_id ?? null,
      artifact.alternative_legal_basis_policy_version ?? null, policyDigest, JSON.stringify(artifact),
    ],
    "SELECT artifact FROM ledger.raw_records WHERE record_id = $1",
    [artifact.record_id],
  );
}

export async function persistDeliveryWithClient(client: PoolClient, artifact: Delivery,
  classes: MeasurementClasses = measurementClasses()): Promise<Any> {
  const result = await client.query<{ artifact: Any }>(
      `INSERT INTO ledger.event_deliveries (
        delivery_attempt_id, delivery_id, record_id, canonical_record_id, tenant_id, app_id,
        received_at, ingestion_status, duplicate_resolution, timeliness,
        clock_skew_suspected, payload_disposition, reason_code, processing_purpose_id,
        consent_evaluation_policy_version, consent_decision_reason_code,
        withdrawal_recognized_at, alternative_legal_basis_id,
        alternative_legal_basis_policy_version, artifact,
        diagnostic_event_name, diagnostic_producer, diagnostic_producer_version
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23)
      RETURNING artifact`,
      [
        uuidV7(), artifact.delivery_id, artifact.record_id, artifact.canonical_record_id ?? null,
        artifact.tenant_id, artifact.app_id, artifact.received_at, artifact.ingestion_status,
        artifact.duplicate_resolution, artifact.timeliness, artifact.clock_skew_suspected,
        artifact.payload_disposition, artifact.reason_code ?? null, artifact.processing_purpose_id,
        artifact.consent_evaluation_policy_version, artifact.consent_decision_reason_code,
        artifact.withdrawal_recognized_at ?? null, artifact.alternative_legal_basis_id ?? null,
        artifact.alternative_legal_basis_policy_version ?? null, JSON.stringify(artifact),
        classes.event_name, classes.producer, classes.producer_version,
      ],
  );
  return result.rows[0].artifact;
}

export async function persistLogicalWithClient(client: PoolClient, artifact: LogicalEvent): Promise<Any> {
  return storedArtifact(
    client,
    `INSERT INTO ledger.logical_events (
      logical_event_id, record_id, tenant_id, app_id, producer, event_id,
      event_name, record_lifecycle, timeliness, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT (logical_event_id) DO NOTHING RETURNING artifact`,
    [
      artifact.logical_event_id, artifact.record_id, artifact.tenant_id, artifact.app_id,
      artifact.producer, artifact.event_id, artifact.event_name, artifact.record_lifecycle,
      artifact.timeliness, JSON.stringify(artifact),
    ],
    "SELECT artifact FROM ledger.logical_events WHERE logical_event_id = $1",
    [artifact.logical_event_id],
  );
}

export async function persistCorrectionWithClient(client: PoolClient, artifact: Correction): Promise<Any> {
  return storedArtifact(
    client,
    `INSERT INTO ledger.corrections (
      correction_id, tenant_id, app_id, corrects_record_id, effective_at, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    ON CONFLICT (correction_id) DO NOTHING RETURNING artifact`,
    [artifact.correction_id, artifact.tenant_id, artifact.app_id, artifact.corrects_record_id, artifact.effective_at, JSON.stringify(artifact)],
    "SELECT artifact FROM ledger.corrections WHERE correction_id = $1",
    [artifact.correction_id],
  );
}

export async function persistRejectionWithClient(client: PoolClient, artifact: Rejection): Promise<Any> {
  const result = await client.query<{ artifact: Any }>(
      `INSERT INTO ledger.rejections (
        tenant_id, app_id, delivery_id, record_id, reason_code, artifact
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING artifact`,
      [artifact.tenant_id, artifact.app_id, artifact.delivery_id, artifact.record_id, artifact.reason_code, JSON.stringify(artifact)],
  );
  return result.rows[0].artifact;
}
