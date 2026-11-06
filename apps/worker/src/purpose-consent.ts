import type { Pool, PoolClient } from "pg";
import { IndexedCandidateProvider, sortCandidateAttempts, type CandidateAttempt } from "@openmasu/attribution-core";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { CONSENT_PURPOSES, type PurposeConsentControl } from "@openmasu/contracts/definitions";
import { validateEventPayload } from "@openmasu/contracts/validation";
import { withTenant } from "@openmasu/runtime";

/** Pre-admit only canonical controls; an earlier measurement owns its event ID. */
export function canonicalConsentAttempts(pending: readonly CandidateAttempt[], history: readonly CandidateAttempt[]): CandidateAttempt[] {
  const valid = pending.filter(attempt => validateEventPayload(attempt.record.event_name, attempt.record.payload).valid);
  const candidates = new IndexedCandidateProvider(sortCandidateAttempts([...history, ...valid]));
  return valid.filter(attempt => attempt.record.event_name === "consent_changed"
    && candidates.byRecordId(attempt.record.record_id).length === 1
    && candidates.byLogicalScope(attempt)[0] === attempt);
}

/** Called inside the same transaction as the canonical control ledger insert. */
export async function persistPurposeConsentWithClient(
  client: PoolClient, installationKeyId: string, attempt: CandidateAttempt,
): Promise<void> {
  const { record, server } = attempt;
  const payload = record.payload;
  if (record.event_name !== "consent_changed" || !validateEventPayload(record.event_name, payload).valid) return;
  // A legacy global grant cannot clear an old barrier. Only its denial is useful.
  if (payload.consent_revision === undefined && !["withdrawn", "denied"].includes(payload.consent_state)) return;
  const purposes = payload.processing_purpose_id ? [payload.processing_purpose_id] : CONSENT_PURPOSES;
  for (const purpose of purposes) {
    await client.query(
      `INSERT INTO control.installation_consent_controls
       (tenant_id,app_id,installation_key_id,source_record_id,processing_purpose_id,
        consent_state,consent_revision,recognized_sequence,recognized_at)
       SELECT raw.tenant_id,raw.app_id,$1,raw.record_id,$2,$3,$4,$5,$6
       FROM ledger.raw_records raw
       JOIN ledger.logical_events logical
         ON logical.tenant_id=raw.tenant_id AND logical.app_id=raw.app_id AND logical.record_id=raw.record_id
       JOIN control.installation_credentials_current credential
         ON credential.tenant_id=raw.tenant_id AND credential.app_id=raw.app_id
        AND credential.installation_key_id=$1 AND credential.status='active'
       WHERE raw.tenant_id=$7 AND raw.app_id=$8 AND raw.record_id=$9
         AND raw.delivery_id=$10 AND raw.producer=$11 AND raw.event_id=$12
         AND raw.payload_sha256=$13 AND logical.event_name='consent_changed'
       ON CONFLICT (tenant_id,app_id,source_record_id,processing_purpose_id) DO NOTHING`,
      [installationKeyId, purpose, payload.consent_state, payload.consent_revision ?? null,
        record.processing_sequence, record.received_at, server.tenant_id, server.app_id,
        record.record_id, record.delivery_id, record.producer, record.event_id, sha256(payload)],
    );
  }
}

export type ConsentProjectionRequest = {
  appId: string; installationKeyId: string; sequence: number;
};

/**
 * At most five controls per purpose per requested receipt: the first occurrence
 * of each state at its highest revision, plus its last unversioned stop.
 * No historical bodies are decrypted or unbounded result sets returned.
 */
export async function purposeControlsAtReceipts(
  pool: Pool, tenantId: string, requests: readonly ConsentProjectionRequest[],
): Promise<readonly PurposeConsentControl[][]> {
  if (requests.length === 0) return [];
  const result = await withTenant(pool, tenantId, client => client.query<{
    ordinal: number; processing_purpose_id: PurposeConsentControl["processing_purpose_id"];
    consent_state: PurposeConsentControl["consent_state"]; consent_revision: string | null;
    recognized_sequence: string; recognized_at: string;
  }>(
    `WITH requested AS (
       SELECT * FROM jsonb_to_recordset($2::jsonb)
         AS request(ordinal integer, app_id text, installation_key_id text, receipt_sequence bigint)
     )
     SELECT request.ordinal, purpose.id AS processing_purpose_id, selected.consent_state,
            selected.consent_revision::text, selected.recognized_sequence::text, selected.recognized_at
     FROM requested request
     CROSS JOIN (VALUES ('attribution'),('analytics'),('revenue_measurement')) purpose(id)
     CROSS JOIN LATERAL (
       (SELECT DISTINCT ON (control.consent_state) control.consent_state,control.consent_revision,
           control.recognized_sequence,control.recognized_at
        FROM control.installation_consent_controls control
        WHERE control.tenant_id=$1 AND control.app_id=request.app_id
          AND control.installation_key_id=request.installation_key_id AND control.processing_purpose_id=purpose.id
          AND control.recognized_sequence<=request.receipt_sequence AND control.consent_state<>'unknown'
          AND control.consent_revision=(
            SELECT max(revision.consent_revision) FROM control.installation_consent_controls revision
            WHERE revision.tenant_id=$1 AND revision.app_id=request.app_id
              AND revision.installation_key_id=request.installation_key_id AND revision.processing_purpose_id=purpose.id
              AND revision.recognized_sequence<=request.receipt_sequence AND revision.consent_state<>'unknown')
        ORDER BY control.consent_state,control.recognized_sequence,control.recognized_at)
       UNION ALL
       (SELECT legacy.consent_state,legacy.consent_revision,legacy.recognized_sequence,legacy.recognized_at
        FROM control.installation_consent_controls legacy
        WHERE legacy.tenant_id=$1 AND legacy.app_id=request.app_id
          AND legacy.installation_key_id=request.installation_key_id AND legacy.processing_purpose_id=purpose.id
          AND legacy.recognized_sequence<=request.receipt_sequence AND legacy.consent_revision IS NULL
          AND legacy.consent_state IN ('denied','withdrawn')
        ORDER BY legacy.recognized_sequence DESC,legacy.recognized_at DESC,legacy.consent_state DESC LIMIT 1)
     ) selected ORDER BY request.ordinal,purpose.id,selected.recognized_sequence`,
    [tenantId, JSON.stringify(requests.map((request, ordinal) => ({
      ordinal, app_id: request.appId, installation_key_id: request.installationKeyId, receipt_sequence: request.sequence,
    })))],
  ));
  const controls: PurposeConsentControl[][] = requests.map(() => []);
  for (const row of result.rows) controls[row.ordinal].push({
    // Unversioned declarations were global. Storage expands them to three rows;
    // repeating that global control is idempotent in the contract projection.
    ...(row.consent_revision === null ? {} : { processing_purpose_id: row.processing_purpose_id }),
    consent_state: row.consent_state,
    ...(row.consent_revision === null ? {} : { consent_revision: Number(row.consent_revision) }),
    recognized_sequence: Number(row.recognized_sequence), recognized_at: row.recognized_at,
  });
  return controls;
}
