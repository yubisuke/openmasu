import { createHash } from "node:crypto";
import { constants as zlibConstants, gzipSync } from "node:zlib";
import type { Pool, PoolClient } from "pg";
import {
  putS3Object,
  recordJobOutcome,
  uuidV7,
  withTenant,
  type PayloadStore,
  type S3Credentials,
  type WebhookLookup,
} from "@openmasu/runtime";
import { buildOperatorEvent, type OperatorWebhookCandidate } from "./operator-webhook-worker.js";

export type OperatorBulkEventCandidate = OperatorWebhookCandidate & Readonly<{
  received_at: string;
}>;

export type OperatorBulkDeletionCandidate = Readonly<{
  deletion_seq: string;
  app_id: string;
  subject_ref: string;
  recognized_at: string;
}>;

export type OperatorBulkCursor = Readonly<{
  event_received_at: string | null;
  event_record_id: string | null;
  deletion_seq: string;
}>;

export type OperatorBulkExportRow =
  | Readonly<{
    schema: "openmasu.operator_event_export.v1";
    record_kind: "event";
    app_id: string;
    event: ReturnType<typeof buildOperatorEvent>;
  }>
  | Readonly<{
    schema: "openmasu.operator_event_export.v1";
    record_kind: "privacy_deletion";
    app_id: string;
    subject_ref: string;
    recognized_at: string;
  }>;

export type OperatorBulkManifest = Readonly<{
  schema: "openmasu.operator_event_export_manifest.v1";
  export_id: string;
  destination_id: string;
  app_id: string;
  generated_at: string;
  content_encoding: "gzip";
  content_type: "application/x-ndjson";
  row_count: number;
  row_content_sha256: string;
  cursor_before: OperatorBulkCursor;
  cursor_after: OperatorBulkCursor;
}>;

export type PreparedOperatorBulkExport = Readonly<{
  exportId: string;
  objectKey: string;
  manifest: OperatorBulkManifest;
  body: Buffer;
  bodyDigest: string;
  rows: readonly OperatorBulkExportRow[];
}>;

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function canonicalTimestamp(value: string, error: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) throw new Error(error);
  return value;
}

function safePathPart(value: string, error: string): string {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error(error);
  return value.replace(/:/g, "_");
}

export function buildOperatorBulkRows(input: Readonly<{
  events: readonly OperatorBulkEventCandidate[];
  deletions: readonly OperatorBulkDeletionCandidate[];
  referenceSecret: Buffer;
}>): readonly OperatorBulkExportRow[] {
  if (input.referenceSecret.length < 32) throw new Error("operator_bulk_reference_secret_invalid");
  const events = [...input.events]
    .sort((left, right) => left.received_at.localeCompare(right.received_at, "en")
      || left.record_id.localeCompare(right.record_id, "en"))
    .map((candidate): OperatorBulkExportRow => ({
      schema: "openmasu.operator_event_export.v1",
      record_kind: "event",
      app_id: candidate.app_id,
      event: buildOperatorEvent(candidate, input.referenceSecret),
    }));
  const deletions = [...input.deletions]
    .sort((left, right) => BigInt(left.deletion_seq) < BigInt(right.deletion_seq) ? -1 : 1)
    .map((candidate): OperatorBulkExportRow => ({
      schema: "openmasu.operator_event_export.v1",
      record_kind: "privacy_deletion",
      app_id: candidate.app_id,
      subject_ref: candidate.subject_ref,
      recognized_at: canonicalTimestamp(candidate.recognized_at, "operator_bulk_deletion_time_invalid"),
    }));
  return [...deletions, ...events];
}

export function prepareOperatorBulkExport(input: Readonly<{
  exportId: string;
  destinationId: string;
  appId: string;
  objectPrefix: string;
  generatedAt: string;
  cursorBefore: OperatorBulkCursor;
  cursorAfter: OperatorBulkCursor;
  rows: readonly OperatorBulkExportRow[];
}>): PreparedOperatorBulkExport {
  if (input.rows.length < 1 || input.rows.length > 10_000) throw new Error("operator_bulk_row_count_invalid");
  const generatedAt = canonicalTimestamp(input.generatedAt, "operator_bulk_generated_at_invalid");
  const rowLines = input.rows.map((row) => JSON.stringify(row));
  const rowBytes = Buffer.from(`${rowLines.join("\n")}\n`, "utf8");
  const manifest: OperatorBulkManifest = {
    schema: "openmasu.operator_event_export_manifest.v1",
    export_id: input.exportId,
    destination_id: input.destinationId,
    app_id: input.appId,
    generated_at: generatedAt,
    content_encoding: "gzip",
    content_type: "application/x-ndjson",
    row_count: input.rows.length,
    row_content_sha256: sha256(rowBytes),
    cursor_before: input.cursorBefore,
    cursor_after: input.cursorAfter,
  };
  const ndjson = Buffer.from(`${JSON.stringify(manifest)}\n${rowLines.join("\n")}\n`, "utf8");
  const body = gzipSync(ndjson, {
    level: zlibConstants.Z_BEST_COMPRESSION,
    mtime: 0,
  } as Parameters<typeof gzipSync>[1]);
  const date = generatedAt.slice(0, 10);
  const prefix = input.objectPrefix.replace(/^\/+|\/+$/g, "");
  if (prefix.length > 512 || prefix.split("/").some((part) => !/^[A-Za-z0-9._=-]{1,128}$/.test(part))) {
    throw new Error("operator_bulk_object_prefix_invalid");
  }
  const objectKey = [
    ...(prefix ? [prefix] : []),
    `date=${date}`,
    `${safePathPart(input.destinationId, "operator_bulk_destination_invalid")}-${safePathPart(input.exportId, "operator_bulk_export_id_invalid")}.ndjson.gz`,
  ].join("/");
  return { exportId: input.exportId, objectKey, manifest, body, bodyDigest: sha256(body), rows: input.rows };
}

type DestinationRow = Readonly<{
  destination_id: string;
  app_id: string;
  endpoint_url: string;
  bucket_name: string;
  object_prefix: string;
  region: string;
  credential_ref: string;
  credential_digest: string;
  reference_secret_ref: string;
  status: "active" | "disabled";
  event_received_at: string | null;
  event_record_id: string | null;
  deletion_seq: string;
}>;

type BatchRow = DestinationRow & Readonly<{
  batch_id: string;
  object_key: string;
  object_ref: string;
  object_digest: string;
  attempts: number;
  event_received_at_before: string | null;
  event_record_id_before: string | null;
  event_received_at_after: string | null;
  event_record_id_after: string | null;
  deletion_seq_before: string;
  deletion_seq_after: string;
}>;

function parseCredentials(value: Buffer, expectedDigest: string): S3Credentials {
  if (sha256(value) !== expectedDigest) throw new Error("operator_bulk_credential_digest_mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(value.toString("utf8")); } catch { throw new Error("operator_bulk_credentials_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("operator_bulk_credentials_invalid");
  const credentials = parsed as Record<string, unknown>;
  if (typeof credentials.access_key_id !== "string" || typeof credentials.secret_access_key !== "string"
    || (credentials.session_token !== undefined && typeof credentials.session_token !== "string")) {
    throw new Error("operator_bulk_credentials_invalid");
  }
  return {
    accessKeyId: credentials.access_key_id,
    secretAccessKey: credentials.secret_access_key,
    ...(credentials.session_token ? { sessionToken: credentials.session_token } : {}),
  };
}

async function lockDestination(client: PoolClient, tenantId: string, appId: string, destinationId: string): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('openmasu:operator-bulk-destination:' || $1 || ':' || $2 || ':' || $3,0))",
    [tenantId, appId, destinationId],
  );
}

async function appendResult(
  client: PoolClient,
  tenantId: string,
  row: Pick<BatchRow, "batch_id" | "app_id" | "destination_id" | "object_key" | "object_digest">,
  state: "retry" | "succeeded" | "failed" | "suppressed",
  attempt: number,
  occurredAt: string,
  reason?: string,
  httpStatus?: number,
): Promise<void> {
  const artifact = {
    batch_id: row.batch_id,
    destination_id: row.destination_id,
    tenant_id: tenantId,
    app_id: row.app_id,
    object_key: row.object_key,
    object_digest: row.object_digest,
    state,
    attempt,
    occurred_at: occurredAt,
    ...(httpStatus ? { http_status: httpStatus } : {}),
    ...(reason ? { reason_code: reason } : {}),
  };
  await client.query(
    `INSERT INTO ledger.operator_bulk_export_results (
       export_result_id,batch_id,tenant_id,app_id,destination_id,object_key,object_digest,
       state,attempt,occurred_at,http_status,reason_code,artifact
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
    [uuidV7(Date.parse(occurredAt) + attempt), row.batch_id, tenantId, row.app_id,
      row.destination_id, row.object_key, row.object_digest, state, attempt, occurredAt,
      httpStatus ?? null, reason ?? null, JSON.stringify(artifact)],
  );
}

const candidateSelect = `
  SELECT destination.destination_id,destination.endpoint_url,destination.reference_secret_ref AS secret_ref,
         logical.logical_event_id,logical.record_id,logical.app_id,logical.event_name,
         raw.received_at,
         COALESCE(session.occurred_at,purchase.occurred_at,refund.occurred_at,
                  revenue.occurred_at,raw.occurred_at) AS occurred_at,
         COALESCE(session.installation_id,custom.installation_id,purchase.installation_id,
                  refund.installation_id,revenue.installation_id) AS installation_id,
         custom.event_key,COALESCE(refund.transaction_id,purchase.transaction_id) AS transaction_id,
         COALESCE(refund.original_transaction_id,purchase.original_transaction_id) AS original_transaction_id,
         COALESCE(purchase.amount_unscaled,refund.amount_unscaled,revenue.amount_unscaled) AS amount_unscaled,
         COALESCE(purchase.amount_scale,refund.amount_scale,revenue.amount_scale) AS amount_scale,
         COALESCE(purchase.currency,refund.currency,revenue.currency) AS currency,
         COALESCE(refund.financial_status,purchase.financial_status) AS financial_status,
         revenue.revenue_source,revenue.ad_network,revenue.country
    FROM control.operator_bulk_export_destinations_current AS destination
    JOIN ledger.logical_events AS logical
      ON logical.tenant_id=destination.tenant_id AND logical.app_id=destination.app_id
     AND logical.event_name=ANY(destination.allowed_events)
    JOIN ledger.raw_records_current AS raw
      ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
    LEFT JOIN ledger.session_facts AS session
      ON session.tenant_id=logical.tenant_id AND session.app_id=logical.app_id
     AND session.logical_event_id=logical.logical_event_id AND logical.event_name='session_start'
    LEFT JOIN ledger.custom_event_facts AS custom
      ON custom.tenant_id=logical.tenant_id AND custom.app_id=logical.app_id
     AND custom.logical_event_id=logical.logical_event_id AND logical.event_name='custom_event'
    LEFT JOIN ledger.purchase_facts AS purchase
      ON purchase.tenant_id=logical.tenant_id AND purchase.app_id=logical.app_id
     AND purchase.logical_event_id=logical.logical_event_id AND logical.event_name='purchase'
    LEFT JOIN ledger.refund_facts AS refund
      ON refund.tenant_id=logical.tenant_id AND refund.app_id=logical.app_id
     AND refund.logical_event_id=logical.logical_event_id AND logical.event_name='refund'
    LEFT JOIN ledger.ad_revenue_facts AS revenue
      ON revenue.tenant_id=logical.tenant_id AND revenue.app_id=logical.app_id
     AND revenue.logical_event_id=logical.logical_event_id AND logical.event_name='ad_revenue'
   WHERE destination.tenant_id=$1 AND destination.app_id=$2 AND destination.destination_id=$3
     AND destination.status='active' AND raw.received_at_ts >= destination.start_at_ts
     AND (raw.received_at_ts,logical.record_id) > (COALESCE($4::timestamptz,'-infinity'::timestamptz),COALESCE($5,''))
     AND logical.record_lifecycle='active'
     AND raw.payload_lifecycle_status='available'
     AND raw.withdrawal_recognized_at IS NULL
     AND raw.consent_decision_reason_code <> 'consent_withdrawn'
     AND COALESCE(session.logical_event_id,custom.logical_event_id,purchase.logical_event_id,
                  refund.logical_event_id,revenue.logical_event_id) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM ledger.privacy_tombstones AS tombstone
       WHERE tombstone.tenant_id=logical.tenant_id AND tombstone.app_id=logical.app_id
         AND tombstone.record_id=logical.record_id)
   ORDER BY raw.received_at_ts,logical.record_id COLLATE "C" LIMIT $6`;

export async function discoverOperatorBulkExports(
  pool: Pool,
  payloadStore: PayloadStore,
  tenantId: string,
  options: Readonly<{ now?: Date; maximumRows?: number; maximumObjectBytes?: number }> = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const maximumRows = options.maximumRows ?? 500;
  const maximumObjectBytes = options.maximumObjectBytes ?? 10 * 1024 * 1024;
  if (!Number.isFinite(now.valueOf()) || !Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 10_000
    || !Number.isSafeInteger(maximumObjectBytes) || maximumObjectBytes < 1024 || maximumObjectBytes > 64 * 1024 * 1024) {
    throw new Error("operator_bulk_discovery_options_invalid");
  }
  const destinations = await withTenant(pool, tenantId, (client) => client.query<{ app_id: string; destination_id: string }>(
    `SELECT app_id,destination_id FROM control.operator_bulk_export_destinations_current
      WHERE tenant_id=$1 AND status='active' ORDER BY app_id,destination_id`,
    [tenantId],
  ));
  let created = 0;
  for (const destination of destinations.rows) {
    let objectRef: string | undefined;
    try {
      const inserted = await withTenant(pool, tenantId, async (client) => {
        await lockDestination(client, tenantId, destination.app_id, destination.destination_id);
        const selected = await client.query<DestinationRow>(
          `SELECT destination.destination_id,destination.app_id,destination.endpoint_url,
                  destination.bucket_name,destination.object_prefix,destination.region,
                  destination.credential_ref,destination.credential_digest,
                  destination.reference_secret_ref,destination.status,
                  checkpoint.event_received_at,checkpoint.event_record_id,checkpoint.deletion_seq::text
             FROM control.operator_bulk_export_destinations_current AS destination
             JOIN control.operator_bulk_export_checkpoints AS checkpoint
               USING (destination_id,tenant_id,app_id)
            WHERE destination.tenant_id=$1 AND destination.app_id=$2 AND destination.destination_id=$3
              AND destination.status='active'
              AND NOT EXISTS (SELECT 1 FROM ephemeral.operator_bulk_export_batches AS batch
                WHERE batch.tenant_id=$1 AND batch.app_id=$2 AND batch.destination_id=$3
                  AND batch.state IN ('queued','retry'))
            FOR UPDATE OF checkpoint`,
          [tenantId, destination.app_id, destination.destination_id],
        );
        const row = selected.rows[0];
        if (!row) return false;
        const deletions = await client.query<OperatorBulkDeletionCandidate>(
          `SELECT deletion_seq::text,app_id,subject_ref,recognized_at
             FROM ledger.operator_bulk_export_deletions
            WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3 AND deletion_seq > $4
            ORDER BY deletion_seq LIMIT $5`,
          [tenantId, row.app_id, row.destination_id, row.deletion_seq, maximumRows],
        );
        const remaining = maximumRows - deletions.rows.length;
        const events = remaining > 0 ? await client.query<OperatorBulkEventCandidate>(candidateSelect, [
          tenantId, row.app_id, row.destination_id, row.event_received_at, row.event_record_id, remaining,
        ]) : { rows: [] as OperatorBulkEventCandidate[] };
        if (deletions.rows.length + events.rows.length === 0) return false;
        const referenceSecret = await payloadStore.read(row.reference_secret_ref);
        const rows = buildOperatorBulkRows({ events: events.rows, deletions: deletions.rows, referenceSecret });
        const lastEvent = events.rows.at(-1);
        const lastDeletion = deletions.rows.at(-1);
        const cursorBefore: OperatorBulkCursor = {
          event_received_at: row.event_received_at,
          event_record_id: row.event_record_id,
          deletion_seq: row.deletion_seq,
        };
        const cursorAfter: OperatorBulkCursor = {
          event_received_at: lastEvent?.received_at ?? row.event_received_at,
          event_record_id: lastEvent?.record_id ?? row.event_record_id,
          deletion_seq: lastDeletion?.deletion_seq ?? row.deletion_seq,
        };
        const batchId = uuidV7(now.valueOf() + created);
        const prepared = prepareOperatorBulkExport({
          exportId: `export:${batchId}`,
          destinationId: row.destination_id,
          appId: row.app_id,
          objectPrefix: row.object_prefix,
          generatedAt: now.toISOString(),
          cursorBefore,
          cursorAfter,
          rows,
        });
        if (prepared.body.length > maximumObjectBytes) throw new Error("operator_bulk_object_too_large");
        objectRef = await payloadStore.write({
          tenantId, appId: row.app_id, objectId: `operator-bulk-${batchId}`,
        }, prepared.body);
        const result = await client.query(
          `INSERT INTO ephemeral.operator_bulk_export_batches (
             batch_id,tenant_id,app_id,destination_id,object_key,object_ref,object_digest,row_count,
             event_received_at_before,event_record_id_before,event_received_at_after,event_record_id_after,
             deletion_seq_before,deletion_seq_after,state,attempts,next_attempt_at,created_at,updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'queued',0,$15,$16,$17)
           ON CONFLICT (tenant_id,app_id,destination_id,object_key) DO NOTHING`,
          [batchId, tenantId, row.app_id, row.destination_id, prepared.objectKey, objectRef,
            prepared.bodyDigest, rows.length, cursorBefore.event_received_at, cursorBefore.event_record_id,
            cursorAfter.event_received_at, cursorAfter.event_record_id, cursorBefore.deletion_seq,
            cursorAfter.deletion_seq, now.toISOString(), now.toISOString(), now.toISOString()],
        );
        return result.rowCount === 1;
      });
      if (inserted) created += 1;
      else if (objectRef) await payloadStore.purge(objectRef);
    } catch (error) {
      if (objectRef) await payloadStore.purge(objectRef);
      throw error;
    }
  }
  return created;
}

export async function processOperatorBulkExports(
  pool: Pool,
  payloadStore: PayloadStore,
  tenantId: string,
  options: Readonly<{
    enabled: boolean;
    destinationAllowlist: readonly string[];
    allowSyntheticLoopback?: boolean;
    now?: () => Date;
    lookup?: WebhookLookup;
    timeoutMilliseconds?: number;
    maximumAttempts?: number;
    maximumObjectBytes?: number;
  }>,
): Promise<{ processed: number }> {
  if (!options.enabled) return { processed: 0 };
  const maximumAttempts = options.maximumAttempts ?? 8;
  if (!Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 || maximumAttempts > 32) {
    throw new Error("operator_bulk_maximum_attempts_invalid");
  }
  const now = options.now?.() ?? new Date();
  const due = await withTenant(pool, tenantId, (client) => client.query<{ batch_id: string }>(
    `SELECT batch_id::text FROM ephemeral.operator_bulk_export_batches
      WHERE tenant_id=$1 AND state IN ('queued','retry') AND next_attempt_at <= $2
      ORDER BY next_attempt_at,batch_id LIMIT 20`,
    [tenantId, now.toISOString()],
  ));
  let processed = 0;
  for (const { batch_id: batchId } of due.rows) {
    let purgeRef: string | undefined;
    let appId: string | undefined;
    await withTenant(pool, tenantId, async (client) => {
      const identity = await client.query<{ app_id: string; destination_id: string }>(
        `SELECT app_id,destination_id FROM ephemeral.operator_bulk_export_batches
          WHERE tenant_id=$1 AND batch_id=$2 AND state IN ('queued','retry') AND next_attempt_at <= $3`,
        [tenantId, batchId, now.toISOString()],
      );
      if (!identity.rows[0]) return;
      await lockDestination(client, tenantId, identity.rows[0].app_id, identity.rows[0].destination_id);
      const selected = await client.query<BatchRow>(
        `SELECT batch.batch_id::text,batch.app_id,batch.destination_id,batch.object_key,
                batch.object_ref,batch.object_digest,batch.attempts,
                batch.event_received_at_before,batch.event_record_id_before,
                batch.event_received_at_after,batch.event_record_id_after,
                batch.deletion_seq_before::text,batch.deletion_seq_after::text,
                destination.endpoint_url,destination.bucket_name,destination.object_prefix,
                destination.region,destination.credential_ref,destination.credential_digest,
                destination.reference_secret_ref,destination.status,
                checkpoint.event_received_at,checkpoint.event_record_id,checkpoint.deletion_seq::text
           FROM ephemeral.operator_bulk_export_batches AS batch
           JOIN control.operator_bulk_export_destinations_current AS destination
             USING (destination_id,tenant_id,app_id)
           JOIN control.operator_bulk_export_checkpoints AS checkpoint
             USING (destination_id,tenant_id,app_id)
          WHERE batch.tenant_id=$1 AND batch.batch_id=$2
            AND batch.state IN ('queued','retry') AND batch.next_attempt_at <= $3
          FOR UPDATE OF batch,checkpoint`,
        [tenantId, batchId, now.toISOString()],
      );
      const row = selected.rows[0];
      if (!row) return;
      appId = row.app_id;
      const attempt = row.attempts + 1;
      if (row.status !== "active") {
        await client.query(
          `UPDATE ephemeral.operator_bulk_export_batches
              SET state='suppressed',attempts=$3,safe_reason='destination_disabled',updated_at=$4
            WHERE tenant_id=$1 AND batch_id=$2`,
          [tenantId, row.batch_id, attempt, now.toISOString()],
        );
        await appendResult(client, tenantId, row, "suppressed", attempt, now.toISOString(), "destination_disabled");
        purgeRef = row.object_ref;
        processed += 1;
        return;
      }
      let body: Buffer;
      let credentials: S3Credentials;
      try {
        const [protectedBody, protectedCredentials] = await Promise.all([
          payloadStore.read(row.object_ref), payloadStore.read(row.credential_ref),
        ]);
        body = protectedBody;
        credentials = parseCredentials(protectedCredentials, row.credential_digest);
      } catch {
        await client.query(
          `UPDATE ephemeral.operator_bulk_export_batches
              SET state='failed',attempts=$3,safe_reason='protected_payload_unavailable',updated_at=$4
            WHERE tenant_id=$1 AND batch_id=$2`,
          [tenantId, row.batch_id, attempt, now.toISOString()],
        );
        await appendResult(client, tenantId, row, "failed", attempt, now.toISOString(), "protected_payload_unavailable");
        purgeRef = row.object_ref;
        processed += 1;
        return;
      }
      if (sha256(body) !== row.object_digest) {
        await client.query(
          `UPDATE ephemeral.operator_bulk_export_batches
              SET state='failed',attempts=$3,safe_reason='object_digest_mismatch',updated_at=$4
            WHERE tenant_id=$1 AND batch_id=$2`,
          [tenantId, row.batch_id, attempt, now.toISOString()],
        );
        await appendResult(client, tenantId, row, "failed", attempt, now.toISOString(), "object_digest_mismatch");
        purgeRef = row.object_ref;
        processed += 1;
        return;
      }
      const delivery = await putS3Object({
        endpointUrl: row.endpoint_url,
        bucket: row.bucket_name,
        key: row.object_key,
        region: row.region,
        credentials,
        body,
        expectedDigest: row.object_digest,
        destinationAllowlist: options.destinationAllowlist,
        allowSyntheticLoopback: options.allowSyntheticLoopback,
        timeoutMilliseconds: options.timeoutMilliseconds,
        maximumObjectBytes: options.maximumObjectBytes,
        lookup: options.lookup,
        now,
      });
      let state: "retry" | "succeeded" | "failed";
      let reason: string | undefined;
      if (delivery.outcome === "stored" || delivery.outcome === "already_present") {
        state = "succeeded";
        reason = delivery.outcome;
      } else if (delivery.outcome === "terminal" || attempt >= maximumAttempts) {
        state = "failed";
        reason = delivery.outcome === "terminal" ? delivery.reason : "retry_exhausted";
      } else {
        state = "retry";
        reason = delivery.outcome === "retry" ? delivery.reason : "retry_exhausted";
      }
      if (state === "succeeded") {
        const advanced = await client.query(
          `UPDATE control.operator_bulk_export_checkpoints
              SET event_received_at=$4,event_record_id=$5,deletion_seq=$6,updated_at=$7
            WHERE tenant_id=$1 AND app_id=$2 AND destination_id=$3
              AND event_received_at IS NOT DISTINCT FROM $8
              AND event_record_id IS NOT DISTINCT FROM $9
              AND deletion_seq=$10`,
          [tenantId, row.app_id, row.destination_id, row.event_received_at_after,
            row.event_record_id_after, row.deletion_seq_after, now.toISOString(),
            row.event_received_at_before, row.event_record_id_before, row.deletion_seq_before],
        );
        if (advanced.rowCount !== 1) throw new Error("operator_bulk_checkpoint_conflict");
      }
      const nextAttemptAt = new Date(now.valueOf() + Math.min(3_600_000, 60_000 * (2 ** Math.min(attempt - 1, 6))));
      await client.query(
        `UPDATE ephemeral.operator_bulk_export_batches
            SET state=$3,attempts=$4,next_attempt_at=$5,last_http_status=$6,safe_reason=$7,updated_at=$8
          WHERE tenant_id=$1 AND batch_id=$2`,
        [tenantId, row.batch_id, state, attempt, nextAttemptAt.toISOString(),
          "httpStatus" in delivery ? delivery.httpStatus ?? null : null, reason ?? null, now.toISOString()],
      );
      await appendResult(client, tenantId, row, state, attempt, now.toISOString(), reason,
        "httpStatus" in delivery ? delivery.httpStatus : undefined);
      if (state !== "retry") purgeRef = row.object_ref;
      processed += 1;
    });
    if (purgeRef) await payloadStore.purge(purgeRef);
    if (appId) await recordJobOutcome({
      pool, tenantId, appId, job: "operator_bulk_export", outcome: "succeeded", now,
    });
  }
  return { processed };
}
