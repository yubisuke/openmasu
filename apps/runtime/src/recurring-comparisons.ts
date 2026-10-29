import type { Pool, PoolClient } from "pg";
import { jcs } from "@openmasu/attribution-core/canonical";
import { withTenant, uuidV7 } from "./index.js";
import { acquirePrivacyTenantXactFence } from "./privacy-fence.js";
import { comparisonDigest } from "./cohort-comparison.js";
import { object, type Snapshot } from "./comparison-model.js";
import { comparisonPrivacyEpoch } from "./fixed-comparison.js";
import { captureLocalComparison, resolveLocalComparisonSelection } from "./recurring-comparison-local.js";
import { assertSnapshotPeriod, boundedComparisonSnapshot, comparisonWatermark, parseComparisonRegistration,
  recurringComparisonLimits as limits, recurringComparisonResult, type ComparisonDefinition } from "./recurring-comparison-model.js";
export * from "./recurring-comparison-model.js";

type Scope = { tenantId: string; appId: string };
export type SavedComparison = { comparison_id: string; name: string; definition: ComparisonDefinition;
  definition_digest: string; supersedes_id: string | null; active: boolean; privacy_epoch: string; created_at: string };
async function privacyState(client: PoolClient, tenantId: string) {
  const pending = await client.query<{ pending_count: string }>("SELECT pending_count FROM control.privacy_deletion_backlog()");
  return { epoch: await comparisonPrivacyEpoch(client, tenantId), pending: pending.rows[0]?.pending_count !== "0" };
}
async function fenced<T>(pool: Pool, scope: Scope, mutate: boolean, action: (client: PoolClient, epoch: string, pending: boolean) => Promise<T>): Promise<T> {
  return withTenant(pool, scope.tenantId, async client => {
    await acquirePrivacyTenantXactFence(client, scope.tenantId, "shared");
    if (mutate) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`comparison:${scope.tenantId}`]);
    const state = await privacyState(client, scope.tenantId);
    if (mutate && state.pending) throw Error("comparison_privacy_pending");
    return action(client, state.epoch, state.pending);
  });
}
async function appBudget(client: PoolClient, scope: Scope) {
  const result = await client.query<{ bytes: string }>(`SELECT coalesce(sum(bytes),0)::text AS bytes FROM (
    SELECT pg_column_size(snapshot) AS bytes FROM control.comparison_snapshots WHERE tenant_id=$1 AND app_id=$2
    UNION ALL SELECT pg_column_size(result) FROM control.comparison_runs WHERE tenant_id=$1 AND app_id=$2) stored`, [scope.tenantId, scope.appId]);
  if (Number(result.rows[0].bytes) > limits.appBytes) throw Error("comparison_app_storage_limit");
}
async function insertSnapshot(client: PoolClient, scope: Scope, saved: SavedComparison, day: string, side: string, value: unknown, now: Date,
    provenance: Record<string, unknown> = { source: "operator_uploaded" }) {
  if (!["left", "right"].includes(side)) throw Error("comparison_side_invalid");
  const snapshot = boundedComparisonSnapshot(value); assertSnapshotPeriod(saved.definition, day, snapshot);
  // A captured aggregate may only assert this authenticated app's acquisition scope.
  if (snapshot.acquisition && (snapshot.acquisition.scope.tenant_id !== scope.tenantId || snapshot.acquisition.scope.app_id !== scope.appId)) throw Error("comparison_scope_mismatch");
  const digest = comparisonDigest(snapshot);
  // Read the specific side; never silently replace an immutable input.
  const actual = await client.query<{ snapshot_digest: string; provenance: Record<string, unknown> }>(`SELECT snapshot_digest,provenance FROM control.comparison_snapshots
    WHERE tenant_id=$1 AND app_id=$2 AND comparison_id=$3 AND target_date=$4 AND side=$5`, [scope.tenantId, scope.appId, saved.comparison_id, day, side]);
  if (actual.rowCount) {
    if (actual.rows[0].snapshot_digest !== digest || comparisonDigest(actual.rows[0].provenance) !== comparisonDigest(provenance)) throw Error("comparison_snapshot_conflict");
    return digest;
  }
  await client.query(`INSERT INTO control.comparison_snapshots(tenant_id,app_id,comparison_id,target_date,side,snapshot_digest,snapshot,expires_at,provenance)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [scope.tenantId, scope.appId, saved.comparison_id, day, side, digest, snapshot,
    new Date(now.valueOf() + saved.definition.retention_days * 86400000).toISOString(), provenance]);
  await appBudget(client, scope);
  return digest;
}
/** Read-only preview and registration share the same server-owned operand resolver. */
export async function prepareComparisonRegistration(pool: Pool, scope: Scope, input: unknown) {
  object(input);
  if (input.local_selection === undefined) return { parsed: parseComparisonRegistration(input), captured: undefined };
  if (input.left_snapshot !== undefined) throw Error("comparison_local_capture_required");
  const { local_selection, expected_left_snapshot_digest: _expected, ...manual } = input;
  const settings = parseComparisonRegistration({ ...manual, left_snapshot: input.right_snapshot });
  const selection = await withTenant(pool, scope.tenantId, client => resolveLocalComparisonSelection(client, scope, local_selection));
  const captured = await captureLocalComparison(pool, scope, selection, settings.definition, settings.definition.first_date);
  return { parsed: parseComparisonRegistration(input, { selection, snapshot: captured.snapshot }), captured };
}
export async function registerComparison(pool: Pool, scope: Scope, input: unknown, now = new Date()): Promise<SavedComparison> {
  const { parsed, captured } = await prepareComparisonRegistration(pool, scope, input);
  return fenced(pool, scope, true, async (client, epoch) => {
    if (captured && captured.privacyEpoch !== epoch) throw Error("comparison_privacy_changed");
    if (parsed.definition.local_selection) {
      const selection = parsed.definition.local_selection;
      const current = await resolveLocalComparisonSelection(client, scope, { metric_schedule_id: selection.metric_schedule_id, metric_name: selection.metric_name });
      if (comparisonDigest(current) !== comparisonDigest(selection)) throw Error("comparison_local_definition_changed");
    }
    const count = await client.query<{ count: string }>("SELECT count(*) FROM control.comparison_definitions WHERE tenant_id=$1 AND active", [scope.tenantId]);
    if (Number(count.rows[0].count) >= limits.plans && !parsed.supersedes_id) throw Error("comparison_plan_limit");
    if (parsed.supersedes_id) {
      const previous = await client.query(`UPDATE control.comparison_definitions SET active=false
        WHERE tenant_id=$1 AND app_id=$2 AND comparison_id=$3 AND active RETURNING comparison_id`, [scope.tenantId, scope.appId, parsed.supersedes_id]);
      if (!previous.rowCount) throw Error("comparison_revision_not_active");
    }
    const saved: SavedComparison = { comparison_id: uuidV7(), name: parsed.name, definition: parsed.definition,
      definition_digest: comparisonDigest(parsed.definition), supersedes_id: parsed.supersedes_id, active: true, privacy_epoch: epoch, created_at: now.toISOString() };
    await client.query(`INSERT INTO control.comparison_definitions(comparison_id,tenant_id,app_id,name,definition,definition_digest,privacy_epoch,supersedes_id,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [saved.comparison_id, scope.tenantId, scope.appId, saved.name, saved.definition, saved.definition_digest, epoch, saved.supersedes_id, saved.created_at]);
    await insertSnapshot(client, scope, saved, saved.definition.first_date, "left", parsed.left, now, captured?.provenance);
    await insertSnapshot(client, scope, saved, saved.definition.first_date, "right", parsed.right, now);
    return saved;
  });
}
export async function depositComparisonSnapshot(pool: Pool, scope: Scope, id: string, day: string, side: string, value: unknown, now = new Date()) {
  return fenced(pool, scope, true, async (client, epoch) => {
    const saved = (await client.query<SavedComparison>(`SELECT * FROM control.comparison_definitions WHERE tenant_id=$1 AND app_id=$2 AND comparison_id=$3 AND active`, [scope.tenantId, scope.appId, id])).rows[0];
    if (!saved || saved.privacy_epoch !== epoch) throw Error("comparison_not_available");
    if (side === "left" && saved.definition.local_selection) throw Error("comparison_local_deposit_forbidden");
    return insertSnapshot(client, scope, saved, day, side, value, now);
  });
}
export async function readComparisons(pool: Pool, scope: Scope, now = new Date()) {
  return fenced(pool, scope, false, async (client, epoch, pending) => {
    const plans = (await client.query<SavedComparison>(`SELECT * FROM control.comparison_definitions WHERE tenant_id=$1 AND app_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC,comparison_id LIMIT 100`, [scope.tenantId, scope.appId])).rows;
    const runs = pending ? [] : (await client.query(`SELECT run.run_id,run.comparison_id,run.target_date::text,run.result->>'state' AS state,run.expires_at
      FROM control.comparison_runs run JOIN control.comparison_definitions d USING(tenant_id,app_id,comparison_id)
      WHERE run.tenant_id=$1 AND run.app_id=$2 AND d.privacy_epoch=$3 AND d.deleted_at IS NULL AND run.expires_at>$4
      ORDER BY run.target_date DESC,run.created_at DESC,run.run_id LIMIT 200`, [scope.tenantId, scope.appId, epoch, now.toISOString()])).rows;
    return { plans: plans.map(plan => ({ ...plan, privacy_state: pending || plan.privacy_epoch !== epoch ? "suppressed" : "current" })), runs };
  });
}
export async function readComparisonRun(pool: Pool, scope: Scope, id: string, now = new Date()) {
  return fenced(pool, scope, false, async (client, epoch, pending) => {
    if (pending) return null;
    return (await client.query(`SELECT r.result FROM control.comparison_runs r JOIN control.comparison_definitions d USING(tenant_id,app_id,comparison_id)
      WHERE r.tenant_id=$1 AND r.app_id=$2 AND r.run_id=$3 AND r.expires_at>$4 AND d.deleted_at IS NULL AND d.privacy_epoch=$5`,
      [scope.tenantId,scope.appId,id,now.toISOString(),epoch])).rows[0]?.result ?? null;
  });
}
export async function deleteComparison(pool: Pool, scope: Scope, id: string): Promise<boolean> {
  return withTenant(pool, scope.tenantId, async client => {
    await acquirePrivacyTenantXactFence(client, scope.tenantId, "shared");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`comparison:${scope.tenantId}`]);
    for (const table of ["comparison_runs", "comparison_snapshots"]) await client.query(`DELETE FROM control.${table} WHERE tenant_id=$1 AND app_id=$2 AND comparison_id=$3`, [scope.tenantId, scope.appId, id]);
    // Retain immutable nonnumeric revision metadata while dropping every aggregate.
    const result = await client.query("UPDATE control.comparison_definitions SET active=false,deleted_at=clock_timestamp() WHERE tenant_id=$1 AND app_id=$2 AND comparison_id=$3 AND deleted_at IS NULL RETURNING comparison_id", [scope.tenantId, scope.appId, id]);
    return Boolean(result.rowCount);
  });
}
type LocalAttempt = { state: string; source_signature: string };
/** Capture outside the publication transaction: a one-connection pool cannot deadlock. */
async function captureDueLocalOperands(pool: Pool, scope: Scope, now: Date): Promise<Map<string, LocalAttempt>> {
  const candidates = await fenced(pool, scope, false, async (client, epoch, pending) => {
    if (pending) return [];
    return (await client.query<SavedComparison & { day: string; source_signature: string }>(`
      SELECT d.*,day::date::text AS day,source.signature AS source_signature
      FROM control.comparison_definitions d
      CROSS JOIN LATERAL generate_series((d.definition->>'first_date')::date,
        LEAST((d.definition->>'last_date')::date,($3::timestamptz AT TIME ZONE 'UTC')::date-(d.definition->>'watermark_lag_days')::integer),interval '1 day') day
      CROSS JOIN LATERAL (SELECT md5(coalesce(string_agg(m.metric_run_id,',' ORDER BY m.metric_run_id),'')) AS signature
        FROM control.metric_schedule_runs s JOIN ledger.metric_runs m USING(tenant_id,app_id,metric_run_id)
        WHERE s.tenant_id=d.tenant_id AND s.app_id=d.app_id AND s.target_date=day::date
          AND s.metric_schedule_id=d.definition->'local_selection'->>'metric_schedule_id'
          AND m.metric_name=d.definition->'local_selection'->>'metric_name') source
      WHERE d.tenant_id=$1 AND d.app_id=$2 AND d.active AND d.privacy_epoch=$4 AND d.definition ? 'local_selection'
        AND NOT EXISTS(SELECT 1 FROM control.comparison_snapshots s WHERE s.comparison_id=d.comparison_id AND s.target_date=day::date AND s.side='left' AND s.expires_at>$3)
        AND NOT EXISTS(SELECT 1 FROM control.comparison_runs old WHERE old.comparison_id=d.comparison_id AND old.target_date=day::date
          AND old.result->'local_input'->>'source_signature'=source.signature
          AND old.result->'local_input'->>'state' NOT IN ('comparison_acquisition_incomplete','comparison_cleanup_failed'))
      ORDER BY day,d.comparison_id LIMIT 10`, [scope.tenantId,scope.appId,now.toISOString(),epoch])).rows;
  });
  const attempts = new Map<string, LocalAttempt>();
  for (const saved of candidates) {
    const key = `${saved.comparison_id}:${saved.day}`;
    try {
      const selection = saved.definition.local_selection!;
      const captured = await captureLocalComparison(pool, scope, selection, saved.definition, saved.day);
      await fenced(pool, scope, true, async (client, epoch) => {
        const current = (await client.query<SavedComparison>(`SELECT * FROM control.comparison_definitions
          WHERE tenant_id=$1 AND app_id=$2 AND comparison_id=$3 AND active AND deleted_at IS NULL`,
          [scope.tenantId,scope.appId,saved.comparison_id])).rows[0];
        if (!current || current.definition_digest !== saved.definition_digest) throw Error("comparison_local_definition_changed");
        if (epoch !== saved.privacy_epoch || captured.privacyEpoch !== epoch) throw Error("comparison_privacy_changed");
        const resolved = await resolveLocalComparisonSelection(client, scope, { metric_schedule_id: selection.metric_schedule_id, metric_name: selection.metric_name });
        if (comparisonDigest(resolved) !== comparisonDigest(selection)) throw Error("comparison_local_definition_changed");
        await insertSnapshot(client, scope, current, saved.day, "left", captured.snapshot, now, captured.provenance);
      });
      attempts.set(key, { state: "captured", source_signature: saved.source_signature });
    } catch (error) {
      const safe = error instanceof Error && /^comparison_[a-z_]+$/.test(error.message) ? error.message : "comparison_acquisition_incomplete";
      attempts.set(key, { state: safe, source_signature: saved.source_signature });
    }
  }
  return attempts;
}
/** Existing tenant worker, fixed cutoff per date, bounded work and immutable content-addressed results. */
export async function processRecurringComparisons(pool: Pool, tenantId: string, now = new Date()) {
  const scopes = await withTenant(pool, tenantId, async client => (await client.query<{ app_id: string }>(`SELECT DISTINCT d.app_id FROM control.comparison_definitions d WHERE tenant_id=$1 AND (active
    OR EXISTS(SELECT 1 FROM control.comparison_snapshots s WHERE s.comparison_id=d.comparison_id)
    OR EXISTS(SELECT 1 FROM control.comparison_runs r WHERE r.comparison_id=d.comparison_id)) ORDER BY app_id LIMIT 100`, [tenantId])).rows);
  let completed = 0, purged = 0;
  for (const { app_id: appId } of scopes) {
    const scope = { tenantId, appId };
    const localAttempts = await captureDueLocalOperands(pool, scope, now);
    await fenced(pool, scope, false, async (client, epoch, pending) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`comparison:${tenantId}`]);
      for (const table of ["comparison_runs", "comparison_snapshots"]) {
        const deleted = await client.query(`DELETE FROM control.${table} r USING control.comparison_definitions d
          WHERE r.tenant_id=$1 AND r.app_id=$2 AND d.comparison_id=r.comparison_id
          AND (r.expires_at<=$3 OR d.privacy_epoch<>$4 OR d.deleted_at IS NOT NULL)`, [tenantId, appId, now.toISOString(), epoch]);
        purged += deleted.rowCount ?? 0;
      }
      await client.query("UPDATE control.comparison_definitions SET active=false WHERE tenant_id=$1 AND app_id=$2 AND privacy_epoch<>$3", [tenantId, appId, epoch]);
      if (pending) return;
      const candidates = await client.query<{ comparison_id: string; definition: ComparisonDefinition; day: string; left_snapshot: Snapshot | null; right_snapshot: Snapshot | null;
        left_provenance: Record<string,unknown> | null; right_provenance: Record<string,unknown> | null }>(`
        SELECT d.comparison_id,d.definition,day::date::text AS day,l.snapshot AS left_snapshot,r.snapshot AS right_snapshot,
          l.provenance AS left_provenance,r.provenance AS right_provenance
        FROM control.comparison_definitions d
        CROSS JOIN LATERAL generate_series((d.definition->>'first_date')::date,
          LEAST((d.definition->>'last_date')::date,($3::timestamptz AT TIME ZONE 'UTC')::date-(d.definition->>'watermark_lag_days')::integer),interval '1 day') day
        LEFT JOIN control.comparison_snapshots l ON l.comparison_id=d.comparison_id AND l.target_date=day::date AND l.side='left' AND l.expires_at>$3
        LEFT JOIN control.comparison_snapshots r ON r.comparison_id=d.comparison_id AND r.target_date=day::date AND r.side='right' AND r.expires_at>$3
        WHERE d.tenant_id=$1 AND d.app_id=$2 AND d.active AND d.privacy_epoch=$4
        AND (d.comparison_id || ':' || day::date::text = ANY($5::text[]) OR NOT EXISTS(SELECT 1 FROM control.comparison_runs old WHERE old.comparison_id=d.comparison_id AND old.target_date=day::date
          AND old.left_digest IS NOT DISTINCT FROM l.snapshot_digest AND old.right_digest IS NOT DISTINCT FROM r.snapshot_digest))
        ORDER BY (d.comparison_id || ':' || day::date::text = ANY($5::text[])) DESC,day,d.comparison_id LIMIT 20`,
        [tenantId, appId, now.toISOString(), epoch, [...localAttempts.keys()]]);
      for (const row of candidates.rows) {
        const base = recurringComparisonResult(row.definition, row.day, row.left_snapshot, row.right_snapshot);
        const localInput = row.left_snapshot ? undefined : localAttempts.get(`${row.comparison_id}:${row.day}`);
        const result = row.definition.local_selection ? { ...base,
          ...(localInput ? { local_input: localInput } : {}),
          input_provenance: { left: row.left_provenance, right: row.right_provenance } } : base;
        if (Buffer.byteLength(jcs(result), "utf8") > limits.bytes) throw Error("comparison_result_limit");
        const id = comparisonDigest([row.comparison_id, result]);
        const inserted = await client.query(`INSERT INTO control.comparison_runs(run_id,tenant_id,app_id,comparison_id,target_date,left_digest,right_digest,result,created_at,expires_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(run_id) DO NOTHING`, [id, tenantId, appId, row.comparison_id, row.day,
          result.left_snapshot_digest, result.right_snapshot_digest, result, now.toISOString(), new Date(now.valueOf()+row.definition.retention_days*86400000).toISOString()]);
        completed += inserted.rowCount ?? 0;
      }
      await appBudget(client, scope);
    });
  }
  return { completed, purged };
}
