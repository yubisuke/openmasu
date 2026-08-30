import type { Pool } from "pg";
import { sha256Jcs } from "@openmasu/fraud-rules";
import { recordJobOutcome, runWithTerminalJobOutcome, withTenant } from "@openmasu/runtime";
import { computeSqlMetricRuns, type MetricScope } from "./metrics/cohort.js";
import { buildMetricDefinitionsInput } from "./metrics/run.js";

type Any = Record<string, any>;

type MetricScheduleRow = Readonly<{
  metric_schedule_id: string;
  tenant_id: string;
  app_id: string;
  lag_days: number;
  start_date: string;
  definition: Any;
  definition_digest: string;
}>;

type PendingRun = Readonly<{
  targetDate: string;
  watermark: string;
  definitionDigest: string;
}>;

export type MetricScheduleCycle = Readonly<{
  schedules: number;
  completedDates: number;
  replayedDates: number;
  failedSchedules: number;
}>;

const maximumCatchupDates = 31;

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

export function scheduledMetricBoundary(now: Date, lagDays: number): Readonly<{
  targetDate: string;
  watermark: string;
}> {
  if (!Number.isFinite(now.valueOf())) throw new Error("metric_schedule_time_invalid");
  if (!Number.isSafeInteger(lagDays) || lagDays < 1 || lagDays > 365) {
    throw new Error("metric_schedule_lag_days_invalid");
  }
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    targetDate: new Date(midnight - lagDays * 86_400_000).toISOString().slice(0, 10),
    watermark: new Date(midnight).toISOString(),
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
  const config = {
    tenant_id: schedule.tenant_id,
    app_id: schedule.app_id,
    fx_policy: schedule.definition.fx_policy,
    metric_definitions: schedule.definition.metric_definitions ?? [],
    evaluations: evaluations.map((evaluation: Any) => {
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
  input.metric_evaluations = input.metric_evaluations.map((evaluation: Any, index: number) => ({
    ...evaluation,
    grouping: schedule.definition.evaluations[index].date_dimension === "metric_date"
      ? Object.fromEntries(Object.entries(evaluation.grouping).filter(([key]) => key !== "cohort_date"))
      : evaluation.grouping,
    metric_run_id_prefix: `scheduled:${sha256Jcs({
      metric_schedule_id: schedule.metric_schedule_id,
      target_date: pending.targetDate,
      watermark: pending.watermark,
      definition_digest: pending.definitionDigest,
      evaluation: index,
    }).slice(0, 48)}`,
  }));
  return input;
}

async function claimNextDate(
  pool: Pool,
  schedule: MetricScheduleRow,
  now: Date,
): Promise<PendingRun | undefined> {
  const boundary = scheduledMetricBoundary(now, schedule.lag_days);
  return withTenant(pool, schedule.tenant_id, async (client) => {
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
      return {
        targetDate: checkpoint.pending_target_date,
        watermark: checkpoint.pending_watermark,
        definitionDigest: checkpoint.pending_definition_digest,
      };
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
    return { targetDate, watermark: boundary.watermark, definitionDigest: schedule.definition_digest };
  });
}

async function finalizeDate(pool: Pool, schedule: MetricScheduleRow, pending: PendingRun): Promise<void> {
  await withTenant(pool, schedule.tenant_id, async (client) => {
    const updated = await client.query(
      `UPDATE control.metric_schedule_checkpoints
          SET last_target_date=$4::date,pending_target_date=NULL,pending_watermark=NULL,
              pending_definition_digest=NULL,updated_at=$5::text::control.canonical_timestamp
        WHERE tenant_id=$1 AND app_id=$2 AND metric_schedule_id=$3
          AND pending_target_date=$4::date
          AND pending_watermark=$5::text::control.canonical_timestamp
          AND pending_definition_digest=$6`,
      [schedule.tenant_id, schedule.app_id, schedule.metric_schedule_id,
        pending.targetDate, pending.watermark, pending.definitionDigest],
    );
    if (updated.rowCount !== 1) throw new Error("metric_schedule_checkpoint_conflict");
  });
}

async function runPendingDate(
  pool: Pool,
  schedule: MetricScheduleRow,
  pending: PendingRun,
): Promise<"computed" | "replayed"> {
  const input = buildScheduledMetricInput(schedule, pending);
  const expectedIds = input.metric_evaluations.flatMap((evaluation: Any) =>
    evaluation.metric_names.map((name: string) => `${evaluation.metric_run_id_prefix}:${name}`));
  const scope: MetricScope = { tenant_id: schedule.tenant_id, app_id: schedule.app_id };
  const existing = await withTenant(pool, schedule.tenant_id, async (client) => (await client.query<{
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
  )).rows);
  if (existing.length === 0) {
    await computeSqlMetricRuns(pool, input, true, scope);
    await finalizeDate(pool, schedule, pending);
    return "computed";
  }
  if (existing.length !== expectedIds.length || existing.some((row) => row.manifest_count !== 1)) {
    throw new Error("metric_schedule_partial_run");
  }
  const expected = await computeSqlMetricRuns(pool, input, false, scope);
  const expectedById = new Map(expected.map((artifact: Any) => [artifact.metric_run_id, sha256Jcs(artifact)]));
  if (existing.some((row) => expectedById.get(row.metric_run_id) !== sha256Jcs(row.artifact))) {
    throw new Error("metric_schedule_replay_mismatch");
  }
  await finalizeDate(pool, schedule, pending);
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
    `SELECT metric_schedule_id,tenant_id,app_id,lag_days,start_date::text,definition,definition_digest
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
      const pending = await claimNextDate(pool, schedule, now);
      if (!pending) continue;
      await runWithTerminalJobOutcome(async () => {
        let current: PendingRun | undefined = pending;
        for (let index = 0; current && index < maximum; index += 1) {
          const outcome = await runPendingDate(pool, schedule, current);
          completedDates += 1;
          if (outcome === "replayed") replayedDates += 1;
          current = await claimNextDate(pool, schedule, now);
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
    } catch {
      failedSchedules += 1;
    }
  }
  if (failedSchedules > 0) throw new Error("metric_schedule_cycle_failed");
  return { schedules: schedules.length, completedDates, replayedDates, failedSchedules };
}
