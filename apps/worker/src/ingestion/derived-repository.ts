import type { PoolClient } from "pg";
import { fraudBundleHash, sha256Jcs, type FraudBundle } from "@openmasu/fraud-rules";
import { storedArtifact } from "./record-repository.js";
import type { Any, Attribution, FraudDecision, Reconciliation } from "./model.js";

export async function persistAttributionWithClient(
  client: PoolClient,
  artifact: Attribution,
): Promise<Any> {
return storedArtifact(
    client,
    `INSERT INTO ledger.attribution_results (
      attribution_id, tenant_id, app_id, subject_scope, subject_ref, effective_at,
      decided_at, status, method, model, reason_code, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
    ON CONFLICT (attribution_id) DO NOTHING RETURNING artifact`,
    [
      artifact.attribution_id, artifact.tenant_id, artifact.app_id, artifact.subject_scope,
      artifact.subject_ref ?? null, artifact.effective_at, artifact.decided_at, artifact.status,
      artifact.method, artifact.model, artifact.reason_code, JSON.stringify(artifact),
    ],
    "SELECT artifact FROM ledger.attribution_results WHERE attribution_id = $1",
    [artifact.attribution_id],
  );
}

export async function persistFraudWithClient(
  client: PoolClient,
  artifact: FraudDecision,
  scope: { tenant_id: string; app_id: string },
  expectedRevisionId?: string,
): Promise<Any> {
const revision = await client.query<{
      rule_bundle_revision_id: string;
      rule_bundle_id: string;
      rule_bundle_version: string;
      rule_bundle_hash: string;
      definition: FraudBundle | null;
      definition_digest: string | null;
    }>(
      `SELECT rule_bundle_revision_id,rule_bundle_id,rule_bundle_version,rule_bundle_hash,
              definition,definition_digest
         FROM control.rule_bundle_revisions
        WHERE tenant_id=$1 AND app_id=$2
          AND ($3::text IS NULL OR rule_bundle_revision_id=$3)
          AND rule_bundle_id=$4 AND rule_bundle_version=$5 AND rule_bundle_hash=$6
        ORDER BY activated_at DESC,rule_bundle_revision_id DESC
        LIMIT 2`,
      [scope.tenant_id, scope.app_id, expectedRevisionId ?? null,
        artifact.rule_bundle_id, artifact.rule_bundle_version, artifact.rule_bundle_hash],
    );
if (revision.rows.length !== 1) throw new Error("fraud_rule_bundle_revision_mismatch");
const bound = revision.rows[0];
if (!bound.definition || !bound.definition_digest
      || sha256Jcs(bound.definition) !== bound.definition_digest
      || fraudBundleHash(bound.definition) !== bound.rule_bundle_hash) {
      throw new Error("fraud_rule_bundle_definition_mismatch");
    }
const stored = await storedArtifact(
      client,
      `INSERT INTO ledger.fraud_decisions (
      fraud_decision_id, tenant_id, app_id, subject_ref, subject_scope, rule_id,
      decision, action, reason_code, evaluated_at, resolution_deadline_at,
      supersedes_fraud_decision_id, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
    ON CONFLICT (fraud_decision_id) DO NOTHING RETURNING artifact`,
      [artifact.fraud_decision_id, scope.tenant_id, scope.app_id, artifact.subject_ref,
        artifact.subject_scope ?? "record", artifact.rule_id ?? null, artifact.decision,
        artifact.action, artifact.reason_code, artifact.evaluated_at,
        artifact.resolution_deadline_at ?? null, artifact.supersedes_fraud_decision_id ?? null,
        JSON.stringify(artifact)],
      "SELECT artifact FROM ledger.fraud_decisions WHERE fraud_decision_id = $1",
      [artifact.fraud_decision_id],
    );
if (artifact.action === "quarantine") {
      await client.query(
        `INSERT INTO ephemeral.fraud_quarantines (
          fraud_decision_id,tenant_id,app_id,subject_ref,resolve_after
        ) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (fraud_decision_id) DO NOTHING`,
        [artifact.fraud_decision_id, scope.tenant_id, scope.app_id,
          artifact.subject_ref, artifact.resolution_deadline_at],
      );
    }
return stored;
}

export async function persistReconciliationWithClient(client: PoolClient, artifact: Reconciliation): Promise<Any> {
return storedArtifact(
    client,
    `INSERT INTO ledger.reconciliation_results (
      reconciliation_id, tenant_id, app_id, input_snapshot_id, external_snapshot_id,
      difference_reason_code, difference_reason_version, freshness,
      supersedes_reconciliation_id, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT (reconciliation_id) DO NOTHING RETURNING artifact`,
    [
      artifact.reconciliation_id, artifact.tenant_id, artifact.app_id,
      artifact.input_snapshot_id, artifact.external_snapshot_id,
      artifact.difference_reason_code, artifact.difference_reason_version,
      artifact.freshness, artifact.supersedes_reconciliation_id ?? null,
      JSON.stringify(artifact),
    ],
    "SELECT artifact FROM ledger.reconciliation_results WHERE reconciliation_id=$1",
    [artifact.reconciliation_id],
  );
}
