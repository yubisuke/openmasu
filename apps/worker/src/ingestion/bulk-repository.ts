import type { PoolClient } from "pg";
import { type CandidateAttempt } from "@openmasu/attribution-core";
import { uuidV7 } from "@openmasu/runtime";
import { resolveActiveFraudBundle } from "../fraud-bundle-runtime.js";
import { assertNonFraudArtifactBinding, type BoundNonFraudBundle } from "../non-fraud-bundle-runtime.js";
import { policyDigestForRecord, refundProjectionTargets } from "./input.js";
import { persistProjectionWithClient, bulkProjectionRows } from "./fact-projections.js";
import { type Any, type RuntimeIngestionResult } from "./model.js";

export const runtimeBulkChunkSize = 1_000;

export async function insertJsonRows(
  client: PoolClient,
  rows: readonly Any[],
  statement: string,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += runtimeBulkChunkSize) {
    await client.query(statement, [JSON.stringify(rows.slice(offset, offset + runtimeBulkChunkSize))]);
  }
}

export type PreparedRuntimeBulk = {
  tenantId: string;
  rawRows: Any[];
  deliveryRows: Any[];
  logicalRows: Any[];
  rejectionRows: Any[];
  correctionRows: Any[];
  attributionRows: Any[];
  reconciliationRows: Any[];
  projections: ReturnType<typeof bulkProjectionRows>;
  attempts: readonly CandidateAttempt[];
  selected: RuntimeIngestionResult;
  input: Any;
  activeRevision: Awaited<ReturnType<typeof resolveActiveFraudBundle>>;
};

export function prepareRuntimeBulk(
  attempts: readonly CandidateAttempt[],
  selected: RuntimeIngestionResult,
  input: Any,
  activeRevision: Awaited<ReturnType<typeof resolveActiveFraudBundle>>,
  nonFraudBindings: ReadonlyMap<string, BoundNonFraudBundle>,
  acceptedLogicals: readonly Any[],
): PreparedRuntimeBulk {
const tenantId = attempts[0].server.tenant_id;
const rawRows: Any[] = selected.raw_records.map((artifact) => ({
    ...artifact, policy_digest: policyDigestForRecord(input, artifact.record_id), artifact,
  }));
const deliveryRows = selected.deliveries.map((artifact) => ({ ...artifact, delivery_attempt_id: uuidV7(), artifact }));
const logicalRows = selected.logical_events.map((artifact) => ({ ...artifact, artifact }));
const rejectionRows = selected.rejections.map((artifact) => ({ ...artifact, artifact }));
const correctionRows = selected.corrections.map((artifact) => ({ ...artifact, artifact }));
const attributionRows = selected.attributions.map((artifact) => ({ ...artifact, artifact }));
for (const artifact of selected.attributions) {
    const binding = nonFraudBindings.get(artifact.rule_bundle_id);
    if (!binding) throw new Error("non_fraud_rule_bundle_binding_missing");
    assertNonFraudArtifactBinding(artifact, binding);
  }
const reconciliationRows = selected.reconciliation.map((artifact) => ({ ...artifact, artifact }));
const projections = bulkProjectionRows(
    selected.logical_events,
    input,
    refundProjectionTargets(selected.logical_events, input, selected.corrections, acceptedLogicals),
  );
  return { tenantId, rawRows, deliveryRows, logicalRows, rejectionRows, correctionRows, attributionRows, reconciliationRows, projections, attempts, selected, input, activeRevision };
}

export async function persistPreparedRuntimeBulkWithClient(client: PoolClient, prepared: PreparedRuntimeBulk): Promise<void> {
  const { rawRows, deliveryRows, logicalRows, rejectionRows, correctionRows, attributionRows, reconciliationRows, projections, attempts, selected, input, activeRevision } = prepared;
await insertJsonRows(client, rawRows, `INSERT INTO ledger.raw_records (
      record_id,tenant_id,app_id,producer,producer_version,event_id,delivery_id,event_name,schema_version,
      payload_sha256,occurred_at,occurred_at_source,received_at,raw_payload_ref,processing_purpose_id,
      consent_evaluation_policy_version,consent_decision_reason_code,withdrawal_recognized_at,
      alternative_legal_basis_id,alternative_legal_basis_policy_version,policy_digest,artifact)
      SELECT record_id,tenant_id,app_id,producer,producer_version,event_id,delivery_id,event_name,schema_version,
      payload_sha256,occurred_at,occurred_at_source,received_at,raw_payload_ref,processing_purpose_id,
      consent_evaluation_policy_version,consent_decision_reason_code,withdrawal_recognized_at,
      alternative_legal_basis_id,alternative_legal_basis_policy_version,policy_digest,artifact
      FROM jsonb_populate_recordset(NULL::ledger.raw_records,$1::jsonb)
      ON CONFLICT (record_id) DO NOTHING`);
await insertJsonRows(client, rawRows.map((row) => ({
      tenant_id: row.tenant_id, app_id: row.app_id, record_id: row.record_id,
      lifecycle_status: "available", changed_at: row.received_at,
    })), `INSERT INTO ledger.raw_payload_states (tenant_id,app_id,record_id,lifecycle_status,changed_at)
      SELECT tenant_id,app_id,record_id,lifecycle_status,changed_at
      FROM jsonb_populate_recordset(NULL::ledger.raw_payload_states,$1::jsonb)
      ON CONFLICT (record_id,lifecycle_status) DO NOTHING`);
await insertJsonRows(client, deliveryRows, `INSERT INTO ledger.event_deliveries (
      delivery_attempt_id,delivery_id,record_id,canonical_record_id,tenant_id,app_id,received_at,
      ingestion_status,duplicate_resolution,timeliness,clock_skew_suspected,payload_disposition,reason_code,
      processing_purpose_id,consent_evaluation_policy_version,consent_decision_reason_code,
      withdrawal_recognized_at,alternative_legal_basis_id,alternative_legal_basis_policy_version,artifact)
      SELECT delivery_attempt_id,delivery_id,record_id,canonical_record_id,tenant_id,app_id,received_at,
      ingestion_status,duplicate_resolution,timeliness,clock_skew_suspected,payload_disposition,reason_code,
      processing_purpose_id,consent_evaluation_policy_version,consent_decision_reason_code,
      withdrawal_recognized_at,alternative_legal_basis_id,alternative_legal_basis_policy_version,artifact
      FROM jsonb_populate_recordset(NULL::ledger.event_deliveries,$1::jsonb)`);
await insertJsonRows(client, logicalRows, `INSERT INTO ledger.logical_events (
      logical_event_id,record_id,tenant_id,app_id,producer,event_id,event_name,record_lifecycle,timeliness,artifact)
      SELECT logical_event_id,record_id,tenant_id,app_id,producer,event_id,event_name,record_lifecycle,timeliness,artifact
      FROM jsonb_populate_recordset(NULL::ledger.logical_events,$1::jsonb)
      ON CONFLICT (logical_event_id) DO NOTHING`);
const projectionStatements: Record<string, string> = {
      click: `INSERT INTO ledger.click_facts (logical_event_id,tenant_id,app_id,click_id,redirector_click_at,campaign_id,network,country,site_id,remote_click_ref,tracking_link_id,artifact)
        SELECT logical_event_id,tenant_id,app_id,click_id,redirector_click_at,campaign_id,network,country,site_id,remote_click_ref,tracking_link_id,artifact FROM jsonb_populate_recordset(NULL::ledger.click_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
      install: `INSERT INTO ledger.install_facts (logical_event_id,tenant_id,app_id,installation_id,prior_installation_id,install_type,click_id,install_begin_at_server,occurred_at,campaign_id,network,country,artifact)
        SELECT logical_event_id,tenant_id,app_id,installation_id,prior_installation_id,install_type,click_id,install_begin_at_server,occurred_at,campaign_id,network,country,artifact FROM jsonb_populate_recordset(NULL::ledger.install_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
      session: `INSERT INTO ledger.session_facts (logical_event_id,tenant_id,app_id,installation_id,session_id,occurred_at,artifact)
        SELECT logical_event_id,tenant_id,app_id,installation_id,session_id,occurred_at,artifact FROM jsonb_populate_recordset(NULL::ledger.session_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
      purchase: `INSERT INTO ledger.purchase_facts (logical_event_id,record_id,tenant_id,app_id,installation_id,transaction_id,original_transaction_id,amount_unscaled,amount_scale,currency,financial_status,occurred_at,artifact)
        SELECT logical_event_id,record_id,tenant_id,app_id,installation_id,transaction_id,original_transaction_id,amount_unscaled,amount_scale,currency,financial_status,occurred_at,artifact FROM jsonb_populate_recordset(NULL::ledger.purchase_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
      refund: `INSERT INTO ledger.refund_facts (logical_event_id,tenant_id,app_id,installation_id,transaction_id,original_transaction_id,correction_target_record_id,amount_unscaled,amount_scale,currency,financial_status,occurred_at,artifact)
        SELECT logical_event_id,tenant_id,app_id,installation_id,transaction_id,original_transaction_id,correction_target_record_id,amount_unscaled,amount_scale,currency,financial_status,occurred_at,artifact FROM jsonb_populate_recordset(NULL::ledger.refund_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
      ad_revenue: `INSERT INTO ledger.ad_revenue_facts (logical_event_id,tenant_id,app_id,installation_id,anchor_source,impression_id,ad_unit_id,ad_network,amount_unscaled,amount_scale,currency,revenue_source,country,occurred_at,artifact)
        SELECT logical_event_id,tenant_id,app_id,installation_id,anchor_source,impression_id,ad_unit_id,ad_network,amount_unscaled,amount_scale,currency,revenue_source,country,occurred_at,artifact FROM jsonb_populate_recordset(NULL::ledger.ad_revenue_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
      custom_event: `INSERT INTO ledger.custom_event_facts (logical_event_id,tenant_id,app_id,installation_id,event_key,artifact)
        SELECT logical_event_id,tenant_id,app_id,installation_id,event_key,artifact FROM jsonb_populate_recordset(NULL::ledger.custom_event_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
      apple_postback: `INSERT INTO ledger.apple_postback_facts (logical_event_id,tenant_id,app_id,event_name,conversion_type,signature_verified,did_win,source_identifier_present,conversion_bucket,received_at,artifact)
        SELECT logical_event_id,tenant_id,app_id,event_name,conversion_type,signature_verified,did_win,source_identifier_present,conversion_bucket,received_at,artifact FROM jsonb_populate_recordset(NULL::ledger.apple_postback_facts,$1::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
    };
const projectionOrder = [...projections.byTable.keys()].sort((left, right) => {
      const priority = (table: string) => table === "purchase" ? 0 : table === "refund" ? 2 : 1;
      return priority(left) - priority(right) || left.localeCompare(right);
    });
for (const table of projectionOrder) {
      await insertJsonRows(client, projections.byTable.get(table) ?? [], projectionStatements[table]);
    }
for (const logical of projections.fallback) await persistProjectionWithClient(client, logical, input);
await insertJsonRows(client, correctionRows, `INSERT INTO ledger.corrections (correction_id,tenant_id,app_id,corrects_record_id,effective_at,artifact)
      SELECT correction_id,tenant_id,app_id,corrects_record_id,effective_at,artifact FROM jsonb_populate_recordset(NULL::ledger.corrections,$1::jsonb)
      ON CONFLICT (correction_id) DO NOTHING`);
await insertJsonRows(client, rejectionRows, `INSERT INTO ledger.rejections (tenant_id,app_id,delivery_id,record_id,reason_code,artifact)
      SELECT tenant_id,app_id,delivery_id,record_id,reason_code,artifact FROM jsonb_populate_recordset(NULL::ledger.rejections,$1::jsonb)`);
await insertJsonRows(client, attributionRows, `INSERT INTO ledger.attribution_results (attribution_id,tenant_id,app_id,subject_scope,subject_ref,effective_at,decided_at,status,method,model,reason_code,artifact)
      SELECT attribution_id,tenant_id,app_id,subject_scope,subject_ref,effective_at,decided_at,status,method,model,reason_code,artifact FROM jsonb_populate_recordset(NULL::ledger.attribution_results,$1::jsonb) ON CONFLICT (attribution_id) DO NOTHING`);
if (selected.fraud_decisions.length > 0) {
      if (!activeRevision) throw new Error("fraud_rule_bundle_revision_mismatch");
      for (const artifact of selected.fraud_decisions) {
        if (artifact.rule_bundle_id !== activeRevision.ruleBundleId
            || artifact.rule_bundle_version !== activeRevision.ruleBundleVersion
            || artifact.rule_bundle_hash !== activeRevision.ruleBundleHash) {
          throw new Error("fraud_rule_bundle_revision_mismatch");
        }
      }
      const fraudRows: Any[] = selected.fraud_decisions.map((artifact) => ({
        ...artifact, tenant_id: attempts[0].server.tenant_id, app_id: attempts[0].server.app_id, artifact,
      }));
      await insertJsonRows(client, fraudRows, `INSERT INTO ledger.fraud_decisions (fraud_decision_id,tenant_id,app_id,subject_ref,subject_scope,rule_id,decision,action,reason_code,evaluated_at,resolution_deadline_at,supersedes_fraud_decision_id,artifact)
        SELECT fraud_decision_id,tenant_id,app_id,subject_ref,subject_scope,rule_id,decision,action,reason_code,evaluated_at,resolution_deadline_at,supersedes_fraud_decision_id,artifact FROM jsonb_populate_recordset(NULL::ledger.fraud_decisions,$1::jsonb) ON CONFLICT (fraud_decision_id) DO NOTHING`);
      await insertJsonRows(client, fraudRows.filter((row) => row.action === "quarantine").map((row) => ({
        fraud_decision_id: row.fraud_decision_id, tenant_id: row.tenant_id, app_id: row.app_id,
        subject_ref: row.subject_ref, resolve_after: row.resolution_deadline_at,
      })), `INSERT INTO ephemeral.fraud_quarantines (fraud_decision_id,tenant_id,app_id,subject_ref,resolve_after)
        SELECT fraud_decision_id,tenant_id,app_id,subject_ref,resolve_after FROM jsonb_populate_recordset(NULL::ephemeral.fraud_quarantines,$1::jsonb) ON CONFLICT (fraud_decision_id) DO NOTHING`);
    }
await insertJsonRows(client, reconciliationRows, `INSERT INTO ledger.reconciliation_results (reconciliation_id,tenant_id,app_id,input_snapshot_id,external_snapshot_id,difference_reason_code,difference_reason_version,freshness,supersedes_reconciliation_id,artifact)
      SELECT reconciliation_id,tenant_id,app_id,input_snapshot_id,external_snapshot_id,difference_reason_code,difference_reason_version,freshness,supersedes_reconciliation_id,artifact FROM jsonb_populate_recordset(NULL::ledger.reconciliation_results,$1::jsonb) ON CONFLICT (reconciliation_id) DO NOTHING`);
}
