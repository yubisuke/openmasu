import type { Pool, PoolClient } from "pg";
import { sha256Jcs } from "@openmasu/fraud-rules";
import { acquirePrivacyTenantSessionReadFence, recordJobOutcome, runWithTerminalJobOutcome, scheduledMetricPrefix,
  withTenant, type MetricScheduleReplacement } from "@openmasu/runtime";
import { computeSqlMetricRuns, computeSqlMetricRunsWithClient, type MetricScope } from "./metrics/cohort.js";
import { buildMetricDefinitionsInput } from "./metrics/run.js";
import { freezeCampaignTargets, schedulePrivacyEpoch, type CampaignTargetSet } from "./metric-campaign-discovery.js";
import { cohortLocalDate, cohortDayStart, addCalendarDays, type CohortTimeZone } from "@openmasu/contracts/definitions";

type Any = Record<string, any>;

type MetricScheduleRow = Readonly<{
  metric_schedule_id: string;
  tenant_id: string;
  app_id: string;
  lag_days: number;
  start_date: string;
  definition: Any;
  definition_digest: string;
  replacement?: MetricScheduleReplacement | null;
}>;

type PendingRun = Readonly<{
  targetDate: string;
  watermark: string;
  definitionDigest: string;
  targetSet?: CampaignTargetSet;
}>;

export type MetricScheduleCycle = Readonly<{
  schedules: number;
  completedDates: number;
  replayedDates: number;
  failedSchedules: number;
}>;

const maximumCatchupDates = 31;
const discoversCampaigns = (schedule: MetricScheduleRow): boolean => schedule.definition.evaluations.some((row: Any) => row.campaign_discovery);

async function discoveryTransaction<T>(pool: Pool, schedule: MetricScheduleRow, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const key = JSON.stringify([schedule.tenant_id, schedule.app_id, schedule.metric_schedule_id]);
  let releaseFence: (() => Promise<void>) | undefined, locked = false, begun = false, priorTimeout: string | undefined;
  const sourceLocks: string[] = [];
  try {
    priorTimeout = (await client.query("SELECT current_setting('statement_timeout') AS value")).rows[0].value;
    await client.query("SELECT set_config('statement_timeout','60000',false)");
    releaseFence = await acquirePrivacyTenantSessionReadFence(client, schedule.tenant_id);
    await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]); locked = true;
    // Same source-run fence as cost/late/privacy replay, acquired before the snapshot.
    for (const sourceId of [...new Set(schedule.replacement?.supersessions.map(row => row.source_metric_run_id) ?? [])].sort()) {
      const sourceKey = JSON.stringify([schedule.tenant_id, schedule.app_id, "metric-recalculation", sourceId]);
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [sourceKey]); sourceLocks.push(sourceKey);
    }
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ"); begun = true;
    await client.query("SELECT set_config('openmasu.tenant_id',$1,true)", [schedule.tenant_id]);
    const backlog = await client.query("SELECT pending_count FROM control.privacy_deletion_backlog()");
    if (backlog.rows[0]?.pending_count !== "0") throw new Error("metric_schedule_privacy_pending");
    const result = await work(client);
    await client.query("COMMIT"); begun = false;
    return result;
  } finally {
    let cleanupError: Error | undefined;
    try {
      if (begun) await client.query("ROLLBACK");
      for (const sourceKey of sourceLocks.reverse()) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [sourceKey]);
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [key]);
      if (releaseFence) await releaseFence();
      if (priorTimeout !== undefined) await client.query("SELECT set_config('statement_timeout',$1,false)", [priorTimeout]);
    } catch { cleanupError = new Error("metric_schedule_cleanup_failed"); }
    client.release(cleanupError);
  }
}

function exactDate(value: string): string {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)
      || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error("metric_schedule_date_invalid");
  }
  return value;
}

function nextDate(value: string): string {
  return new Date(Date.parse(`${exactDate(value)}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function scheduledMetricBoundary(now: Date, lagDays: number, zone: CohortTimeZone = "UTC"): Readonly<{
  targetDate: string;
  watermark: string;
}> {
  if (!Number.isFinite(now.valueOf())) throw new Error("metric_schedule_time_invalid");
  if (!Number.isSafeInteger(lagDays) || lagDays < 1 || lagDays > 365) {
    throw new Error("metric_schedule_lag_days_invalid");
  }
  const day = cohortLocalDate(now, zone);
  return {
    targetDate: addCalendarDays(day, -lagDays),
    watermark: cohortDayStart(day, zone),
  };
}

export function buildScheduledMetricInput(
  schedule: MetricScheduleRow,
  pending: PendingRun,
): Any {
  if (sha256Jcs(schedule.definition) !== schedule.definition_digest
      || pending.definitionDigest !== schedule.definition_digest) {
    throw new Error("metric_schedule_definition_digest_mismatch");
  }
  const evaluations = schedule.definition.evaluations;
  if (!Array.isArray(evaluations) || evaluations.length < 1) {
    throw new Error("metric_schedule_evaluations_invalid");
  }
  if (discoversCampaigns(schedule) && !pending.targetSet) throw new Error("metric_schedule_target_mismatch");
  const selected = pending.targetSet?.targets.map(target => ({ ...evaluations[target.evaluation],
    grouping: target.grouping, sourceIndex: target.evaluation })) ?? evaluations.map((evaluation: Any, index: number) => ({ ...evaluation, sourceIndex: index }));
  if (pending.targetSet && sha256Jcs(pending.targetSet.targets) !== pending.targetSet.target_digest) throw new Error("metric_schedule_target_mismatch");
  const config = {
    tenant_id: schedule.tenant_id,
    app_id: schedule.app_id,
    fx_policy: schedule.definition.fx_policy,
    metric_definitions: schedule.definition.metric_definitions ?? [],
    evaluations: selected.map((evaluation: Any) => {
      if (evaluation.date_dimension !== "cohort_date" && evaluation.date_dimension !== "metric_date") {
        throw new Error("metric_schedule_date_dimension_invalid");
      }
      return {
        metric_names: evaluation.metric_names,
        grouping: { ...(evaluation.grouping ?? {}), [evaluation.date_dimension]: pending.targetDate },
      };
    }),
  };
  const input = buildMetricDefinitionsInput(config, pending.targetDate, pending.watermark);
  input.metric_evaluations = input.metric_evaluations.map((evaluation: Any, index: number) => {
    const grouping = selected[index].date_dimension === "metric_date"
      ? Object.fromEntries(Object.entries(evaluation.grouping).filter(([key]) => key !== "cohort_date"))
      : evaluation.grouping;
    const provenance = { metric_schedule_id: schedule.metric_schedule_id, target_date: pending.targetDate,
      definition_digest: pending.definitionDigest, evaluation: selected[index].sourceIndex };
    const handoffs = schedule.replacement?.supersessions.filter(row => row.target_date === pending.targetDate
      && row.evaluation === selected[index].sourceIndex && sha256Jcs(row.grouping) === sha256Jcs(grouping)) ?? [];
    return {
    ...evaluation, grouping, metric_schedule: provenance,
    ...(handoffs.length ? { schedule_supersessions: Object.fromEntries(handoffs.map(row => [row.metric_name, row])) } : {}),
    metric_run_id_prefix: scheduledMetricPrefix({
      metric_schedule_id: schedule.metric_schedule_id,
      target_date: pending.targetDate,
      watermark: pending.watermark,
      definition_digest: pending.definitionDigest,
      evaluation: selected[index].sourceIndex,
      ...(pending.targetSet ? { target: selected[index].grouping, target_digest: pending.targetSet.target_digest } : {}),
    }),
    };
  });
  for (const handoff of schedule.replacement?.supersessions.filter(row => row.target_date === pending.targetDate) ?? []) {
    if (!input.metric_evaluations.some((evaluation: Any) => evaluation.schedule_supersessions?.[handoff.metric_name]?.source_metric_run_id === handoff.source_metric_run_id)) {
      throw new Error("metric_schedule_target_mismatch");
    }
  }
  return input;
}

export async function claimNextScheduledDate(
  pool: Pool,
  schedule: MetricScheduleRow,
  now: Date,
): Promise<PendingRun | undefined> {
  const boundary = scheduledMetricBoundary(now, schedule.lag_days, schedule.definition.cohort_time_zone ?? "UTC");
  const claim = async (client: PoolClient): Promise<PendingRun | undefined> => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [JSON.stringify([schedule.tenant_id, schedule.app_id, schedule.metric_schedule_id])],
    );
    const selected = await client.query<{
      last_target_date: string | null;
      pending_target_date: string | null;
      pending_watermark: string | null;
      pending_definition_digest: string | null;
    }>(
      `SELECT checkpoint.last_target_date::text,checkpoint.pending_target_date::text,
              checkpoint.pending_watermark,checkpoint.pending_definition_digest
         FROM control.metric_schedule_checkpoints AS checkpoint
         JOIN control.metric_schedules_current AS current
           USING (metric_schedule_id,tenant_id,app_id)
        WHERE checkpoint.tenant_id=$1 AND checkpoint.app_id=$2
          AND checkpoint.metric_schedule_id=$3 AND current.status='active'
        FOR UPDATE OF checkpoint`,
      [schedule.tenant_id, schedule.app_id, schedule.metric_schedule_id],
    );
    const checkpoint = selected.rows[0];
    if (!checkpoint) return undefined;
    if (checkpoint.pending_target_date) {
      if (!checkpoint.pending_watermark || !checkpoint.pending_definition_digest) {
        throw new Error("metric_schedule_pending_state_invalid");
      }
      const pending = {
        targetDate: checkpoint.pending_target_date,
        watermark: checkpoint.pending_watermark,
        definitionDigest: checkpoint.pending_definition_digest,
      };
      return discoversCampaigns(schedule) ? { ...pending, targetSet: await freezeCampaignTargets(client, schedule, pending) } : pending;
    }
    const targetDate = checkpoint.last_target_date ? nextDate(checkpoint.last_target_date) : exactDate(schedule.start_date);
    if (targetDate > boundary.targetDate) return undefined;
    await client.query(
      `UPDATE control.metric_schedule_checkpoints
          SET pending_target_date=$4::date,pending_watermark=$5::text::control.canonical_timestamp,
              pending_definition_digest=$6,updated_at=$5::text::control.canonical_timestamp
        WHERE tenant_id=$1 AND app_id=$2 AND metric_schedule_id=$3`,
      [schedule.tenant_id, schedule.app_id, schedule.metric_schedule_id,
        targetDate, boundary.watermark, schedule.definition_digest],
    );
    const pending = { targetDate, watermark: boundary.watermark, definitionDigest: schedule.definition_digest };
    return discoversCampaigns(schedule) ? { ...pending, targetSet: await freezeCampaignTargets(client, schedule, pending) } : pending;
  };
  return discoversCampaigns(schedule) ? discoveryTransaction(pool, schedule, claim) : withTenant(pool, schedule.tenant_id, claim);
}

async function finalizeDateWithClient(client: PoolClient, schedule: MetricScheduleRow, pending: PendingRun): Promise<void> {
    const updated = await client.query(
      `UPDATE control.metric_schedule_checkpoints
          SET last_target_date=$4::date,pending_target_date=NULL,pending_watermark=NULL,
              pending_definition_digest=NULL,safe_reason=NULL,updated_at=$5::text::control.canonical_timestamp
        WHERE tenant_id=$1 AND app_id=$2 AND metric_schedule_id=$3
          AND pending_target_date=$4::date
          AND pending_watermark=$5::text::control.canonical_timestamp
          AND pending_definition_digest=$6`,
      [schedule.tenant_id, schedule.app_id, schedule.metric_schedule_id,
        pending.targetDate, pending.watermark, pending.definitionDigest],
    );
    if (updated.rowCount !== 1) throw new Error("metric_schedule_checkpoint_conflict");
}

async function runPendingDate(
  pool: Pool,
  schedule: MetricScheduleRow,
  pending: PendingRun,
): Promise<"computed" | "replayed"> {
  if (pending.targetSet || schedule.replacement) return discoveryTransaction(pool, schedule, async client => {
    const checkpoint = (await client.query(`SELECT pending_target_date::text FROM control.metric_schedule_checkpoints
      WHERE tenant_id=$1 AND app_id=$2 AND metric_schedule_id=$3 FOR UPDATE`,
    [schedule.tenant_id, schedule.app_id, schedule.metric_schedule_id])).rows[0];
    if (checkpoint?.pending_target_date !== pending.targetDate) return "replayed";
    if (pending.targetSet && await schedulePrivacyEpoch(client, schedule.tenant_id, schedule.app_id) !== pending.targetSet.privacy_epoch) {
      throw new Error("metric_schedule_privacy_unavailable");
    }
    if (pending.targetSet && !pending.targetSet.targets.length) {
      await finalizeDateWithClient(client, schedule, pending);
      return "computed";
    }
    const outcome = await evaluatePendingDate(pool, schedule, pending, client);
    await finalizeDateWithClient(client, schedule, pending);
    return outcome;
  });
  const outcome = await evaluatePendingDate(pool, schedule, pending);
  await withTenant(pool, schedule.tenant_id, client => finalizeDateWithClient(client, schedule, pending));
  return outcome;
}

async function evaluatePendingDate(pool: Pool, schedule: MetricScheduleRow, pending: PendingRun, transaction?: PoolClient): Promise<"computed" | "replayed"> {
  const input = buildScheduledMetricInput(schedule, pending);
  const expectedIds = input.metric_evaluations.flatMap((evaluation: Any) =>
    evaluation.metric_names.map((name: string) => `${evaluation.metric_run_id_prefix}:${name}`));
  const scope: MetricScope = { tenant_id: schedule.tenant_id, app_id: schedule.app_id };
  const readExisting = async (client: PoolClient) => (await client.query<{
    metric_run_id: string;
    artifact: Any;
    manifest_count: number;
  }>(
    `SELECT run.metric_run_id,run.artifact,
            (SELECT count(*)::int FROM control.metric_replay_manifests AS manifest
              WHERE manifest.tenant_id=run.tenant_id AND manifest.app_id=run.app_id
                AND manifest.source_metric_run_id=run.metric_run_id) AS manifest_count
       FROM ledger.metric_runs AS run
      WHERE run.tenant_id=$1 AND run.app_id=$2 AND run.metric_run_id=ANY($3::text[])
      ORDER BY run.metric_run_id COLLATE "C"`,
    [schedule.tenant_id, schedule.app_id, expectedIds],
  )).rows;
  const existing = transaction ? await readExisting(transaction) : await withTenant(pool, schedule.tenant_id, readExisting);
  const calculate = (persist: boolean) => transaction ? computeSqlMetricRunsWithClient(transaction, input, persist, scope)
    : computeSqlMetricRuns(pool, input, persist, scope);
  if (existing.length === 0) {
    await calculate(true);
    return "computed";
  }
  if (existing.length !== expectedIds.length || existing.some((row) => row.manifest_count !== 1)) {
    throw new Error("metric_schedule_partial_run");
  }
  const expected = await calculate(false);
  const expectedById = new Map(expected.map((artifact: Any) => [artifact.metric_run_id, sha256Jcs(artifact)]));
  if (existing.some((row) => expectedById.get(row.metric_run_id) !== sha256Jcs(row.artifact))) {
    throw new Error("metric_schedule_replay_mismatch");
  }
  return "replayed";
}

export async function processMetricSchedules(
  pool: Pool,
  tenantId: string,
  options: Readonly<{ now?: Date; maximumCatchupDates?: number }> = {},
): Promise<MetricScheduleCycle> {
  const now = options.now ?? new Date();
  const maximum = options.maximumCatchupDates ?? maximumCatchupDates;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > maximumCatchupDates) {
    throw new Error("metric_schedule_catchup_limit_invalid");
  }
  const schedules = await withTenant(pool, tenantId, async (client) => (await client.query<MetricScheduleRow>(
    `SELECT metric_schedule_id,tenant_id,app_id,lag_days,start_date::text,definition,definition_digest,
            artifact->'replacement' AS replacement
       FROM control.metric_schedules_current
      WHERE tenant_id=$1 AND status='active'
      ORDER BY app_id COLLATE "C",metric_schedule_id COLLATE "C"`,
    [tenantId],
  )).rows);
  let completedDates = 0;
  let replayedDates = 0;
  let failedSchedules = 0;
  for (const schedule of schedules) {
    try {
      const pending = await claimNextScheduledDate(pool, schedule, now);
      if (!pending) continue;
      await runWithTerminalJobOutcome(async () => {
        let current: PendingRun | undefined = pending;
        for (let index = 0; current && index < maximum; index += 1) {
          const outcome = await runPendingDate(pool, schedule, current);
          completedDates += 1;
          if (outcome === "replayed") replayedDates += 1;
          current = await claimNextScheduledDate(pool, schedule, now);
        }
        if (current) throw new Error("metric_schedule_catchup_remaining");
      }, (outcome) => recordJobOutcome({
        pool,
        tenantId: schedule.tenant_id,
        appId: schedule.app_id,
        job: "metric_run",
        outcome,
        now,
      }));
    } catch (error) {
      if (discoversCampaigns(schedule) || schedule.replacement) {
        const name = error instanceof Error ? error.message.replace(/^metric_schedule_/, "") : "";
        const safeReason = ["target_limit", "privacy_unavailable", "privacy_pending", "target_mismatch"].includes(name) ? name : "calculation_unavailable";
        await withTenant(pool, schedule.tenant_id, client => client.query(`UPDATE control.metric_schedule_checkpoints
          SET safe_reason=$4 WHERE tenant_id=$1 AND app_id=$2 AND metric_schedule_id=$3`,
        [schedule.tenant_id, schedule.app_id, schedule.metric_schedule_id, safeReason]));
      }
      failedSchedules += 1;
    }
  }
  if (failedSchedules > 0) throw new Error("metric_schedule_cycle_failed");
  return { schedules: schedules.length, completedDates, replayedDates, failedSchedules };
}
