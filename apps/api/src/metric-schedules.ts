import type { Pool, PoolClient } from "pg";
import { sha256Jcs } from "@openmasu/fraud-rules";
import { uuidV7, withTenant, type MetricScheduleReplacement } from "@openmasu/runtime";
import { ENGAGEMENT_METRIC_NAMES, cohortLocalDate, addCalendarDays, type CohortTimeZone } from "@openmasu/contracts/definitions";
import { validateScheduledMetricDefinition as validMetricDefinition, type ScheduledMetricDefinition } from "@openmasu/contracts/validation";
import type { AppAdminIdentity } from "./admin-auth.js";
import { recordDashboardAuditWithClient } from "./session.js";

type JsonObject = Record<string, unknown>;

export type MetricScheduleDefinition = Readonly<{
  cohort_time_zone?: CohortTimeZone;
  fx_policy: JsonObject;
  metric_definitions: readonly ScheduledMetricDefinition[];
  evaluations: readonly Readonly<{
    metric_names: readonly string[];
    date_dimension: "cohort_date" | "metric_date";
    grouping: JsonObject;
    campaign_discovery?: Readonly<{ policy: "selected_acquisition_and_cost_v1"; max_targets: number }>;
  }>[];
}>;

export type MetricScheduleRecord = Readonly<{
  metric_schedule_id: string;
  tenant_id: string;
  app_id: string;
  lag_days: number;
  start_date: string;
  definition: MetricScheduleDefinition;
  definition_digest: string;
  status: "active" | "disabled";
  created_at: string;
  status_changed_at: string;
  last_target_date: string | null;
  pending_target_date?: string | null;
  safe_reason?: string | null;
  latest_discovery?: JsonObject | null;
  replacement?: MetricScheduleReplacement | null;
}>;

const identifier = /^[A-Za-z0-9._:-]{1,128}$/;
const metricName = /^[a-z][a-z0-9_]{2,127}$/;
const datePattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const groupingKeys = new Set([
  "campaign_id", "ad_group_id", "creative_id", "network", "country", "attribution_status", "apple_conversion_bucket",
  "acquisition_campaign_state",
]);

function object(value: unknown, error: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as JsonObject;
}

function exactDate(value: unknown, error: string): string {
  if (typeof value !== "string" || !datePattern.test(value)) throw new Error(error);
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== value) throw new Error(error);
  return value;
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function validFxPolicy(value: JsonObject): boolean {
  if (Object.keys(value).some((key) => !["policy_version", "target_currency", "target_scale", "rounding_mode", "rates"].includes(key))
      || !boundedText(value.policy_version, 64)
      || typeof value.target_currency !== "string" || !/^[A-Z]{3}$/.test(value.target_currency)
      || !Number.isSafeInteger(value.target_scale) || Number(value.target_scale) < 0 || Number(value.target_scale) > 18
      || value.rounding_mode !== "half_even"
      || !Array.isArray(value.rates) || value.rates.length !== 1) return false;
  const rate = value.rates[0];
  if (!rate || typeof rate !== "object" || Array.isArray(rate)) return false;
  const candidate = rate as JsonObject;
  return !Object.keys(candidate).some((key) => !["currency", "rate_unscaled", "rate_scale", "source", "as_of"].includes(key))
    && typeof candidate.currency === "string" && /^[A-Z]{3}$/.test(candidate.currency)
    && typeof candidate.rate_unscaled === "string" && /^[0-9]+$/.test(candidate.rate_unscaled)
    && Number.isSafeInteger(candidate.rate_scale) && Number(candidate.rate_scale) >= 0
    && Number(candidate.rate_scale) <= 18
    && boundedText(candidate.source, 128)
    && typeof candidate.as_of === "string"
    && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(candidate.as_of)
    && Number.isFinite(Date.parse(candidate.as_of))
    && new Date(candidate.as_of).toISOString() === candidate.as_of;
}


function scheduledMetricNames(definition: MetricScheduleDefinition): Set<string> {
  return new Set(definition.evaluations.flatMap((evaluation) => evaluation.metric_names));
}

export function metricScheduleTargetDate(now: Date, lagDays: number, zone: CohortTimeZone = "UTC"): string {
  if (!Number.isFinite(now.valueOf())) throw new Error("metric_schedule_time_invalid");
  if (!Number.isSafeInteger(lagDays) || lagDays < 1 || lagDays > 365) {
    throw new Error("metric_schedule_lag_days_invalid");
  }
  return addCalendarDays(cohortLocalDate(now, zone), -lagDays);
}

function normalizedGrouping(value: unknown): JsonObject {
  const grouping = object(value ?? {}, "metric_schedule_grouping_invalid");
  if (Object.keys(grouping).some((key) => !groupingKeys.has(key))) {
    throw new Error("metric_schedule_grouping_dimension_invalid");
  }
  const normalized: JsonObject = {};
  for (const key of [...groupingKeys]) {
    const candidate = grouping[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 128) {
      throw new Error("metric_schedule_grouping_value_invalid");
    }
    if (["campaign_id", "ad_group_id", "creative_id"].includes(key) && !identifier.test(candidate)) throw new Error("metric_schedule_grouping_value_invalid");
    if (key === "country" && !/^[A-Z]{2}$/.test(candidate)) throw new Error("metric_schedule_grouping_value_invalid");
    if (key === "attribution_status" && !["organic", "non_organic", "unattributed"].includes(candidate)) {
      throw new Error("metric_schedule_grouping_value_invalid");
    }
    if (key === "acquisition_campaign_state" && !["known", "unknown"].includes(candidate)) {
      throw new Error("metric_schedule_grouping_value_invalid");
    }
    if (key === "apple_conversion_bucket" && !/^(fine:([0-9]|[1-5][0-9]|6[0-3])|coarse:(low|medium|high))$/.test(candidate)) {
      throw new Error("metric_schedule_grouping_value_invalid");
    }
    normalized[key] = candidate;
  }
  return normalized;
}

export function normalizeMetricScheduleRequest(
  body: JsonObject,
  now = new Date(),
): Readonly<{ lagDays: number; startDate: string; definition: MetricScheduleDefinition; definitionDigest: string }> {
  const allowed = new Set(["lag_days", "start_date", "fx_policy", "metric_definitions", "evaluations"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new Error("metric_schedule_field_forbidden");
  const lagDaysValue = body.lag_days === undefined ? 1 : body.lag_days;
  if (typeof lagDaysValue !== "number") throw new Error("metric_schedule_lag_days_invalid");
  const lagDays = lagDaysValue;
  let defaultStart = metricScheduleTargetDate(now, lagDays);
  let startDate = body.start_date === undefined
    ? defaultStart
    : exactDate(body.start_date, "metric_schedule_start_date_invalid");

  const fxPolicy = object(body.fx_policy, "metric_schedule_fx_policy_invalid");
  if (!validFxPolicy(fxPolicy)) {
    throw new Error("metric_schedule_fx_policy_invalid");
  }
  const candidates = body.metric_definitions ?? [];
  if (!Array.isArray(candidates)) throw new Error("metric_schedule_definitions_invalid");
  const suppliedDefinitions: ScheduledMetricDefinition[] = [];
  for (const candidate of candidates as unknown[]) {
    if (!validMetricDefinition(candidate)) throw new Error("metric_schedule_definitions_invalid");
    suppliedDefinitions.push(candidate);
  }
  if (new Set(suppliedDefinitions.map(value => value.metric_name)).size !== suppliedDefinitions.length) {
    throw new Error("metric_schedule_definitions_invalid");
  }
  const calendarDefinitions = suppliedDefinitions.filter(value => value.calendar_cohort_policy);
  const calendarZones = new Set(calendarDefinitions.map(value => value.aggregation_time_zone));
  if (calendarDefinitions.length && (calendarDefinitions.length !== suppliedDefinitions.length || calendarZones.size !== 1)) {
    throw new Error("metric_schedule_calendar_profile_required");
  }
  const cohortTimeZone = calendarDefinitions[0]?.aggregation_time_zone;
  defaultStart = metricScheduleTargetDate(now, lagDays, cohortTimeZone ?? "UTC");
  if (body.start_date === undefined) startDate = defaultStart;
  if (startDate > defaultStart) throw new Error("metric_schedule_start_date_in_future");
  if (!Array.isArray(body.evaluations) || body.evaluations.length < 1 || body.evaluations.length > 100) {
    throw new Error("metric_schedule_evaluations_invalid");
  }
  const evaluations = body.evaluations.map((value, index) => {
    const evaluation = object(value, `metric_schedule_evaluation_${index}_invalid`);
    const evaluationAllowed = new Set(["metric_names", "date_dimension", "grouping", "campaign_discovery"]);
    if (Object.keys(evaluation).some((key) => !evaluationAllowed.has(key))) {
      throw new Error("metric_schedule_evaluation_field_forbidden");
    }
    if (!Array.isArray(evaluation.metric_names) || evaluation.metric_names.length < 1
        || evaluation.metric_names.length > 100
        || evaluation.metric_names.some((name) => typeof name !== "string" || !metricName.test(name))
        || new Set(evaluation.metric_names).size !== evaluation.metric_names.length) {
      throw new Error("metric_schedule_metric_names_invalid");
    }
    if (evaluation.date_dimension !== "cohort_date" && evaluation.date_dimension !== "metric_date") {
      throw new Error("metric_schedule_date_dimension_invalid");
    }
    const dateDimension: "cohort_date" | "metric_date" = evaluation.date_dimension;
    if (cohortTimeZone && (dateDimension !== "cohort_date" || evaluation.campaign_discovery !== undefined
        || evaluation.metric_names.some(name => !calendarDefinitions.some(definition => definition.metric_name === name)))) {
      throw new Error("metric_schedule_calendar_profile_required");
    }
    const grouping = normalizedGrouping(evaluation.grouping);
    if ((grouping.campaign_id !== undefined || grouping.ad_group_id !== undefined) && grouping.network === undefined
        && evaluation.metric_names.some(name => suppliedDefinitions.find(definition => definition.metric_name === name)
          ?.acquisition_basis === "selected_verified_platform")) throw new Error("platform_acquisition_source_required");
    const dailyAcquisition = evaluation.metric_names.some(name =>
      suppliedDefinitions.find(definition => definition.metric_name === name)?.rule_bundle_id === "metric-selected-daily-acquisition");
    if ((dailyAcquisition || grouping.acquisition_campaign_state !== undefined)
        && (dateDimension !== "metric_date" || evaluation.metric_names.some(name =>
          suppliedDefinitions.find(definition => definition.metric_name === name)?.rule_bundle_id !== "metric-selected-daily-acquisition"))) {
      throw new Error("metric_schedule_daily_acquisition_profile_required");
    }
    const engagement = evaluation.metric_names.some(name =>
      suppliedDefinitions.find(definition => definition.metric_name === name)?.engagement_credit_policy
      || ENGAGEMENT_METRIC_NAMES.has(name));
    if (engagement && (dateDimension !== "metric_date" || lagDays < 2
        || Object.keys(grouping).some(key => key !== "campaign_id")
        || evaluation.campaign_discovery !== undefined
        || evaluation.metric_names.some(name => !suppliedDefinitions.find(definition => definition.metric_name === name)?.engagement_credit_policy)
        || fxPolicy.target_currency !== "USD" || fxPolicy.target_scale !== 6)) {
      throw new Error("metric_schedule_engagement_profile_required");
    }
    if ((grouping.ad_group_id !== undefined || grouping.creative_id !== undefined)
        && (dateDimension !== "cohort_date" || evaluation.metric_names.some(name => {
          const metric = suppliedDefinitions.find(value => value.metric_name === name);
          return metric?.acquisition_dimension_policy !== "selected_link_ad_group_creative"
            && !(["selected_verified_platform", "selected_imported_provider"].includes(String(metric?.acquisition_basis)) && grouping.creative_id === undefined);
        }))) throw new Error("metric_schedule_detail_profile_required");
    let discovery: { policy: "selected_acquisition_and_cost_v1"; max_targets: number } | undefined;
    if (evaluation.campaign_discovery !== undefined) {
      const candidate = object(evaluation.campaign_discovery, "metric_schedule_discovery_invalid");
      if (Object.keys(candidate).some(key => !["policy", "max_targets"].includes(key))
          || candidate.policy !== "selected_acquisition_and_cost_v1"
          || !Number.isSafeInteger(candidate.max_targets) || Number(candidate.max_targets) < 1 || Number(candidate.max_targets) > 100
          || dateDimension !== "cohort_date" || grouping.campaign_id !== undefined || grouping.apple_conversion_bucket !== undefined
          || evaluation.metric_names.some(name => {
            const metric = suppliedDefinitions.find(value => value.metric_name === name);
            return !metric || metric.anchor_event !== "install" || metric.aggregation_time_zone !== "UTC"
              || metric.acquisition_dimension_policy !== undefined
              || !["selected_first_party_click", "selected_verified_platform"].includes(String(metric.acquisition_basis))
              || ((metric.definition as JsonObject).calculation === "revenue_over_cost"
                && metric.cost_selection_policy !== "reject_overlapping_grains");
          })) throw new Error("metric_schedule_discovery_invalid");
      const bases = new Set(evaluation.metric_names.map(name => suppliedDefinitions.find(value => value.metric_name === name)?.acquisition_basis));
      if (bases.size !== 1) throw new Error("metric_schedule_discovery_mixed_basis");
      discovery = { policy: "selected_acquisition_and_cost_v1", max_targets: Number(candidate.max_targets) };
    }
    return {
      metric_names: [...evaluation.metric_names].sort() as string[],
      date_dimension: dateDimension,
      grouping,
      ...(discovery ? { campaign_discovery: discovery } : {}),
    };
  });
  if (evaluations.some(evaluation => evaluation.campaign_discovery)) {
    const names = evaluations.flatMap(evaluation => evaluation.metric_names);
    // A discovered series must not also appear in a manual/all-campaign evaluation.
    if (new Set(names).size !== names.length) throw new Error("metric_schedule_discovery_overlap");
    const maximum = evaluations.reduce((sum, evaluation) => sum
      + (evaluation.campaign_discovery?.max_targets ?? 1) * evaluation.metric_names.length, 0);
    if (maximum > 1000) throw new Error("metric_schedule_discovery_limit");
  }
  const definition: MetricScheduleDefinition = {
    ...(cohortTimeZone ? { cohort_time_zone: cohortTimeZone } : {}),
    fx_policy: fxPolicy,
    metric_definitions: suppliedDefinitions,
    evaluations,
  };
  const definitionDigest = sha256Jcs(definition);
  return { lagDays, startDate, definition, definitionDigest };
}

export async function registerMetricSchedule(input: Readonly<{
  pool: Pool;
  identity: AppAdminIdentity;
  body: JsonObject;
  now?: Date;
}>): Promise<MetricScheduleRecord> {
  const now = input.now ?? new Date();
  const normalized = normalizeMetricScheduleRequest(input.body, now);
  return withTenant(input.pool, input.identity.tenantId, client =>
    saveMetricScheduleWithClient(client, input.identity, normalized, now));
}

/** Caller owns the transaction; also used for atomic disable-and-replace. */
export async function saveMetricScheduleWithClient(
  client: PoolClient,
  identity: AppAdminIdentity,
  normalized: ReturnType<typeof normalizeMetricScheduleRequest>,
  now: Date,
  replacement?: MetricScheduleReplacement,
): Promise<MetricScheduleRecord> {
  const createdAt = now.toISOString();
  const scheduleId = `metric-schedule:${uuidV7(now.valueOf())}`;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [JSON.stringify([identity.tenantId, identity.appId, "metric-schedules"])],
    );
    const active = await client.query<{ definition: MetricScheduleDefinition }>(
      `SELECT definition FROM control.metric_schedules_current
        WHERE tenant_id=$1 AND app_id=$2 AND status='active'`,
      [identity.tenantId, identity.appId],
    );
    const requestedNames = scheduledMetricNames(normalized.definition);
    if (active.rows.some((row) => [...scheduledMetricNames(row.definition)].some((name) => requestedNames.has(name)))) {
      throw new Error("metric_schedule_metric_overlap");
    }
    const artifact = {
      metric_schedule_id: scheduleId,
      tenant_id: identity.tenantId,
      app_id: identity.appId,
      lag_days: normalized.lagDays,
      start_date: normalized.startDate,
      definition: normalized.definition,
      definition_digest: normalized.definitionDigest,
      created_at: createdAt,
      ...(replacement ? { replacement } : {}),
    };
    await client.query(
      `INSERT INTO control.metric_schedules (
         metric_schedule_id,tenant_id,app_id,lag_days,start_date,definition,
         definition_digest,created_at,artifact
       ) VALUES ($1,$2,$3,$4,$5::date,$6::jsonb,$7,$8,$9::jsonb)`,
      [scheduleId, identity.tenantId, identity.appId, normalized.lagDays,
        normalized.startDate, JSON.stringify(normalized.definition), normalized.definitionDigest,
        createdAt, JSON.stringify(artifact)],
    );
    await client.query(
      `INSERT INTO control.metric_schedule_states (
         metric_schedule_id,tenant_id,app_id,status,changed_at,artifact
       ) VALUES ($1,$2,$3,'active',$4,$5::jsonb)`,
      [scheduleId, identity.tenantId, identity.appId, createdAt,
        JSON.stringify({ metric_schedule_id: scheduleId, status: "active", changed_at: createdAt })],
    );
    await client.query(
      `INSERT INTO control.metric_schedule_checkpoints (
         metric_schedule_id,tenant_id,app_id,last_target_date,pending_target_date,
         pending_watermark,pending_definition_digest,updated_at
       ) VALUES ($1,$2,$3,NULL,NULL,NULL,NULL,$4)`,
      [scheduleId, identity.tenantId, identity.appId, createdAt],
    );
    await recordDashboardAuditWithClient(client, {
      tenantId: identity.tenantId,
      appId: identity.appId,
      actorRef: `admin_key:${identity.keyId}`,
      action: "metric_schedule_registered",
      targetScope: "metric_schedule",
      targetRef: scheduleId,
      outcome: "succeeded",
      now,
    });
    return {
      ...artifact,
      status: "active",
      status_changed_at: createdAt,
      last_target_date: null,
    };
}

export async function listMetricSchedules(
  pool: Pool,
  identity: AppAdminIdentity,
): Promise<readonly MetricScheduleRecord[]> {
  return withTenant(pool, identity.tenantId, async (client) => (await client.query<MetricScheduleRecord>(
    `SELECT schedule.metric_schedule_id,schedule.tenant_id,schedule.app_id,schedule.lag_days,
            schedule.start_date::text,schedule.definition,schedule.definition_digest,
            schedule.status,schedule.created_at,
            schedule.status_changed_at,checkpoint.last_target_date::text,checkpoint.pending_target_date::text,
            checkpoint.safe_reason,discovery.summary AS latest_discovery,
            schedule.artifact->'replacement' AS replacement
       FROM control.metric_schedules_current AS schedule
       JOIN control.metric_schedule_checkpoints AS checkpoint
         USING (metric_schedule_id,tenant_id,app_id)
       LEFT JOIN LATERAL (
         SELECT jsonb_build_object('target_date',target.target_date::text,'watermark',target.watermark,
           'definition_digest',target.definition_digest,'target_digest',target.target_digest,
           'selection_state',target.selection_state,'counts',target.artifact->'counts',
           'target_count',jsonb_array_length(target.artifact->'targets')) AS summary
         FROM control.metric_schedule_targets AS target WHERE target.tenant_id=schedule.tenant_id
           AND target.app_id=schedule.app_id AND target.metric_schedule_id=schedule.metric_schedule_id
         ORDER BY target.target_date DESC LIMIT 1
       ) AS discovery ON true
      WHERE schedule.tenant_id=$1 AND schedule.app_id=$2
      ORDER BY schedule.created_at DESC,schedule.metric_schedule_id COLLATE "C"`,
    [identity.tenantId, identity.appId],
  )).rows);
}

export async function disableMetricSchedule(input: Readonly<{
  pool: Pool;
  identity: AppAdminIdentity;
  metricScheduleId: string;
  now?: Date;
}>): Promise<Readonly<{ metric_schedule_id: string; status: "disabled"; changed_at: string }>> {
  if (!identifier.test(input.metricScheduleId)) throw new Error("metric_schedule_not_found");
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) throw new Error("metric_schedule_time_invalid");
  const changedAt = now.toISOString();
  return withTenant(input.pool, input.identity.tenantId, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [JSON.stringify([input.identity.tenantId, input.identity.appId, "metric-schedules"])],
    );
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [JSON.stringify([input.identity.tenantId, input.identity.appId, input.metricScheduleId])],
    );
    const current = await client.query<{ status: string }>(
      `SELECT status FROM control.metric_schedules_current
        WHERE tenant_id=$1 AND app_id=$2 AND metric_schedule_id=$3`,
      [input.identity.tenantId, input.identity.appId, input.metricScheduleId],
    );
    if (!current.rows[0]) throw new Error("metric_schedule_not_found");
    if (current.rows[0].status !== "active") throw new Error("metric_schedule_not_active");
    await client.query(
      `INSERT INTO control.metric_schedule_states (
         metric_schedule_id,tenant_id,app_id,status,changed_at,artifact
       ) VALUES ($1,$2,$3,'disabled',$4,$5::jsonb)`,
      [input.metricScheduleId, input.identity.tenantId, input.identity.appId, changedAt,
        JSON.stringify({ metric_schedule_id: input.metricScheduleId, status: "disabled", changed_at: changedAt })],
    );
    await recordDashboardAuditWithClient(client, {
      tenantId: input.identity.tenantId,
      appId: input.identity.appId,
      actorRef: `admin_key:${input.identity.keyId}`,
      action: "metric_schedule_disabled",
      targetScope: "metric_schedule",
      targetRef: input.metricScheduleId,
      outcome: "succeeded",
      now,
    });
    return { metric_schedule_id: input.metricScheduleId, status: "disabled", changed_at: changedAt };
  });
}
