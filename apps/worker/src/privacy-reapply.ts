import type { Pool, PoolClient } from "pg";
import { sha256 } from "@openmasu/attribution-core";
import { uuidV7, withTenant, type PayloadStore } from "@openmasu/runtime";
import { computeSqlMetricRunsWithClient, persistMetricRun } from "./metrics/cohort.js";

type Any = Record<string, any>;

export type PrivacyReapplyResult = {
  readonly privacy_requests: number;
  readonly payloads_purged: number;
  readonly metrics_recalculated: number;
  readonly unsupported_metric_runs: number;
};

type CompletedPrivacyRequest = {
  privacy_request_id: string;
  tenant_id: string;
  app_id: string;
  completed_at: string;
  artifact: Any;
};

function affectedRecords(request: CompletedPrivacyRequest): string[] {
  const artifact = request.artifact;
  if (artifact.status !== "completed" || artifact.privacy_request_id !== request.privacy_request_id
      || artifact.tenant_id !== request.tenant_id || artifact.app_id !== request.app_id
      || "deletion_subject_ref" in artifact) {
    throw new Error(`privacy_reapply_artifact_invalid:${request.privacy_request_id}`);
  }
  const values = artifact.affected_records;
  if (!Array.isArray(values)) throw new Error(`privacy_reapply_records_missing:${request.privacy_request_id}`);
  const records = values.map((value: Any) => {
    if (!value || typeof value.record_id !== "string" || value.lifecycle_status !== "purged") {
      throw new Error(`privacy_reapply_record_invalid:${request.privacy_request_id}`);
    }
    return value.record_id;
  });
  return [...new Set(records)].sort();
}

async function encryptedReferences(
  client: PoolClient,
  request: CompletedPrivacyRequest,
  records: readonly string[],
): Promise<string[]> {
  const scope = String(request.artifact.deletion_scope ?? "");
  if (!new Set(["installation", "app", "tenant"]).has(scope)) {
    throw new Error(`privacy_reapply_scope_invalid:${request.privacy_request_id}`);
  }
  const values = scope === "tenant"
    ? [request.tenant_id]
    : scope === "app"
      ? [request.tenant_id, request.app_id]
      : [request.tenant_id, request.app_id, records];
  const recordScope = scope === "tenant"
    ? "raw.tenant_id=$1"
    : scope === "app"
      ? "raw.tenant_id=$1 AND raw.app_id=$2"
      : "raw.tenant_id=$1 AND raw.app_id=$2 AND raw.record_id=ANY($3::text[])";
  const rawSharedReferenceGuard = scope === "installation"
    ? `AND NOT EXISTS (
          SELECT 1 FROM ledger.raw_records AS shared
           WHERE shared.tenant_id=raw.tenant_id
             AND shared.raw_payload_ref=raw.raw_payload_ref
             AND NOT (shared.record_id=ANY($3::text[]))
        )`
    : "";
  const raw = await client.query<{ reference: string }>(
    `SELECT DISTINCT raw.raw_payload_ref AS reference
       FROM ledger.raw_records AS raw
      WHERE ${recordScope} AND raw.raw_payload_ref LIKE 'encrypted:%'
        ${rawSharedReferenceGuard}`,
    values,
  );
  const inboxScope = scope === "tenant"
    ? "inbox.tenant_id=$1"
    : scope === "app"
      ? "inbox.tenant_id=$1 AND inbox.app_id=$2"
      : `inbox.tenant_id=$1 AND inbox.app_id=$2 AND EXISTS (
          SELECT 1 FROM ledger.raw_records AS raw
           WHERE raw.tenant_id=inbox.tenant_id AND raw.app_id=inbox.app_id
             AND raw.producer=inbox.producer AND raw.event_id=inbox.event_id
             AND raw.record_id=ANY($3::text[])
        )`;
  const inbox = await client.query<{ reference: string }>(
    `SELECT DISTINCT inbox.raw_query_ref AS reference
       FROM ledger.ingest_inbox AS inbox
      WHERE ${inboxScope} AND inbox.raw_query_ref LIKE 'encrypted:%'`,
    values,
  );
  const batchScope = scope === "tenant"
    ? "batch.tenant_id=$1"
    : scope === "app"
      ? "batch.tenant_id=$1 AND batch.app_id=$2"
      : `batch.tenant_id=$1 AND batch.app_id=$2
         AND EXISTS (
           SELECT 1 FROM ledger.ingest_batch_records AS affected
            WHERE affected.ingest_batch_id=batch.ingest_batch_id
              AND affected.record_id=ANY($3::text[])
         )
         AND NOT EXISTS (
           SELECT 1 FROM ledger.ingest_batch_records AS shared
            WHERE shared.ingest_batch_id=batch.ingest_batch_id
              AND NOT (shared.record_id=ANY($3::text[]))
         )`;
  const batches = await client.query<{ reference: string }>(
    `SELECT DISTINCT batch.body_ref AS reference
       FROM ledger.ingest_batches AS batch
      WHERE ${batchScope} AND batch.body_ref LIKE 'encrypted:%'`,
    values,
  );
  const resultScope = scope === "tenant"
    ? "result.tenant_id=$1"
    : scope === "app"
      ? "result.tenant_id=$1 AND result.app_id=$2"
      : "result.tenant_id=$1 AND result.app_id=$2 AND result.install_record_id=ANY($3::text[])";
  const results = await client.query<{ reference: string }>(
    `SELECT DISTINCT result.response_ref AS reference
       FROM ledger.adservices_lookup_results AS result
      WHERE ${resultScope} AND result.response_ref LIKE 'encrypted:%'`,
    values,
  );
  const lookupScope = scope === "tenant"
    ? "lookup.tenant_id=$1"
    : scope === "app"
      ? "lookup.tenant_id=$1 AND lookup.app_id=$2"
      : "lookup.tenant_id=$1 AND lookup.app_id=$2 AND lookup.install_record_id=ANY($3::text[])";
  const lookups = await client.query<{ reference: string }>(
    `SELECT DISTINCT lookup.token_ref AS reference
       FROM ephemeral.adservices_lookups AS lookup
      WHERE ${lookupScope} AND lookup.token_ref LIKE 'encrypted:%'`,
    values,
  );
  return [...new Set([
    ...raw.rows, ...inbox.rows, ...batches.rows, ...results.rows, ...lookups.rows,
  ].map((row) => row.reference))].sort();
}

async function purgeAndVerify(payloadStore: PayloadStore, references: readonly string[]): Promise<void> {
  for (const reference of references) {
    await payloadStore.purge(reference);
    let readable = false;
    try {
      await payloadStore.read(reference);
      readable = true;
    } catch {
      // The required postcondition is unreadability, including an already absent object.
    }
    if (readable) throw new Error("privacy_reapply_payload_still_readable");
  }
}

async function appendPrivacyArtifacts(
  client: PoolClient,
  request: CompletedPrivacyRequest,
  records: readonly string[],
): Promise<void> {
  for (const recordId of records) {
    const tombstoneId = `tombstone:${request.privacy_request_id}:${recordId}`;
    const tombstone = {
      contract_version: "0.4.0",
      tenant_id: request.tenant_id,
      app_id: request.app_id,
      privacy_request_id: request.privacy_request_id,
      record_id: recordId,
      lifecycle_status: "purged",
      reason_code: "privacy_deletion",
      policy_version: "privacy-v0.2",
      provenance_digest: sha256([request.privacy_request_id, recordId, request.completed_at]),
      created_at: request.completed_at,
    };
    await client.query(
      `INSERT INTO ledger.raw_payload_states (
        tenant_id, app_id, record_id, lifecycle_status, changed_at,
        privacy_request_id, privacy_tombstone_id
      ) VALUES ($1,$2,$3,'purged',$4,$5,$6)
      ON CONFLICT (record_id, lifecycle_status) DO NOTHING`,
      [request.tenant_id, request.app_id, recordId, request.completed_at, request.privacy_request_id, tombstoneId],
    );
    await client.query(
      `INSERT INTO ledger.privacy_tombstones (
        tenant_id, app_id, privacy_request_id, record_id, lifecycle_status, created_at, artifact
      ) VALUES ($1,$2,$3,$4,'purged',$5,$6::jsonb)
      ON CONFLICT DO NOTHING`,
      [request.tenant_id, request.app_id, request.privacy_request_id, recordId,
        request.completed_at, JSON.stringify(tombstone)],
    );
    const correction = {
      contract_version: "0.4.0",
      tenant_id: request.tenant_id,
      app_id: request.app_id,
      correction_id: `correction:${sha256([request.privacy_request_id, recordId]).slice(0, 48)}`,
      corrects_record_id: recordId,
      correction_type: "redaction",
      correction_reason: "privacy_deletion",
      effective_at: request.completed_at,
    };
    await client.query(
      `INSERT INTO ledger.corrections (
        correction_id, tenant_id, app_id, corrects_record_id, effective_at, artifact
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
      [correction.correction_id, request.tenant_id, request.app_id, recordId,
        request.completed_at, JSON.stringify(correction)],
    );
  }
}

async function recalculateMetrics(
  client: PoolClient,
  request: CompletedPrivacyRequest,
  records: ReadonlySet<string>,
): Promise<{ recalculated: number; unsupported: number }> {
  const manifests = await client.query<{ artifact: Any; source_artifact: Any }>(
    `SELECT manifest.artifact, source.artifact AS source_artifact
       FROM control.metric_replay_manifests AS manifest
       JOIN ledger.metric_runs AS source ON source.metric_run_id=manifest.source_metric_run_id
      WHERE manifest.tenant_id=$1 AND manifest.app_id=$2
      ORDER BY manifest.source_metric_run_id`,
    [request.tenant_id, request.app_id],
  );
  const affected = manifests.rows.filter((row) => (row.source_artifact.evidence_refs ?? [])
    .some((reference: Any) => records.has(String(reference.ref))));
  let recalculated = 0;
  for (const row of affected) {
    const sourceId = String(row.artifact.source_metric_run_id);
    const replacementId = `privacy-reapply:${sha256([request.privacy_request_id, sourceId]).slice(0, 48)}`;
    const existing = await client.query<{ artifact: Any }>(
      "SELECT artifact FROM ledger.metric_runs WHERE metric_run_id=$1",
      [replacementId],
    );
    if (existing.rowCount === 1) {
      recalculated += 1;
      continue;
    }
    const directSuccessor = await client.query<{ metric_run_id: string }>(
      `SELECT metric_run_id FROM ledger.metric_runs
        WHERE tenant_id=$1 AND app_id=$2 AND supersedes_metric_run_id=$3
        ORDER BY computed_at DESC, metric_run_id DESC LIMIT 1`,
      [request.tenant_id, request.app_id, sourceId],
    );
    const evaluation = {
      ...row.artifact.evaluation,
      metric_run_id_prefix: "privacy-reapply-candidate",
      supersedes_metric_run_id_prefix: undefined,
      metric_names: [row.artifact.metric_definition.metric_name],
      privacy_state: "after",
      computed_at: request.completed_at,
      data_freshness: "recalculated",
    };
    const output = await computeSqlMetricRunsWithClient(client, {
      server_context: { tenant_id: request.tenant_id, app_id: request.app_id },
      records: [{}],
      fx_policy: row.artifact.fx_policy,
      metric_definitions: [row.artifact.metric_definition],
      metric_evaluations: [evaluation],
    }, false);
    if (output.length !== 1) throw new Error(`privacy_reapply_metric_output_invalid:${sourceId}`);
    const replacement = {
      ...output[0],
      metric_run_id: replacementId,
      supersedes_metric_run_id: directSuccessor.rows[0]?.metric_run_id ?? sourceId,
    };
    await persistMetricRun(client, { tenant_id: request.tenant_id, app_id: request.app_id }, replacement);
    recalculated += 1;
  }
  const affectedRunCount = await client.query<{ count: string }>(
    `SELECT count(DISTINCT run.metric_run_id)::text AS count
       FROM ledger.metric_runs AS run,
            jsonb_array_elements(COALESCE(run.artifact->'evidence_refs', '[]'::jsonb)) AS evidence
      WHERE run.tenant_id=$1 AND run.app_id=$2
        AND evidence->>'ref'=ANY($3::text[])
        AND run.computed_at < $4
        AND NOT EXISTS (
          SELECT 1 FROM control.metric_replay_manifests AS manifest
           WHERE manifest.tenant_id=run.tenant_id AND manifest.app_id=run.app_id
             AND manifest.source_metric_run_id=run.metric_run_id
        )`,
    [request.tenant_id, request.app_id, [...records], request.completed_at],
  );
  return { recalculated, unsupported: Number(affectedRunCount.rows[0]?.count ?? "0") };
}

async function reapplyOne(
  client: PoolClient,
  payloadStore: PayloadStore,
  request: CompletedPrivacyRequest,
): Promise<Omit<PrivacyReapplyResult, "privacy_requests">> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [request.privacy_request_id]);
  const records = affectedRecords(request);
  const references = await encryptedReferences(client, request, records);
  await purgeAndVerify(payloadStore, references);
  await appendPrivacyArtifacts(client, request, records);
  const scope = String(request.artifact.deletion_scope ?? "");
  await client.query(
    `DELETE FROM ephemeral.adservices_lookups
      WHERE tenant_id=$1
        AND ($2='tenant' OR ($2='app' AND app_id=$3)
          OR ($2='installation' AND app_id=$3 AND install_record_id=ANY($4::text[])))`,
    [request.tenant_id, scope, request.app_id, records],
  );
  const metrics = await recalculateMetrics(client, request, new Set(records));
  const priorAudit = await client.query(
    `SELECT 1 FROM ledger.audit_logs
      WHERE tenant_id=$1 AND action='privacy_reapply'
        AND target_scope='privacy_request' AND target_ref=$2 LIMIT 1`,
    [request.tenant_id, request.privacy_request_id],
  );
  if (priorAudit.rowCount === 0) {
    await client.query(
      `INSERT INTO ledger.audit_logs (
        audit_log_id, tenant_id, app_id, occurred_at, actor_type, actor_ref,
        action, target_scope, target_ref, policy_version, request_digest,
        outcome, reason_code
      ) VALUES ($1,$2,$3,$4,'system_job','system:privacy-reapply','privacy_reapply',
        'privacy_request',$5,'privacy-reapply-v1',$6,'succeeded',NULL)`,
      [uuidV7(), request.tenant_id, request.app_id, request.completed_at,
        request.privacy_request_id, sha256([request.privacy_request_id, records, references])],
    );
  }
  return {
    payloads_purged: references.length,
    metrics_recalculated: metrics.recalculated,
    unsupported_metric_runs: metrics.unsupported,
  };
}

export async function reapplyCompletedPrivacyRequests(input: {
  readonly pool: Pool;
  readonly payloadStore: PayloadStore;
  readonly tenantId: string;
}): Promise<PrivacyReapplyResult> {
  return withTenant(input.pool, input.tenantId, async (client) => {
    const requests = await client.query<CompletedPrivacyRequest>(
      `SELECT privacy_request_id, tenant_id, app_id, completed_at, artifact
         FROM ledger.privacy_requests
        WHERE tenant_id=$1 AND status='completed' AND completed_at IS NOT NULL
        ORDER BY completed_at, privacy_request_id`,
      [input.tenantId],
    );
    const total: {
      privacy_requests: number;
      payloads_purged: number;
      metrics_recalculated: number;
      unsupported_metric_runs: number;
    } = {
      privacy_requests: requests.rows.length,
      payloads_purged: 0,
      metrics_recalculated: 0,
      unsupported_metric_runs: 0,
    };
    for (const request of requests.rows) {
      const result = await reapplyOne(client, input.payloadStore, request);
      total.payloads_purged += result.payloads_purged;
      total.metrics_recalculated += result.metrics_recalculated;
      total.unsupported_metric_runs += result.unsupported_metric_runs;
    }
    return total;
  });
}
