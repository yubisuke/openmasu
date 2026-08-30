import type { Pool } from "pg";
import { sha256Jcs } from "@openmasu/fraud-rules";
import { uuidV7, withTenant } from "@openmasu/runtime";
import type { AppAdminIdentity } from "./admin-auth.js";
import { recordDashboardAuditWithClient } from "./session.js";

type JsonObject = Record<string, unknown>;

export type MetricScheduleDefinition = Readonly<{
  fx_policy: JsonObject;
  metric_definitions: readonly JsonObject[];
  evaluations: readonly Readonly<{
    metric_names: readonly string[];
    date_dimension: "cohort_date" | "metric_date";
    grouping: JsonObject;
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
}>;

const identifier = /^[A-Za-z0-9._:-]{1,128}$/;
const metricName = /^[a-z][a-z0-9_]{2,127}$/;
const datePattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const groupingKeys = new Set([
  "campaign_id", "network", "country", "attribution_status", "apple_conversion_bucket",
]);
const metricGroupingKeys = new Set([...groupingKeys, "cohort_date", "metric_date"]);
const metricDefinitionFields = new Set([
  "metric_name", "metric_definition_version", "anchor_event", "aggregation_time_zone", "value_type",
  "currency", "amount_scale", "ratio_scale", "definition", "activity_events", "event_names",
  "grouping_dimensions", "fraud_policy", "rule_bundle_id", "rule_bundle_version", "rule_bundle_hash",
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

function validStringArray(value: unknown, allowed?: ReadonlySet<string>): boolean {
  return Array.isArray(value) && value.length > 0
    && value.every((entry) => typeof entry === "string" && entry.length > 0 && (!allowed || allowed.has(entry)))
    && new Set(value).size === value.length;
}

function validMetricDefinition(value: JsonObject): boolean {
  if (Object.keys(value).some((key) => !metricDefinitionFields.has(key))
      || typeof value.metric_name !== "string" || !metricName.test(value.metric_name)
      || !boundedText(value.metric_definition_version, 64)
      || !["install", "calendar_day"].includes(String(value.anchor_event))
      || !["UTC", "Asia/Tokyo"].includes(String(value.aggregation_time_zone))
      || !["money", "ratio", "count"].includes(String(value.value_type))
      || typeof value.rule_bundle_id !== "string" || !identifier.test(value.rule_bundle_id)
      || !boundedText(value.rule_bundle_version, 64)
      || typeof value.rule_bundle_hash !== "string" || !/^[a-f0-9]{64}$/.test(value.rule_bundle_hash)) return false;
  const definition = value.definition;
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return false;
  const operation = definition as JsonObject;
  if (Object.keys(operation).some((key) => !["calculation", "window", "numerator", "denominator", "cost_basis"].includes(key))
      || !["revenue_sum", "revenue_over_cost", "active_installations_over_cohort", "revenue_over_cohort", "cohort_size", "event_count"].includes(String(operation.calculation))
      || !["revenue", "purchase_net_revenue", "total_net_revenue", "active_installations", "cohort_size", "events"].includes(String(operation.numerator))) return false;
  const window = operation.window;
  if (!window || typeof window !== "object" || Array.isArray(window)) return false;
  const boundedWindow = window as JsonObject;
  if (Object.keys(boundedWindow).some((key) => !["type", "day"].includes(key))
      || !["elapsed", "calendar_day", "activity_day"].includes(String(boundedWindow.type))
      || !Number.isSafeInteger(boundedWindow.day) || Number(boundedWindow.day) < 0
      || Number(boundedWindow.day) > 3650) return false;
  if (value.value_type === "money"
      && (typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)
        || !Number.isSafeInteger(value.amount_scale) || Number(value.amount_scale) < 0
        || Number(value.amount_scale) > 18)) return false;
  if (value.value_type === "ratio"
      && (!Number.isSafeInteger(value.ratio_scale) || Number(value.ratio_scale) < 0
        || Number(value.ratio_scale) > 18)) return false;
  if (value.activity_events !== undefined && !validStringArray(value.activity_events)) return false;
  if (value.event_names !== undefined && !validStringArray(value.event_names,
    new Set(["click", "install", "skan_postback", "adattributionkit_postback", "deep_link_open"]))) return false;
  if (value.grouping_dimensions !== undefined
      && !validStringArray(value.grouping_dimensions, metricGroupingKeys)) return false;
  return value.fraud_policy === undefined || value.fraud_policy === "gross" || value.fraud_policy === "net";
}

function scheduledMetricNames(definition: MetricScheduleDefinition): Set<string> {
  return new Set(definition.evaluations.flatMap((evaluation) => evaluation.metric_names));
}

export function metricScheduleTargetDate(now: Date, lagDays: number): string {
  if (!Number.isFinite(now.valueOf())) throw new Error("metric_schedule_time_invalid");
  if (!Number.isSafeInteger(lagDays) || lagDays < 1 || lagDays > 365) {
    throw new Error("metric_schedule_lag_days_invalid");
  }
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(midnight - lagDays * 86_400_000).toISOString().slice(0, 10);
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
    if (key === "campaign_id" && !identifier.test(candidate)) throw new Error("metric_schedule_grouping_value_invalid");
    if (key === "country" && !/^[A-Z]{2}$/.test(candidate)) throw new Error("metric_schedule_grouping_value_invalid");
    if (key === "attribution_status" && !["organic", "non_organic", "unattributed"].includes(candidate)) {
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
  const defaultStart = metricScheduleTargetDate(now, lagDays);
  const startDate = body.start_date === undefined
    ? defaultStart
    : exactDate(body.start_date, "metric_schedule_start_date_invalid");
  if (startDate > defaultStart) throw new Error("metric_schedule_start_date_in_future");

  const fxPolicy = object(body.fx_policy, "metric_schedule_fx_policy_invalid");
  if (!validFxPolicy(fxPolicy)) {
    throw new Error("metric_schedule_fx_policy_invalid");
  }
  const suppliedDefinitions = body.metric_definitions ?? [];
  if (!Array.isArray(suppliedDefinitions)
      || suppliedDefinitions.some((value) => !value || typeof value !== "object" || Array.isArray(value))
      || suppliedDefinitions.some((value) => !validMetricDefinition(value as JsonObject))
      || new Set(suppliedDefinitions.map((value) => (value as JsonObject).metric_name)).size
        !== suppliedDefinitions.length) {
    throw new Error("metric_schedule_definitions_invalid");
  }
  if (!Array.isArray(body.evaluations) || body.evaluations.length < 1 || body.evaluations.length > 100) {
    throw new Error("metric_schedule_evaluations_invalid");
  }
  const evaluations = body.evaluations.map((value, index) => {
    const evaluation = object(value, `metric_schedule_evaluation_${index}_invalid`);
    const evaluationAllowed = new Set(["metric_names", "date_dimension", "grouping"]);
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
    return {
      metric_names: [...evaluation.metric_names].sort() as string[],
      date_dimension: dateDimension,
      grouping: normalizedGrouping(evaluation.grouping),
    };
  });
  const definition: MetricScheduleDefinition = {
    fx_policy: fxPolicy,
    metric_definitions: suppliedDefinitions as JsonObject[],
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
  const createdAt = now.toISOString();
  const scheduleId = `metric-schedule:${uuidV7(now.valueOf())}`;
  return withTenant(input.pool, input.identity.tenantId, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [JSON.stringify([input.identity.tenantId, input.identity.appId, "metric-schedules"])],
    );
    const active = await client.query<{ definition: MetricScheduleDefinition }>(
      `SELECT definition FROM control.metric_schedules_current
        WHERE tenant_id=$1 AND app_id=$2 AND status='active'`,
      [input.identity.tenantId, input.identity.appId],
    );
    const requestedNames = scheduledMetricNames(normalized.definition);
    if (active.rows.some((row) => [...scheduledMetricNames(row.definition)].some((name) => requestedNames.has(name)))) {
      throw new Error("metric_schedule_metric_overlap");
    }
    const artifact = {
      metric_schedule_id: scheduleId,
      tenant_id: input.identity.tenantId,
      app_id: input.identity.appId,
      lag_days: normalized.lagDays,
      start_date: normalized.startDate,
      definition: normalized.definition,
      definition_digest: normalized.definitionDigest,
      created_at: createdAt,
    };
    await client.query(
      `INSERT INTO control.metric_schedules (
         metric_schedule_id,tenant_id,app_id,lag_days,start_date,definition,
         definition_digest,created_at,artifact
       ) VALUES ($1,$2,$3,$4,$5::date,$6::jsonb,$7,$8,$9::jsonb)`,
      [scheduleId, input.identity.tenantId, input.identity.appId, normalized.lagDays,
        normalized.startDate, JSON.stringify(normalized.definition), normalized.definitionDigest,
        createdAt, JSON.stringify(artifact)],
    );
    await client.query(
      `INSERT INTO control.metric_schedule_states (
         metric_schedule_id,tenant_id,app_id,status,changed_at,artifact
       ) VALUES ($1,$2,$3,'active',$4,$5::jsonb)`,
      [scheduleId, input.identity.tenantId, input.identity.appId, createdAt,
        JSON.stringify({ metric_schedule_id: scheduleId, status: "active", changed_at: createdAt })],
    );
    await client.query(
      `INSERT INTO control.metric_schedule_checkpoints (
         metric_schedule_id,tenant_id,app_id,last_target_date,pending_target_date,
         pending_watermark,pending_definition_digest,updated_at
       ) VALUES ($1,$2,$3,NULL,NULL,NULL,NULL,$4)`,
      [scheduleId, input.identity.tenantId, input.identity.appId, createdAt],
    );
    await recordDashboardAuditWithClient(client, {
      tenantId: input.identity.tenantId,
      appId: input.identity.appId,
      actorRef: `admin_key:${input.identity.keyId}`,
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
  });
}

export async function listMetricSchedules(
  pool: Pool,
  identity: AppAdminIdentity,
): Promise<readonly MetricScheduleRecord[]> {
  return withTenant(pool, identity.tenantId, async (client) => (await client.query<MetricScheduleRecord>(
    `SELECT schedule.metric_schedule_id,schedule.tenant_id,schedule.app_id,schedule.lag_days,
            schedule.start_date::text,schedule.definition,schedule.definition_digest,
            schedule.status,schedule.created_at,
            schedule.status_changed_at,checkpoint.last_target_date::text
       FROM control.metric_schedules_current AS schedule
       JOIN control.metric_schedule_checkpoints AS checkpoint
         USING (metric_schedule_id,tenant_id,app_id)
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
