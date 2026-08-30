import { createHash } from "node:crypto";
import { constants as zlibConstants, gzipSync } from "node:zlib";
import type { OperatorWebhookEventName } from "@openmasu/runtime";
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
  return [...events, ...deletions];
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

export function operatorBulkAllowedEvents(value: unknown): readonly OperatorWebhookEventName[] {
  if (!Array.isArray(value)) throw new Error("operator_bulk_events_invalid");
  return value as readonly OperatorWebhookEventName[];
}
