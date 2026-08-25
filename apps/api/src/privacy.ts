import type { Pool } from "pg";
import { sha256 } from "@openmasu/attribution-core";
import { uuidV7, withTenant, type PayloadStore } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";

type Any = Record<string, any>;
export type PrivacyRequestBody = {
  tenant_id: string;
  app_id: string;
  requested_via: "tenant_admin_api" | "on_device_sdk";
  deletion_scope: "installation" | "app" | "tenant";
  deletion_subject_ref: string;
};

export type PrivacyIdentity = {
  tenantId: string;
  appId: string;
  actorType: "admin_key" | "sdk_installation";
  actorRef: string;
  requesterAuthRef: string;
  installationKeyId?: string;
  deletionSubjectDigest?: string;
};

function currentTimestamp(now?: Date): string { return (now ?? new Date()).toISOString(); }

async function affectedRecordIds(client: any, body: PrivacyRequestBody): Promise<string[]> {
  if (body.deletion_scope !== "installation") {
    const result = await client.query(
      `SELECT record_id FROM ledger.raw_records
       WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
       ORDER BY record_id`,
      [body.tenant_id, body.deletion_scope, body.app_id],
    );
    return result.rows.map((row: Any) => row.record_id);
  }
  const result = await client.query(
    `SELECT DISTINCT logical.record_id
     FROM ledger.logical_events AS logical
     LEFT JOIN ledger.install_facts AS install USING (logical_event_id, tenant_id, app_id)
     LEFT JOIN ledger.session_facts AS session USING (logical_event_id, tenant_id, app_id)
     LEFT JOIN ledger.purchase_facts AS purchase USING (logical_event_id, tenant_id, app_id)
     LEFT JOIN ledger.ad_revenue_facts AS revenue USING (logical_event_id, tenant_id, app_id)
     LEFT JOIN ledger.custom_event_facts AS custom USING (logical_event_id, tenant_id, app_id)
     WHERE logical.tenant_id=$1 AND logical.app_id=$2
       AND COALESCE(install.installation_id, session.installation_id, purchase.installation_id, revenue.installation_id, custom.installation_id)=$3
     ORDER BY logical.record_id`,
    [body.tenant_id, body.app_id, body.deletion_subject_ref],
  );
  return result.rows.map((row: Any) => row.record_id);
}

export async function executePrivacyRequest(
  pool: Pool,
  identity: AppAdminIdentity | PrivacyIdentity,
  body: PrivacyRequestBody,
  payloadStore: PayloadStore,
  now?: Date,
): Promise<Any> {
  if (body.requested_via === "on_device_sdk"
    && (!("actorType" in identity) || identity.actorType !== "sdk_installation")) {
    const error = new Error("on_device_path_not_implemented");
    (error as Any).statusCode = 501;
    throw error;
  }
  if (body.requested_via === "tenant_admin_api" && "actorType" in identity) {
    const error = new Error("tenant_admin_path_requires_admin_auth");
    (error as Any).statusCode = 403;
    throw error;
  }
  if (identity.tenantId !== body.tenant_id || identity.appId !== body.app_id) {
    const error = new Error("requester_scope_mismatch");
    (error as Any).statusCode = 403;
    throw error;
  }
  const completedAt = currentTimestamp(now);
  const requestId = `privacy:${uuidV7(now?.valueOf())}`;
  return withTenant(pool, body.tenant_id, async (client) => {
    const records = await affectedRecordIds(client, body);
    const payloads = body.deletion_scope === "installation"
      ? await client.query<{ raw_query_ref: string }>(
          `SELECT DISTINCT inbox.raw_query_ref
           FROM ledger.ingest_inbox AS inbox
           JOIN ledger.raw_records AS raw
             ON raw.tenant_id=inbox.tenant_id AND raw.app_id=inbox.app_id
            AND raw.producer=inbox.producer AND raw.event_id=inbox.event_id
           WHERE inbox.tenant_id=$1 AND inbox.app_id=$2 AND raw.record_id=ANY($3::text[])
           ORDER BY inbox.raw_query_ref`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{ raw_query_ref: string }>(
          `SELECT raw_query_ref FROM ledger.ingest_inbox
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
           ORDER BY inbox_id`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const rawPayloads = body.deletion_scope === "installation"
      ? await client.query<{ raw_payload_ref: string }>(
          `SELECT DISTINCT raw.raw_payload_ref
             FROM ledger.raw_records AS raw
            WHERE raw.tenant_id=$1 AND raw.app_id=$2
              AND raw.record_id=ANY($3::text[])
              AND raw.raw_payload_ref LIKE 'encrypted:%'
              AND NOT EXISTS (
                SELECT 1 FROM ledger.raw_records AS shared
                 WHERE shared.tenant_id=raw.tenant_id
                   AND shared.raw_payload_ref=raw.raw_payload_ref
                   AND NOT (shared.record_id=ANY($3::text[]))
              )
            ORDER BY raw.raw_payload_ref`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{ raw_payload_ref: string }>(
          `SELECT DISTINCT raw_payload_ref FROM ledger.raw_records
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
             AND raw_payload_ref LIKE 'encrypted:%'
           ORDER BY raw_payload_ref`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const installationKeyId = "installationKeyId" in identity ? identity.installationKeyId : undefined;
    const batchPayloads = body.deletion_scope === "installation"
      ? await client.query<{ body_ref: string }>(
          `SELECT DISTINCT batch.body_ref
           FROM ledger.ingest_batches AS batch
           LEFT JOIN ledger.ingest_batch_records AS member
             ON member.ingest_batch_id=batch.ingest_batch_id
            AND member.tenant_id=batch.tenant_id AND member.app_id=batch.app_id
           WHERE batch.tenant_id=$1 AND batch.app_id=$2
             AND (member.record_id=ANY($3::text[]) OR batch.installation_key_id=$4)
             AND NOT EXISTS (
               SELECT 1 FROM ledger.ingest_batch_records AS shared
                WHERE shared.ingest_batch_id=batch.ingest_batch_id
                  AND NOT (shared.record_id=ANY($3::text[]))
             )
           ORDER BY batch.body_ref`,
          [body.tenant_id, body.app_id, records, installationKeyId ?? null],
        )
      : await client.query<{ body_ref: string }>(
          `SELECT body_ref FROM ledger.ingest_batches
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
           ORDER BY inbox_seq`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const adServicesPayloads = body.deletion_scope === "installation"
      ? await client.query<{ response_ref: string }>(
          `SELECT response_ref FROM ledger.adservices_lookup_results
           WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=ANY($3::text[])
           ORDER BY response_ref`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{ response_ref: string }>(
          `SELECT response_ref FROM ledger.adservices_lookup_results
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
           ORDER BY response_ref`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    const pendingAdServicesPayloads = body.deletion_scope === "installation"
      ? await client.query<{ token_ref: string }>(
          `SELECT token_ref FROM ephemeral.adservices_lookups
           WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=ANY($3::text[])
           ORDER BY token_ref`,
          [body.tenant_id, body.app_id, records],
        )
      : await client.query<{ token_ref: string }>(
          `SELECT token_ref FROM ephemeral.adservices_lookups
           WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)
           ORDER BY token_ref`,
          [body.tenant_id, body.deletion_scope, body.app_id],
        );
    for (const reference of new Set([
      ...rawPayloads.rows.map((payload) => payload.raw_payload_ref),
      ...payloads.rows.map((payload) => payload.raw_query_ref),
      ...batchPayloads.rows.map((payload) => payload.body_ref),
      ...adServicesPayloads.rows.map((payload) => payload.response_ref),
      ...pendingAdServicesPayloads.rows.map((payload) => payload.token_ref),
    ])) await payloadStore.purge(reference);
    if (body.deletion_scope === "installation") {
      await client.query(
        `DELETE FROM ephemeral.adservices_lookups
         WHERE tenant_id=$1 AND app_id=$2 AND install_record_id=ANY($3::text[])`,
        [body.tenant_id, body.app_id, records],
      );
    } else {
      await client.query(
        `DELETE FROM ephemeral.adservices_lookups
         WHERE tenant_id=$1 AND ($2='tenant' OR app_id=$3)`,
        [body.tenant_id, body.deletion_scope, body.app_id],
      );
    }
    const subjectDigest = "deletionSubjectDigest" in identity && identity.deletionSubjectDigest
      ? identity.deletionSubjectDigest
      : sha256([body.tenant_id, body.app_id, body.deletion_scope, body.deletion_subject_ref]);
    const artifact = {
      contract_version: "0.4.0",
      tenant_id: body.tenant_id,
      app_id: body.app_id,
      privacy_request_id: requestId,
      deletion_subject_digest: subjectDigest,
      deletion_scope: body.deletion_scope,
      requested_via: body.requested_via,
      requester_auth_ref: "requesterAuthRef" in identity ? identity.requesterAuthRef : `admin_key:${identity.keyId}`,
      requested_at: completedAt,
      completed_at: completedAt,
      status: "completed",
      reason_code: "privacy_deletion",
      policy_version: "privacy-v0.2",
      affected_records: records.map((record_id) => ({ record_id, lifecycle_status: "purged" })),
    };
    await client.query(
      `INSERT INTO ledger.privacy_requests (
        privacy_request_id, tenant_id, app_id, requested_at, completed_at, status, artifact
      ) VALUES ($1,$2,$3,$4,$4,'completed',$5::jsonb)`,
      [requestId, body.tenant_id, body.app_id, completedAt, JSON.stringify(artifact)],
    );
    for (const recordId of records) {
      const tombstone = {
        contract_version: "0.4.0", tenant_id: body.tenant_id, app_id: body.app_id,
        privacy_request_id: requestId, record_id: recordId, lifecycle_status: "purged",
        reason_code: "privacy_deletion", policy_version: "privacy-v0.2",
        provenance_digest: sha256([requestId, recordId, completedAt]), created_at: completedAt,
      };
      await client.query(
        `INSERT INTO ledger.raw_payload_states (
          tenant_id, app_id, record_id, lifecycle_status, changed_at, privacy_request_id,
          privacy_tombstone_id
        ) VALUES ($1,$2,$3,'purged',$4,$5,$6)
        ON CONFLICT (record_id, lifecycle_status) DO NOTHING`,
        [body.tenant_id, body.app_id, recordId, completedAt, requestId, `tombstone:${requestId}:${recordId}`],
      );
      await client.query(
        `INSERT INTO ledger.privacy_tombstones (
          tenant_id, app_id, privacy_request_id, record_id, lifecycle_status, created_at, artifact
        ) VALUES ($1,$2,$3,$4,'purged',$5,$6::jsonb)
        ON CONFLICT DO NOTHING`,
        [body.tenant_id, body.app_id, requestId, recordId, completedAt, JSON.stringify(tombstone)],
      );
      const correction = {
        contract_version: "0.4.0", tenant_id: body.tenant_id, app_id: body.app_id,
        correction_id: `correction:${sha256([requestId, recordId]).slice(0, 48)}`,
        corrects_record_id: recordId, correction_type: "redaction",
        correction_reason: "privacy_deletion", effective_at: completedAt,
      };
      await client.query(
        `INSERT INTO ledger.corrections (
          correction_id, tenant_id, app_id, corrects_record_id, effective_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
        [correction.correction_id, body.tenant_id, body.app_id, recordId, completedAt, JSON.stringify(correction)],
      );
    }
    const previousRuns = await client.query<Any>(
      `SELECT artifact FROM ledger.metric_runs
       WHERE tenant_id=$1 AND app_id=$2 AND metric_name IN (
         'd0_install_to_24h_ad_revenue_usd',
         'd0_utc_install_calendar_ad_revenue_usd',
         'd0_jst_install_calendar_ad_revenue_usd'
       ) ORDER BY metric_name, computed_at DESC`,
      [body.tenant_id, body.app_id],
    );
    const seen = new Set<string>();
    for (const row of previousRuns.rows) {
      const prior = row.artifact;
      if (seen.has(prior.metric_name)) continue;
      seen.add(prior.metric_name);
      const replacement = {
        ...prior,
        metric_run_id: `metric:${sha256([requestId, prior.metric_run_id]).slice(0, 48)}`,
        input_snapshot_id: sha256([prior.input_snapshot_id, requestId, records]),
        computed_at: completedAt,
        data_freshness: "recalculated",
        reproducibility_status: "redaction_affected",
        supersedes_metric_run_id: prior.metric_run_id,
      };
      await client.query(
        `INSERT INTO ledger.metric_runs (
          metric_run_id, tenant_id, app_id, metric_name, metric_definition_version,
          grouping, grouping_digest, input_snapshot_id, input_received_at_watermark,
          input_ledger_position, computed_at, data_freshness, aggregation_time_zone,
          rule_bundle_id, rule_bundle_version, rule_bundle_hash, fx_rate_unscaled,
          fx_rate_scale, fx_rate_source, fx_rate_as_of, fx_rate_snapshot_id,
          fx_policy_version, rounding_mode, reproducibility_status, value_type,
          value_state, undefined_reason, value_unscaled, amount_scale, currency,
          supersedes_metric_run_id, artifact
        ) VALUES (
          $1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
          $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32::jsonb
        ) ON CONFLICT DO NOTHING`,
        [replacement.metric_run_id, body.tenant_id, body.app_id, replacement.metric_name,
          replacement.metric_definition_version, JSON.stringify(replacement.grouping?.dimensions ?? {}),
          replacement.grouping?.dimension_digest ?? sha256({}), replacement.input_snapshot_id,
          replacement.input_received_at_watermark, replacement.input_ledger_position,
          replacement.computed_at, replacement.data_freshness, replacement.aggregation_time_zone,
          replacement.rule_bundle_id, replacement.rule_bundle_version, replacement.rule_bundle_hash,
          replacement.fx_rate_unscaled ?? null, replacement.fx_rate_scale ?? null,
          replacement.fx_rate_source ?? null, replacement.fx_rate_as_of ?? null,
          replacement.fx_rate_snapshot_id ?? null, replacement.fx_policy_version ?? null,
          replacement.rounding_mode, replacement.reproducibility_status, replacement.value_type,
          replacement.value_state ?? "present", replacement.undefined_reason ?? null,
          replacement.value_unscaled ?? null, replacement.amount_scale ?? null, replacement.currency ?? null,
          replacement.supersedes_metric_run_id, JSON.stringify(replacement)],
      );
    }
    await client.query(
      `INSERT INTO ledger.audit_logs (
        audit_log_id, tenant_id, app_id, occurred_at, actor_type, actor_ref,
        action, target_scope, target_ref, policy_version, request_digest,
        outcome, reason_code
      ) VALUES ($1,$2,$3,$4,$5,$6,'privacy_delete','privacy_request',$7,
        'privacy-v0.2',$8,'succeeded',NULL)`,
      [uuidV7(), body.tenant_id, body.app_id, completedAt,
        "actorType" in identity ? identity.actorType : "admin_key",
        "actorRef" in identity ? identity.actorRef : `admin_key:${identity.keyId}`,
        requestId, sha256(body)],
    );
    return artifact;
  });
}
