import type { Pool, PoolClient } from "pg";
import { acquirePrivacyTenantSessionReadFence } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import type { MetricQuery } from "./report-query.js";
import { metricReportOnClient, type MetricReportRow } from "./reporting.js";
import { comparisonExport, ComparisonExportError, requireComparisonQuery } from "./comparison-export.js";
import { decodeMetricCursor } from "./report-query.js";

export const comparisonLimits = Object.freeze({ rows: 10000, bytes: 4 * 1024 * 1024, milliseconds: 30000 });
export type SelectionBounds = { readonly rows: number; readonly bytes: number; readonly milliseconds: number };
export type SelectionOptions = { signal?: AbortSignal; bounds?: SelectionBounds };

async function boundedClient(pool: Pool, milliseconds: number): Promise<PoolClient> {
  const pending = pool.connect();
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([pending, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ComparisonExportError("comparison_acquisition_incomplete")), milliseconds);
    })]);
  } catch (error) {
    void pending.then(client => client.release(), () => {});
    throw error;
  } finally { clearTimeout(timer!); }
}

/** Buffer a bounded all-page result; publish nothing until consistent acquisition succeeds. */
export async function fixedComparisonDownload(pool: Pool, identity: AppAdminIdentity, query: MetricQuery,
    options: SelectionOptions & { declaredAggregation?: string } = {}): Promise<string> {
  requireComparisonQuery(query);
  return fixedMetricSelections(pool, identity, [query], ([rows]) =>
    comparisonExport({ data: rows }, query, options.declaredAggregation, true), options);
}

/** All selections and the projection share one privacy-fenced database snapshot and budget. */
export async function fixedMetricSelections<T>(pool: Pool, identity: AppAdminIdentity, queries: readonly MetricQuery[],
    project: (rows: readonly (readonly MetricReportRow[])[]) => T, options: SelectionOptions = {}): Promise<T> {
  if (!queries.length || queries.some(query => query.tenantId !== identity.tenantId || query.appId !== identity.appId)) {
    throw new ComparisonExportError("comparison_scope_mismatch");
  }
  const bounds = options.bounds ?? comparisonLimits;
  if (Object.entries(bounds).some(([k, v]) => !Number.isInteger(v) || v < 1 || v > comparisonLimits[k as keyof SelectionBounds])) {
    throw new ComparisonExportError("comparison_limit_invalid");
  }
  const deadline = performance.now() + bounds.milliseconds;
  const remaining = () => {
    if (options.signal?.aborted || performance.now() >= deadline) throw new ComparisonExportError("comparison_acquisition_incomplete");
    return Math.max(1, Math.floor(deadline - performance.now()));
  };
  const client = await boundedClient(pool, remaining());
  let releaseFence: (() => Promise<void>) | undefined, transaction = false, previousTimeout: string | undefined, primary: unknown;
  try {
    previousTimeout = (await client.query<{ value: string }>("SELECT current_setting('statement_timeout') AS value")).rows[0].value;
    await client.query("SELECT set_config('statement_timeout',$1,false)", [String(remaining())]);
    releaseFence = await acquirePrivacyTenantSessionReadFence(client, identity.tenantId);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); transaction = true;
    await client.query("SELECT set_config('openmasu.tenant_id',$1,true)", [identity.tenantId]);
    const pendingPrivacy = await client.query<{ pending_count: string }>("SELECT pending_count FROM control.privacy_deletion_backlog()");
    if (pendingPrivacy.rows[0]?.pending_count !== "0") throw new ComparisonExportError("comparison_privacy_pending");
    const selections: MetricReportRow[][] = [];
    let bytes = 0, count = 0;
    for (const query of queries) {
      const rows: MetricReportRow[] = [];
      let pageQuery: MetricQuery = { ...query, limit: Math.min(query.limit, 1000) };
      for (;;) {
        await client.query("SELECT set_config('statement_timeout',$1,true)", [String(remaining())]);
        const page = await metricReportOnClient(client, pageQuery, true);
        rows.push(...page.data); count += page.data.length;
        bytes += Buffer.byteLength(JSON.stringify(page.data), "utf8");
        if (count > bounds.rows || bytes > bounds.bytes) throw new ComparisonExportError("comparison_incomplete_or_limit_exceeded");
        remaining();
        if (!page.next_cursor) break;
        if (!page.data.length) throw new ComparisonExportError("comparison_acquisition_incomplete");
        pageQuery = { ...pageQuery, after: decodeMetricCursor(page.next_cursor) };
      }
      selections.push(rows);
    }
    const body = project(selections);
    if (Buffer.byteLength(typeof body === "string" ? body : JSON.stringify(body), "utf8") > bounds.bytes) throw new ComparisonExportError("comparison_byte_limit_exceeded");
    remaining();
    await client.query("COMMIT"); transaction = false;
    return body;
  } catch (error) {
    primary = error;
    if (error instanceof ComparisonExportError || (error instanceof Error && error.message === "comparison_evidence_unavailable")) throw error;
    throw new ComparisonExportError("comparison_acquisition_incomplete");
  } finally {
    let cleanupError: Error | undefined;
    try {
      if (transaction) await client.query("ROLLBACK");
      if (releaseFence) await releaseFence();
      if (previousTimeout !== undefined) await client.query("SELECT set_config('statement_timeout',$1,false)", [previousTimeout]);
    } catch { cleanupError = new Error("comparison_cleanup_failed"); }
    client.release(cleanupError);
    if (cleanupError && !primary) throw new ComparisonExportError("comparison_acquisition_incomplete");
  }
}
