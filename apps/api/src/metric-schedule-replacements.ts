import type { Pool, PoolClient } from "pg";
import { sha256Jcs } from "@openmasu/fraud-rules";
import {
  captureMetricComparisonContext, metricScheduleCalculationKey, scheduledMetricPrefix, privacyMetricInvalidationSql, withTenant,
  type MetricComparisonContext, type MetricScheduleHandoff, type MetricScheduleProvenance,
} from "@openmasu/runtime";
import type { OpenMasuMetricRunV04 } from "@openmasu/contracts/types";
import { M1B_METRIC_DEFINITIONS, REFERENCE_AD_REVENUE_METRIC_DEFINITIONS } from "@openmasu/contracts/definitions";
import type { AppAdminIdentity } from "./admin-auth.js";
import {
  metricScheduleTargetDate, normalizeMetricScheduleRequest,
  saveMetricScheduleWithClient, type MetricScheduleRecord,
} from "./metric-schedules.js";
import { metricScheduleRequestDefinition } from "./metric-schedule-definition.js";
import { recordDashboardAuditWithClient } from "./session.js";

type Json = Record<string, unknown>;
type SourceRun = {
  artifact: OpenMasuMetricRunV04; comparison_context: MetricComparisonContext | null;
  superseded: boolean; privacy_changed: boolean;
};
type HistoryRun = SourceRun & { provenance: MetricScheduleProvenance };
type ReplacementRequest = {
  mode: "same_meaning" | "new_series";
  schedule: ReturnType<typeof normalizeMetricScheduleRequest>;
  supersessions: readonly { source_metric_run_id: string; calculation_key_digest: string }[];
  previewDigest?: string;
};
const identifier = /^[A-Za-z0-9._:-]{1,128}$/;
const digest = /^[a-f0-9]{64}$/;

export function normalizeMetricScheduleReplacement(body: Json, now: Date): ReplacementRequest {
  if (Object.keys(body).some(key => !["mode", "schedule", "supersessions", "preview_digest"].includes(key))
      || typeof body.mode !== "string" || !["same_meaning", "new_series"].includes(body.mode)
      || !body.schedule || typeof body.schedule !== "object" || Array.isArray(body.schedule)) {
    throw new Error("metric_schedule_replacement_invalid");
  }
  const candidates = body.supersessions ?? [];
  if (!Array.isArray(candidates) || candidates.length > 100) throw new Error("metric_schedule_supersessions_invalid");
  const supersessions = candidates.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("metric_schedule_supersessions_invalid");
    const row = value as Json;
    if (Object.keys(row).sort().join(",") !== "calculation_key_digest,source_metric_run_id"
        || typeof row.source_metric_run_id !== "string" || !identifier.test(row.source_metric_run_id)
        || typeof row.calculation_key_digest !== "string" || !digest.test(row.calculation_key_digest)) {
      throw new Error("metric_schedule_supersessions_invalid");
    }
    return { source_metric_run_id: row.source_metric_run_id, calculation_key_digest: row.calculation_key_digest };
  }).sort((a, b) => a.source_metric_run_id < b.source_metric_run_id ? -1 : 1);
  if (new Set(supersessions.map(row => row.source_metric_run_id)).size !== supersessions.length
      || (body.mode === "new_series" && supersessions.length)) throw new Error("metric_schedule_supersessions_invalid");
  if (body.preview_digest !== undefined && (typeof body.preview_digest !== "string" || !digest.test(body.preview_digest))) {
    throw new Error("metric_schedule_preview_invalid");
  }
  return { mode: body.mode as ReplacementRequest["mode"], schedule: normalizeMetricScheduleRequest(body.schedule as Json, now),
    supersessions, ...(body.preview_digest ? { previewDigest: body.preview_digest as string } : {}) };
}

/** Recognize historical run IDs using the complete deterministic schedule key. */
async function scheduleHistory(client: PoolClient, identity: AppAdminIdentity, schedule: MetricScheduleRecord): Promise<HistoryRun[]> {
  const scope = [identity.tenantId, identity.appId, schedule.metric_schedule_id];
  const runs = (await client.query<SourceRun & { saved_provenance: MetricScheduleProvenance | null }>(
    `SELECT mr.artifact,mr.comparison_context,${privacyMetricInvalidationSql("mr")} AS privacy_changed,
       EXISTS (SELECT 1 FROM ledger.metric_runs AS successor WHERE successor.tenant_id=mr.tenant_id
         AND successor.app_id=mr.app_id AND successor.supersedes_metric_run_id=mr.metric_run_id) AS superseded,
       CASE WHEN membership.metric_run_id IS NOT NULL THEN jsonb_build_object(
         'metric_schedule_id',membership.metric_schedule_id,'target_date',membership.target_date::text,
         'evaluation',membership.evaluation,'definition_digest',membership.definition_digest) END AS saved_provenance
       FROM ledger.metric_runs AS mr LEFT JOIN control.metric_schedule_runs AS membership
         ON membership.tenant_id=mr.tenant_id AND membership.app_id=mr.app_id
           AND membership.metric_run_id=mr.metric_run_id AND membership.metric_schedule_id=$3
       WHERE mr.tenant_id=$1 AND mr.app_id=$2 AND mr.metric_name=ANY($4::text[])
       ORDER BY mr.metric_run_id COLLATE "C" LIMIT 10001`,
    [...scope, [...new Set(schedule.definition.evaluations.flatMap(row => row.metric_names))]],
  )).rows;
  if (runs.length > 10000) throw new Error("metric_schedule_history_limit");
  const targets = (await client.query<{ target_date: string; watermark: string; target_digest: string;
    artifact: { targets: { evaluation: number; grouping: Record<string, string> }[] } }>(
    `SELECT target_date::text,watermark,target_digest,artifact FROM control.metric_schedule_targets
      WHERE tenant_id=$1 AND app_id=$2 AND metric_schedule_id=$3`, scope,
  )).rows;
  const found = new Map<string, HistoryRun>();
  for (const row of runs) {
    if (row.saved_provenance) {
      found.set(row.artifact.metric_run_id, { ...row, provenance: row.saved_provenance }); continue;
    }
    const run = row.artifact, dimensions = run.grouping?.dimensions ?? {};
    schedule.definition.evaluations.forEach((evaluation, index) => {
      const date = dimensions[evaluation.date_dimension];
      if (!date || !evaluation.metric_names.includes(run.metric_name)) return;
      const provenance = { metric_schedule_id: schedule.metric_schedule_id, target_date: date,
        evaluation: index, definition_digest: schedule.definition_digest };
      if (evaluation.campaign_discovery) {
        for (const target of targets.filter(target => target.target_date === date && target.watermark === run.input_received_at_watermark)) {
          for (const selected of target.artifact.targets.filter(selected => selected.evaluation === index)) {
            if (sha256Jcs(dimensions) !== sha256Jcs({ ...selected.grouping, [evaluation.date_dimension]: date })) continue;
            const prefix = scheduledMetricPrefix({ ...provenance, watermark: target.watermark,
              target: selected.grouping, target_digest: target.target_digest });
            if (run.metric_run_id === `${prefix}:${run.metric_name}`) found.set(run.metric_run_id, { ...row, provenance });
          }
        }
      } else if (sha256Jcs(dimensions) === sha256Jcs({ ...evaluation.grouping, [evaluation.date_dimension]: date })) {
        const prefix = scheduledMetricPrefix({ ...provenance, watermark: run.input_received_at_watermark });
        if (run.metric_run_id === `${prefix}:${run.metric_name}`) found.set(run.metric_run_id, { ...row, provenance });
      }
    });
  }
  // Recalculations explicitly point to their source; retain that series' history.
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of runs) {
      const parent = row.artifact.supersedes_metric_run_id && found.get(row.artifact.supersedes_metric_run_id);
      if (parent && !found.has(row.artifact.metric_run_id)) {
        found.set(row.artifact.metric_run_id, { ...row, provenance: parent.provenance }); changed = true;
      }
    }
  }
  return [...found.values()].sort((a, b) => a.artifact.metric_run_id < b.artifact.metric_run_id ? -1 : 1);
}

export type MetricScheduleReplacementPreview = {
  source_metric_schedule_id: string; mode: ReplacementRequest["mode"];
  schedule: Json; definition_matches: boolean; effective_start_date: string;
  definition_changes: readonly { field: string; before: unknown; after: unknown }[];
  in_flight: { policy: "wait_for_claimed_date"; pending_target_date: string | null; can_replace: boolean };
  source_runs: readonly (MetricScheduleHandoff & { calculation_key: ReturnType<typeof metricScheduleCalculationKey>; can_supersede: boolean })[];
  preview_digest: string;
};

async function previewWithClient(client: PoolClient, identity: AppAdminIdentity, sourceId: string,
  request: ReplacementRequest, now: Date) {
  const source = (await client.query<MetricScheduleRecord>(
    `SELECT schedule.*,schedule.start_date::text,checkpoint.last_target_date::text,checkpoint.pending_target_date::text
       FROM control.metric_schedules_current AS schedule JOIN control.metric_schedule_checkpoints AS checkpoint
         USING (tenant_id,app_id,metric_schedule_id)
       WHERE schedule.tenant_id=$1 AND schedule.app_id=$2 AND schedule.metric_schedule_id=$3`,
    [identity.tenantId, identity.appId, sourceId],
  )).rows[0];
  if (!source) throw new Error("metric_schedule_not_found");
  const history = await scheduleHistory(client, identity, source);
  const definitionMatches = source.definition_digest === request.schedule.definitionDigest;
  if (request.mode === "same_meaning" && !definitionMatches) throw new Error("metric_schedule_meaning_changed");
  const watermark = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const sourceRuns: MetricScheduleReplacementPreview["source_runs"][number][] = [];
  for (const row of history) {
    if (!row.comparison_context) continue; // Unknown meaning is readable history, never a supersession candidate.
    const key = metricScheduleCalculationKey({ tenant_id: identity.tenantId, app_id: identity.appId }, row.artifact, row.comparison_context);
    const evaluation = request.schedule.definition.evaluations[row.provenance.evaluation];
    const selectedDefinition = [...REFERENCE_AD_REVENUE_METRIC_DEFINITIONS, ...M1B_METRIC_DEFINITIONS,
      ...request.schedule.definition.metric_definitions].filter(definition => definition.metric_name === row.artifact.metric_name).at(-1);
    const privacyState = request.schedule.definition.metric_definitions.some(definition =>
      evaluation?.metric_names.includes(definition.metric_name)
      && (definition.acquisition_basis || definition.cost_selection_policy || definition.engagement_credit_policy)) ? "after" : "before";
    const expected = selectedDefinition ? captureMetricComparisonContext(row.artifact, selectedDefinition as MetricComparisonContext["definition"],
      request.schedule.definition.fx_policy as Parameters<typeof captureMetricComparisonContext>[2], privacyState, sha256Jcs) : undefined;
    sourceRuns.push({ ...row.provenance, source_metric_run_id: row.artifact.metric_run_id,
      calculation_key_digest: sha256Jcs(key), metric_name: row.artifact.metric_name,
      grouping: row.artifact.grouping?.dimensions ?? {}, calculation_key: key,
      can_supersede: request.mode === "same_meaning" && !row.superseded && !row.privacy_changed
        && row.provenance.definition_digest === source.definition_digest
        && expected?.definition_digest === row.comparison_context.definition_digest
        && expected.fx_digest === row.comparison_context.fx_digest && privacyState === row.comparison_context.privacy_state
        && row.provenance.target_date >= request.schedule.startDate
        && row.provenance.target_date <= metricScheduleTargetDate(now, request.schedule.lagDays, request.schedule.definition.cohort_time_zone ?? "UTC")
        && row.artifact.input_received_at_watermark <= watermark });
  }
  const schedule: Json = { lag_days: request.schedule.lagDays, start_date: request.schedule.startDate, ...metricScheduleRequestDefinition(request.schedule.definition) };
  const oldSchedule: Json = { lag_days: source.lag_days, start_date: source.start_date, ...metricScheduleRequestDefinition(source.definition) };
  const changes = Object.keys(schedule).filter(key => sha256Jcs(oldSchedule[key]) !== sha256Jcs(schedule[key]))
    .map(field => ({ field, before: oldSchedule[field], after: schedule[field] }));
  const preview = { source_metric_schedule_id: sourceId, mode: request.mode, schedule,
    definition_matches: definitionMatches, effective_start_date: request.schedule.startDate, definition_changes: changes,
    in_flight: { policy: "wait_for_claimed_date" as const, pending_target_date: source.pending_target_date ?? null,
      can_replace: source.status === "active" && !source.pending_target_date }, source_runs: sourceRuns };
  const previewDigest = sha256Jcs({ ...preview, status: source.status, last_target_date: source.last_target_date, watermark });
  const supersessions = request.supersessions.map(selected => {
    const run = sourceRuns.find(row => row.source_metric_run_id === selected.source_metric_run_id);
    if (!run?.can_supersede || run.calculation_key_digest !== selected.calculation_key_digest) {
      throw new Error("metric_schedule_source_key_conflict");
    }
    const { calculation_key: _key, can_supersede: _can, ...handoff } = run;
    return handoff;
  });
  if (new Set(supersessions.map(row => sha256Jcs([row.target_date, row.evaluation, row.metric_name, row.grouping]))).size !== supersessions.length) {
    throw new Error("metric_schedule_supersession_target_conflict");
  }
  return { source, history, supersessions, preview: { ...preview, preview_digest: previewDigest } };
}

export async function previewMetricScheduleReplacement(pool: Pool, identity: AppAdminIdentity, sourceId: string, body: Json, now = new Date()) {
  if (!identifier.test(sourceId)) throw new Error("metric_schedule_not_found");
  const request = normalizeMetricScheduleReplacement(body, now);
  return withTenant(pool, identity.tenantId, async client => (await previewWithClient(client, identity, sourceId, request, now)).preview);
}

export async function replaceMetricSchedule(pool: Pool, identity: AppAdminIdentity, sourceId: string, body: Json, now = new Date()) {
  if (!identifier.test(sourceId)) throw new Error("metric_schedule_not_found");
  const request = normalizeMetricScheduleReplacement(body, now);
  if (!request.previewDigest) throw new Error("metric_schedule_preview_required");
  const requestDigest = sha256Jcs({ sourceId, mode: request.mode, schedule: request.schedule,
    supersessions: request.supersessions, preview_digest: request.previewDigest });
  return withTenant(pool, identity.tenantId, async client => {
    for (const key of [JSON.stringify([identity.tenantId, identity.appId, "metric-schedules"]),
      JSON.stringify([identity.tenantId, identity.appId, sourceId]),
      ...request.supersessions.map(row => JSON.stringify([identity.tenantId, identity.appId, "metric-recalculation", row.source_metric_run_id]))]) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
    }
    const existing = (await client.query<{ metric_schedule_id: string }>(
      `SELECT metric_schedule_id FROM control.metric_schedules WHERE tenant_id=$1 AND app_id=$2
        AND artifact->'replacement'->>'request_digest'=$3`, [identity.tenantId, identity.appId, requestDigest],
    )).rows[0];
    if (existing) return { ...(await listMetricSchedulesWithClient(client, identity)).find(row => row.metric_schedule_id === existing.metric_schedule_id)!, replayed: true };
    const { source, history, supersessions, preview } = await previewWithClient(client, identity, sourceId, request, now);
    if (source.status !== "active") throw new Error("metric_schedule_not_active");
    if (source.pending_target_date) throw new Error("metric_schedule_date_in_flight");
    if (preview.preview_digest !== request.previewDigest) throw new Error("metric_schedule_preview_stale");
    await client.query(`INSERT INTO control.metric_schedule_states (metric_schedule_id,tenant_id,app_id,status,changed_at,artifact)
      VALUES ($1,$2,$3,'disabled',$4,$5::jsonb)`, [sourceId, identity.tenantId, identity.appId, now.toISOString(),
      JSON.stringify({ metric_schedule_id: sourceId, status: "disabled", changed_at: now.toISOString(), reason: "explicit_replacement" })]);
    for (const row of history) {
      const p = row.provenance;
      await client.query(`INSERT INTO control.metric_schedule_runs
        (tenant_id,app_id,metric_run_id,metric_schedule_id,target_date,evaluation,definition_digest)
        VALUES ($1,$2,$3,$4,$5::date,$6,$7) ON CONFLICT (tenant_id,app_id,metric_run_id) DO NOTHING`,
      [identity.tenantId, identity.appId, row.artifact.metric_run_id, sourceId, p.target_date, p.evaluation, p.definition_digest]);
    }
    const saved = await saveMetricScheduleWithClient(client, identity, request.schedule, now, {
      source_metric_schedule_id: sourceId, mode: request.mode, request_digest: requestDigest,
      preview_digest: preview.preview_digest, in_flight_policy: "wait_for_claimed_date", supersessions,
    });
    await recordDashboardAuditWithClient(client, { tenantId: identity.tenantId, appId: identity.appId,
      actorRef: `admin_key:${identity.keyId}`, action: "metric_schedule_replaced", targetScope: "metric_schedule",
      targetRef: sourceId, outcome: "succeeded", now });
    return { ...saved, replayed: false };
  });
}

// No second pool/transaction while the replacement lock is held.
async function listMetricSchedulesWithClient(client: PoolClient, identity: AppAdminIdentity): Promise<MetricScheduleRecord[]> {
  return (await client.query<MetricScheduleRecord>(`SELECT schedule.*,schedule.start_date::text,
    checkpoint.last_target_date::text,schedule.artifact->'replacement' AS replacement
    FROM control.metric_schedules_current AS schedule JOIN control.metric_schedule_checkpoints AS checkpoint
      USING (tenant_id,app_id,metric_schedule_id) WHERE schedule.tenant_id=$1 AND schedule.app_id=$2`,
  [identity.tenantId, identity.appId])).rows;
}
