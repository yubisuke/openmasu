import type { Pool } from "pg";
import { withTenant, type PayloadStore } from "@openmasu/runtime";
import {
  completeManagedImport, loadManagedUploadBytes, managedImportLimits, ManagedImportError,
  readManagedUpload, sweepManagedUploads, type ManagedImportResult, type ManagedPreview,
} from "@openmasu/runtime/managed-imports";
import { analyzeMmpImportSource, runMmpImportSource } from "./runner.js";
import { buildImportCompatibilityReport } from "./compatibility.js";
import { analyzeManualCostImportSource, buildManualCostCompatibilityReport } from "./cost-compatibility.js";
import { prepareCostImportSource } from "./cost-cli.js";
import { persistCostImportWithClient } from "./cost.js";
import { ImportLimitError } from "./source.js";

/** One bounded source per existing tenant/job lease; no private HTTP-to-worker import. */
export async function processManagedImports(pool: Pool, store: PayloadStore, tenantId: string, now = new Date()): Promise<void> {
  await sweepManagedUploads(pool, store, tenantId, now);
  const selected = await withTenant(pool, tenantId, async client => (await client.query<{ upload_id: string; app_id: string }>(
    `SELECT upload_id::text,app_id FROM ephemeral.managed_import_uploads WHERE tenant_id=$1
      AND state IN ('uploaded','queued','importing') AND attempts<3 AND expires_at>$2
      ORDER BY created_at,upload_id LIMIT 1`, [tenantId,now.toISOString()])).rows[0]);
  if (!selected) return;
  const scope = { tenantId, appId: selected.app_id };
  const row = await readManagedUpload(pool, scope, selected.upload_id);
  try {
    const source = await loadManagedUploadBytes(pool, store, scope, row);
    const options = { mapping: source.mapping, sourceBytes: source.bytes, limits: managedImportLimits };
    if (row.state === "uploaded") {
      let preview: ManagedPreview;
      if (source.mapping.kind === "mmp_raw") {
        const analysis = analyzeMmpImportSource(options), p = analysis.preview;
        const compatibility = buildImportCompatibilityReport({ mapping: source.mapping, rows: p.rows,
          warningCount: p.warnings.length, eventIdNamespaceEvaluated: false,
          rejections: p.rejections, observedFieldCounts: analysis.observedFieldCounts });
        preview = { rows: p.rows, rejections: p.rejections.map(({ reason_code, count }) => ({ reason_code, count })),
          compatibility: compatibility.status, execution_ready: p.rows.accepted > 0 };
      } else {
        const analysis = analyzeManualCostImportSource(options), compatibility = buildManualCostCompatibilityReport(analysis);
        preview = { rows: analysis.rows, rejections: analysis.rejections.map(({ reason_code, count }) => ({ reason_code, count })),
          compatibility: compatibility.status, execution_ready: compatibility.execution_ready };
      }
      await withTenant(pool, tenantId, client => client.query(`UPDATE ephemeral.managed_import_uploads
        SET preview=$4::jsonb,state=$5 WHERE tenant_id=$1 AND app_id=$2 AND upload_id=$3 AND state='uploaded'`,
      [tenantId,scope.appId,row.upload_id,preview,preview.execution_ready ? "previewed" : "blocked"]));
      return;
    }
    const receipt = await withTenant(pool, tenantId, async client => (await client.query<{
      mapping_digest: string; received_at: string; result: ManagedImportResult | null;
    }>(`SELECT mapping_digest,received_at,result FROM control.managed_import_receipts
      WHERE tenant_id=$1 AND app_id=$2 AND source_id=$3 AND source_digest=$4`,
    [tenantId,scope.appId,source.mapping.source_id,row.source_digest])).rows[0]);
    if (!receipt || receipt.mapping_digest !== row.mapping_digest) throw new ManagedImportError("import_mapping_binding_conflict", 409);
    const claimed = await withTenant(pool, tenantId, client => client.query(`UPDATE ephemeral.managed_import_uploads
      SET state='importing',attempts=attempts+1 WHERE tenant_id=$1 AND app_id=$2 AND upload_id=$3
        AND state IN ('queued','importing') AND attempts<3 AND expires_at>$4`, [tenantId,scope.appId,row.upload_id,now.toISOString()]));
    if (!claimed.rowCount) return;
    if (receipt.result) {
      await withTenant(pool, tenantId, client => completeManagedImport(client,scope,row,source.mapping.source_id,receipt.result!));
    } else if (source.mapping.kind === "mmp_raw") {
      await runMmpImportSource({ ...options, pool, sourceLabel: "managed-csv", now: new Date(receipt.received_at),
        onPublished: (client, summary) => completeManagedImport(client,scope,row,source.mapping.source_id,summary) });
    } else {
      const rows = prepareCostImportSource(options);
      await withTenant(pool, tenantId, async client => {
        const summary = await persistCostImportWithClient(client,source.mapping.source_id,rows);
        await completeManagedImport(client,scope,row,source.mapping.source_id,{
          import_run_id: summary.import_run_id, rows: row.preview!.rows.read,
          accepted: rows.length, rejected: 0, status: "completed" });
      });
    }
  } catch (error) {
    const reason = error instanceof ManagedImportError ? error.code
      : error instanceof ImportLimitError ? "import_upload_limits" : "import_processing_failed";
    await withTenant(pool, tenantId, client => client.query(`UPDATE ephemeral.managed_import_uploads
      SET safe_reason=$4,state=CASE WHEN state='uploaded' OR attempts>=3 OR $5 THEN 'failed' ELSE 'importing' END
      WHERE tenant_id=$1 AND app_id=$2 AND upload_id=$3 AND state IN ('uploaded','queued','importing')`,
    [tenantId,scope.appId,row.upload_id,reason,error instanceof ManagedImportError || error instanceof ImportLimitError]));
  }
  await sweepManagedUploads(pool, store, tenantId, now);
}
