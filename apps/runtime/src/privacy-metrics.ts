import type { PoolClient } from "pg";
import { sha256 } from "@openmasu/attribution-core/canonical";

type Artifact = Record<string, unknown>;
type ReplayArtifact = Artifact & {
  version: 1; source_metric_run_id: string;
  metric_definition: Artifact & { metric_name: string };
  evaluation: Artifact & { input_received_at_watermark: string };
  fx_policy: Artifact;
};
export type PrivacyMetricRequest = Readonly<{
  tenant_id: string; app_id: string; privacy_request_id: string;
  deletion_scope: "installation" | "app" | "tenant";
  requested_at: string; affected_record_ids: readonly string[];
}>;
export type PrivacyMetricItem = Readonly<{
  tenant_id: string; app_id: string; recalculation_id: string; source_metric_run_id: string;
  replay_digest: string | null; privacy_request_id: string; completed_at: string;
}>;
export type PrivacyMetricCalculation = Readonly<{
  scope: { tenant_id: string; app_id: string };
  input: { fx_policy: Artifact; metric_definitions: readonly Artifact[]; metric_evaluations: readonly Artifact[] };
}>;
export type PrivacyCalculatedMetric = Artifact & {
  metric_run_id: string; supersedes_metric_run_id?: string;
  data_freshness: string; input_received_at_watermark: string;
};
export type PrivacyMetricCalculator = (
  client: PoolClient, calculation: PrivacyMetricCalculation,
) => Promise<readonly PrivacyCalculatedMetric[]>;

function object(value: unknown): value is Artifact {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function replayAvailable(replay: unknown): replay is ReplayArtifact {
  return object(replay) && replay.version === 1 && typeof replay.source_metric_run_id === "string"
    && object(replay.metric_definition) && typeof replay.metric_definition.metric_name === "string"
    && object(replay.evaluation) && typeof replay.evaluation.input_received_at_watermark === "string"
    && object(replay.fx_policy);
}

/** Fixed SQL aliases only. Redaction overrides historical report watermarks. */
export function privacyMetricInvalidationSql(alias: "mr" | "run"): string {
  return `EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(${alias}.artifact->'evidence_refs','[]'::jsonb)) AS privacy_ref
    JOIN ledger.raw_payload_states AS privacy_state ON privacy_state.tenant_id=${alias}.tenant_id
      AND privacy_state.app_id=${alias}.app_id AND privacy_state.record_id=privacy_ref->>'ref'
    WHERE coalesce(privacy_ref->>'lifecycle_status','available')='available'
      AND privacy_state.lifecycle_status<>'available' AND privacy_state.privacy_request_id IS NOT NULL)`;
}

/** Caller owns the tenant scope, privacy fence and transaction. No pool or commit here. */
export async function requestPrivacyMetricRecalculations(client: PoolClient, request: PrivacyMetricRequest): Promise<void> {
  const records = [...new Set(request.affected_record_ids)].sort();
  // computed_at is replay metadata, not an insertion boundary. Select the current scoped snapshot.
  const selected = await client.query<{
    app_id: string; metric_run_id: string; cohort_date: string | null; watermark: string; replay: Artifact | null;
  }>(`SELECT run.app_id,run.metric_run_id,coalesce(run.grouping->>'cohort_date',run.grouping->>'metric_date') AS cohort_date,
      run.input_received_at_watermark AS watermark,manifest.artifact AS replay
    FROM ledger.metric_runs AS run
    LEFT JOIN control.metric_replay_manifests AS manifest ON manifest.tenant_id=run.tenant_id
      AND manifest.app_id=run.app_id AND manifest.source_metric_run_id=run.metric_run_id
    WHERE run.tenant_id=$1 AND ($2='tenant' OR run.app_id=$3)
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(run.artifact->'evidence_refs','[]'::jsonb)) AS ref
        WHERE ref->>'ref'=ANY($4::text[]) AND coalesce(ref->>'lifecycle_status','available')='available')
      AND NOT EXISTS (SELECT 1 FROM ledger.metric_runs AS replacement WHERE replacement.tenant_id=run.tenant_id
        AND replacement.app_id=run.app_id AND replacement.supersedes_metric_run_id=run.metric_run_id)
    ORDER BY run.app_id COLLATE "C",run.metric_run_id COLLATE "C"`,
  [request.tenant_id, request.deletion_scope, request.app_id, records]);
  const apps = new Map<string, typeof selected.rows>();
  for (const row of selected.rows) {
    const rows = apps.get(row.app_id) ?? [];
    if (!apps.has(row.app_id)) apps.set(row.app_id, rows);
    rows.push(row);
  }
  for (const [appId, rows] of apps) {
    const digest = sha256(["privacy_deletion", request.tenant_id, appId, request.privacy_request_id]);
    const id = `privacy-recalculation:${digest.slice(0, 48)}`;
    const dates = rows.map(row => row.cohort_date ?? request.requested_at.slice(0, 10)).sort();
    const watermark = rows.map(row => row.watermark).sort().at(-1)!;
    await client.query(`INSERT INTO control.metric_recalculation_jobs
      (recalculation_id,tenant_id,app_id,request_digest,date_from,date_to,watermark,created_at,
        trigger_kind,source_snapshot_digest,privacy_request_id)
      VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8,'privacy_deletion',$9,$10)
      ON CONFLICT (tenant_id,app_id,request_digest) DO NOTHING`,
    [id, request.tenant_id, appId, digest, dates[0], dates.at(-1), watermark, request.requested_at,
      sha256(records), request.privacy_request_id]);
    for (const row of rows) {
      const available = replayAvailable(row.replay);
      await client.query(`INSERT INTO control.metric_recalculation_items
        (recalculation_id,tenant_id,app_id,source_metric_run_id,replay_digest,state,safe_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (recalculation_id,source_metric_run_id) DO NOTHING`,
      [id, request.tenant_id, appId, row.metric_run_id, available ? sha256(row.replay) : null,
        available ? "queued" : "unavailable", available ? null : "replay_unavailable"]);
    }
  }
}

/** Both the durable worker and offline restore use the same saved calculation and publication rule. */
export async function replayPrivacyMetricItem(
  client: PoolClient, item: PrivacyMetricItem, calculate: PrivacyMetricCalculator,
): Promise<string | undefined> {
  const superseded = await client.query(`SELECT 1 FROM ledger.metric_runs WHERE tenant_id=$1 AND app_id=$2
    AND supersedes_metric_run_id=$3`, [item.tenant_id, item.app_id, item.source_metric_run_id]);
  if (superseded.rowCount) return undefined;
  const manifest = await client.query<{ artifact: Artifact }>(`SELECT artifact FROM control.metric_replay_manifests
    WHERE tenant_id=$1 AND app_id=$2 AND source_metric_run_id=$3`, [item.tenant_id, item.app_id, item.source_metric_run_id]);
  const replay = manifest.rows[0]?.artifact ?? null;
  if (!replayAvailable(replay) || sha256(replay) !== item.replay_digest
      || replay.source_metric_run_id !== item.source_metric_run_id) throw new Error("definition_changed");
  const name = replay.metric_definition.metric_name;
  if (typeof name !== "string" || !/^[a-z][a-z0-9_]{2,80}$/.test(name)) throw new Error("definition_changed");
  const prefix = `privacy-recalc:${sha256([item.privacy_request_id, item.app_id, item.source_metric_run_id]).slice(0, 32)}`;
  const evaluation = { ...replay.evaluation, metric_names: [name], metric_run_id_prefix: prefix,
    supersedes_metric_run_id_prefix: undefined, supersedes_metric_run_id: item.source_metric_run_id,
    privacy_state: "after", computed_at: item.completed_at, data_freshness: "recalculated" };
  // Keep each original watermark, complete grouping, definition and FX snapshot.
  const runs = await calculate(client, { scope: { tenant_id: item.tenant_id, app_id: item.app_id },
    input: { fx_policy: replay.fx_policy, metric_definitions: [replay.metric_definition], metric_evaluations: [evaluation] } });
  if (runs.length !== 1 || runs[0].metric_run_id !== `${prefix}:${name}`
      || runs[0].supersedes_metric_run_id !== item.source_metric_run_id
      || runs[0].data_freshness !== "recalculated"
      || runs[0].input_received_at_watermark !== replay.evaluation.input_received_at_watermark) {
    throw new Error("definition_changed");
  }
  return runs[0].metric_run_id;
}

/** Offline restore owns the exclusive tenant fence and transaction; online work uses leased claims. */
export async function reapplyPrivacyMetricsWithClient(
  client: PoolClient, request: PrivacyMetricRequest & { completed_at: string }, calculate: PrivacyMetricCalculator,
): Promise<{ recalculated: number; unsupported: number }> {
  await requestPrivacyMetricRecalculations(client, request);
  const items = await client.query<PrivacyMetricItem & { state: string }>(`SELECT item.*,job.privacy_request_id
    FROM control.metric_recalculation_items AS item JOIN control.metric_recalculation_jobs AS job
      USING (tenant_id,app_id,recalculation_id)
    WHERE job.tenant_id=$1 AND job.privacy_request_id=$2 AND job.trigger_kind='privacy_deletion'
    ORDER BY item.app_id COLLATE "C",item.source_metric_run_id COLLATE "C" FOR UPDATE OF item`,
  [request.tenant_id, request.privacy_request_id]);
  let recalculated = 0, unsupported = 0;
  for (const item of items.rows) {
    if (item.state === "completed") { recalculated += 1; continue; }
    if (item.state === "skipped") continue;
    if (["unavailable", "failed"].includes(item.state)) { unsupported += 1; continue; }
    const replacementId = await replayPrivacyMetricItem(client, { ...item, completed_at: request.completed_at }, calculate);
    await client.query(`UPDATE control.metric_recalculation_items SET state=$5,replacement_metric_run_id=$6,
      safe_reason=$7,lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND app_id=$2 AND recalculation_id=$3 AND source_metric_run_id=$4`,
    [item.tenant_id, item.app_id, item.recalculation_id, item.source_metric_run_id,
      replacementId ? "completed" : "skipped", replacementId ?? null, replacementId ? null : "already_superseded"]);
    if (replacementId) recalculated += 1;
  }
  return { recalculated, unsupported };
}
