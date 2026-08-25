import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import { M1B_METRIC_DEFINITIONS } from "@open-mmp/contracts";
import { jcs, sha256 } from "@open-mmp/attribution-core";

type Any = Record<string, any>;
type Queryable = Pick<PoolClient, "query">;

type Scope = { tenant_id: string; app_id: string };
type SnapshotRecord = {
  tenant_id: string;
  app_id: string;
  record_id: string;
  received_at: string;
  lifecycle_status: "available" | "redacted" | "purged";
  privacy_request_id: string | null;
};
type CurrentCost = {
  tenant_id: string;
  app_id: string;
  cost_record_id: string;
  as_of: string;
  report_snapshot_digest: string;
  dimension_digest: string;
};

function inputAttempts(input: Any): Array<{ server: Any; record: Any }> {
  if (Array.isArray(input.batches)) {
    return input.batches.flatMap((batch: Any) =>
      batch.records.map((record: Any) => ({ server: batch.server_context, record })),
    );
  }
  return (input.records ?? []).map((record: Any) => ({ server: input.server_context, record }));
}

function scopeForInput(input: Any): Scope {
  const scopes = new Map<string, Scope>();
  for (const { server } of inputAttempts(input)) {
    scopes.set(`${server.tenant_id}\u0000${server.app_id}`, {
      tenant_id: server.tenant_id,
      app_id: server.app_id,
    });
  }
  if (scopes.size !== 1) throw new Error("one SQL cohort evaluation must have exactly one tenant/app scope");
  return [...scopes.values()][0];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type SnapshotScan = {
  records: SnapshotRecord[];
  append: (row: unknown) => void;
  finish: () => string;
};

async function scanSnapshotRecords(
  client: Queryable,
  scope: Scope,
  watermark: string,
  privacyState: "before" | "after",
): Promise<SnapshotScan> {
  const cursorName = "m1b_snapshot_records";
  await client.query(
    `DECLARE ${cursorName} NO SCROLL CURSOR FOR
     SELECT raw.tenant_id, raw.app_id, raw.record_id, raw.received_at, raw.policy_digest,
            CASE WHEN $4='before' THEN 'available'
                 ELSE state.lifecycle_status END AS lifecycle_status,
            CASE WHEN $4='before' THEN NULL
                 ELSE state.privacy_request_id END AS privacy_request_id
     FROM ledger.raw_records AS raw
     JOIN ledger.logical_events AS logical
       ON logical.record_id=raw.record_id
      AND logical.tenant_id=raw.tenant_id
      AND logical.app_id=raw.app_id
     JOIN LATERAL (
       SELECT payload.lifecycle_status, payload.privacy_request_id
       FROM ledger.raw_payload_states AS payload
       WHERE payload.record_id=raw.record_id
         AND payload.tenant_id=raw.tenant_id
         AND payload.app_id=raw.app_id
       ORDER BY payload.state_seq DESC
       LIMIT 1
     ) AS state ON true
     WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.received_at <= $3
     ORDER BY raw.received_at, raw.record_id`,
    [scope.tenant_id, scope.app_id, watermark, privacyState],
  );
  const records: SnapshotRecord[] = [];
  const hasher = createHash("sha256");
  let first = true;
  hasher.update("[");
  const append = (row: unknown): void => {
    if (!first) hasher.update(",");
    hasher.update(jcs(row));
    first = false;
  };
  try {
    while (true) {
      const page = await client.query<SnapshotRecord>(`FETCH FORWARD 1000 FROM ${cursorName}`);
      if (page.rows.length === 0) break;
      for (const record of page.rows) {
        const policyDigest = (record as SnapshotRecord & { policy_digest?: string }).policy_digest;
        if (!policyDigest) throw new Error(`missing policy digest for ${record.record_id}`);
        append([record.received_at, record.record_id, record.lifecycle_status, policyDigest]);
        records.push(record);
      }
    }
  } finally {
    await client.query(`CLOSE ${cursorName}`).catch(() => undefined);
  }
  return {
    records,
    append,
    finish: () => {
      hasher.update("]");
      return hasher.digest("hex");
    },
  };
}

async function currentCosts(
  client: Queryable,
  scope: Scope,
  watermark: string,
  grouping: Any,
): Promise<CurrentCost[]> {
  const result = await client.query<CurrentCost>(
    `SELECT tenant_id, app_id, cost_record_id, as_of,
            report_snapshot_digest, cost_key_digest AS dimension_digest
     FROM (
       SELECT DISTINCT ON (cost_key_digest)
         tenant_id, app_id, cost_record_id, as_of,
         report_snapshot_digest, cost_key_digest
       FROM ledger.cost_records
       WHERE tenant_id=$1 AND app_id=$2 AND as_of <= $3
         AND ($4::text IS NULL OR campaign_id=$4)
         AND ($5::text IS NULL OR network=$5)
         AND ($6::text IS NULL OR country=$6)
         AND ($7::date IS NULL OR cost_date=$7::date)
       ORDER BY cost_key_digest, as_of DESC, cost_record_id DESC
     ) AS current
     ORDER BY as_of, cost_record_id`,
    [
      scope.tenant_id,
      scope.app_id,
      watermark,
      grouping?.campaign_id ?? null,
      grouping?.network ?? null,
      grouping?.country ?? null,
      grouping?.cohort_date ?? null,
    ],
  );
  return result.rows;
}

async function metricValue(
  client: Queryable,
  scope: Scope,
  watermark: string,
  grouping: Any,
  definition: Any,
  fxPolicy: Any,
  privacyState: "before" | "after",
): Promise<{ value_state: "present"; value_unscaled: string } | {
  value_state: "undefined";
  undefined_reason: "no_attributed_cost" | "empty_cohort";
}> {
  const calculation = definition.definition.calculation;
  const activityEvents = definition.activity_events ?? ["session_start"];
  if (calculation === "active_installations_over_cohort" &&
      activityEvents.some((eventName: string) => eventName !== "session_start")) {
    throw new Error(`SQL activity projection does not support ${activityEvents.join(",")}`);
  }
  const result = await client.query<{
    value_unscaled: string | null;
    missing_fx_count: string;
    mismatched_cost_currency_count: string;
  }>(
    `WITH
       rates AS (
         SELECT currency, rate_unscaled::numeric AS rate_unscaled, rate_scale
         FROM jsonb_to_recordset($12::jsonb)
           AS rate(currency text, rate_unscaled text, rate_scale integer)
       ),
       cohort AS (
         SELECT install.installation_id, install.occurred_at_ts AS installed_at
         FROM ledger.install_facts AS install
         JOIN ledger.logical_events AS logical
           ON logical.logical_event_id=install.logical_event_id
         JOIN ledger.raw_records_current AS raw
           ON raw.record_id=logical.record_id
          AND raw.tenant_id=logical.tenant_id
          AND raw.app_id=logical.app_id
         WHERE install.tenant_id=$1 AND install.app_id=$2 AND install.occurred_at IS NOT NULL
           AND raw.received_at <= $3
           AND ($15='before' OR raw.payload_lifecycle_status='available')
           AND ($4::text IS NULL OR install.campaign_id=$4)
           AND ($5::text IS NULL OR install.network=$5)
           AND ($6::text IS NULL OR install.country=$6)
           AND ($7::text IS NULL OR timezone($8, install.occurred_at_ts)::date::text=$7)
       ),
       revenue_candidates AS (
         SELECT revenue.*, cohort.installed_at, rate.rate_unscaled, rate.rate_scale
         FROM ledger.ad_revenue_facts AS revenue
         JOIN cohort USING (installation_id)
         JOIN ledger.logical_events AS logical
           ON logical.logical_event_id=revenue.logical_event_id
         JOIN ledger.raw_records_current AS raw
           ON raw.record_id=logical.record_id
          AND raw.tenant_id=logical.tenant_id
          AND raw.app_id=logical.app_id
         LEFT JOIN rates AS rate ON rate.currency=revenue.currency
         WHERE revenue.tenant_id=$1 AND revenue.app_id=$2
           AND raw.received_at <= $3
           AND ($15='before' OR raw.payload_lifecycle_status='available')
           AND revenue.occurred_at_ts >= cohort.installed_at
           AND revenue.occurred_at_ts < cohort.installed_at + (($9 + 1) * interval '1 day')
       ),
       revenue AS (
         SELECT coalesce(sum(ledger.half_even_div(
           amount_unscaled::numeric * rate_unscaled * power(10::numeric, $13),
           power(10::numeric, amount_scale + rate_scale)
         )), 0::numeric) AS value,
         count(*) FILTER (WHERE rate_unscaled IS NULL)::bigint AS missing_fx_count
         FROM revenue_candidates
       ),
       activities AS (
         SELECT count(DISTINCT session.installation_id)::numeric AS value
         FROM ledger.session_facts AS session
         JOIN cohort USING (installation_id)
         JOIN ledger.logical_events AS logical
           ON logical.logical_event_id=session.logical_event_id
         JOIN ledger.raw_records_current AS raw
           ON raw.record_id=logical.record_id
          AND raw.tenant_id=logical.tenant_id
          AND raw.app_id=logical.app_id
         WHERE session.tenant_id=$1 AND session.app_id=$2
           AND raw.received_at <= $3
           AND ($15='before' OR raw.payload_lifecycle_status='available')
           AND session.occurred_at_ts >= cohort.installed_at + ($9 * interval '1 day')
           AND session.occurred_at_ts < cohort.installed_at + (($9 + 1) * interval '1 day')
       ),
       current_cost AS (
         SELECT * FROM (
           SELECT DISTINCT ON (cost_key_digest) *
           FROM ledger.cost_records
           WHERE tenant_id=$1 AND app_id=$2 AND as_of <= $3
             AND ($4::text IS NULL OR campaign_id=$4)
             AND ($5::text IS NULL OR network=$5)
             AND ($6::text IS NULL OR country=$6)
             AND ($7::date IS NULL OR cost_date=$7::date)
           ORDER BY cost_key_digest, as_of DESC, cost_record_id DESC
         ) AS selected
       ),
       cost AS (
         SELECT coalesce(sum(
           CASE
             WHEN spend_scale <= $13
               THEN spend_unscaled::numeric * power(10::numeric, $13 - spend_scale)
             ELSE ledger.half_even_div(spend_unscaled::numeric, power(10::numeric, spend_scale - $13))
           END
         ), 0::numeric) AS value,
         count(*) FILTER (WHERE currency <> $11)::bigint AS mismatched_currency_count
         FROM current_cost
       ),
       values AS (
         SELECT revenue.value AS revenue_value,
                (SELECT count(DISTINCT installation_id)::numeric FROM cohort) AS cohort_size,
                activities.value AS active_count,
                cost.value AS cost_value,
                revenue.missing_fx_count,
                cost.mismatched_currency_count
         FROM revenue, activities, cost
       )
     SELECT CASE $10
              WHEN 'revenue_sum' THEN revenue_value
              WHEN 'revenue_over_cost' THEN
                CASE WHEN cost_value=0 THEN NULL
                     ELSE ledger.half_even_div(revenue_value * power(10::numeric, $14), cost_value) END
              WHEN 'active_installations_over_cohort' THEN
                CASE WHEN cohort_size=0 THEN NULL
                     ELSE ledger.half_even_div(active_count * power(10::numeric, $14), cohort_size) END
              WHEN 'revenue_over_cohort' THEN
                CASE WHEN cohort_size=0 THEN NULL
                     ELSE ledger.half_even_div(revenue_value, cohort_size) END
              WHEN 'cohort_size' THEN cohort_size
            END::text AS value_unscaled,
            missing_fx_count::text,
            mismatched_currency_count::text AS mismatched_cost_currency_count
     FROM values`,
    [
      scope.tenant_id,
      scope.app_id,
      watermark,
      grouping?.campaign_id ?? null,
      grouping?.network ?? null,
      grouping?.country ?? null,
      grouping?.cohort_date ?? null,
      definition.aggregation_time_zone,
      definition.definition.window.day,
      calculation,
      fxPolicy.target_currency,
      JSON.stringify(fxPolicy.rates),
      fxPolicy.target_scale,
      definition.ratio_scale ?? 0,
      privacyState,
    ],
  );
  const row = result.rows[0];
  if (row.missing_fx_count !== "0") throw new Error(`missing FX rate for ${definition.metric_name}`);
  if (row.mismatched_cost_currency_count !== "0") {
    throw new Error(`cost currency mismatch for ${definition.metric_name}`);
  }
  if (row.value_unscaled !== null) return { value_state: "present", value_unscaled: row.value_unscaled };
  return {
    value_state: "undefined",
    undefined_reason: calculation === "revenue_over_cost" ? "no_attributed_cost" : "empty_cohort",
  };
}

async function persistMetricRun(client: Queryable, scope: Scope, artifact: Any): Promise<void> {
  const grouping = artifact.grouping?.dimensions ?? {};
  const result = await client.query(
    `INSERT INTO ledger.metric_runs (
      metric_run_id, tenant_id, app_id, metric_name, metric_definition_version,
      grouping, grouping_digest, input_snapshot_id, input_received_at_watermark,
      input_ledger_position, computed_at, data_freshness, aggregation_time_zone,
      rule_bundle_id, rule_bundle_version, rule_bundle_hash, fx_rate_unscaled,
      fx_rate_scale, fx_rate_source, fx_rate_as_of, fx_rate_snapshot_id,
      fx_policy_version, rounding_mode, reproducibility_status, value_type,
      value_state, undefined_reason, value_unscaled, amount_scale, currency,
      supersedes_metric_run_id, artifact
    ) VALUES (
      $1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
      $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32::jsonb
    ) ON CONFLICT (metric_run_id) DO NOTHING
    RETURNING metric_run_id`,
    [
      artifact.metric_run_id, scope.tenant_id, scope.app_id, artifact.metric_name,
      artifact.metric_definition_version, JSON.stringify(grouping),
      artifact.grouping?.dimension_digest ?? sha256(grouping), artifact.input_snapshot_id,
      artifact.input_received_at_watermark, artifact.input_ledger_position,
      artifact.computed_at, artifact.data_freshness, artifact.aggregation_time_zone,
      artifact.rule_bundle_id, artifact.rule_bundle_version, artifact.rule_bundle_hash,
      artifact.fx_rate_unscaled ?? null, artifact.fx_rate_scale ?? null,
      artifact.fx_rate_source ?? null, artifact.fx_rate_as_of ?? null,
      artifact.fx_rate_snapshot_id ?? null, artifact.fx_policy_version ?? null,
      artifact.rounding_mode, artifact.reproducibility_status, artifact.value_type,
      artifact.value_state ?? "present", artifact.undefined_reason ?? null,
      artifact.value_unscaled ?? null, artifact.amount_scale ?? null, artifact.currency ?? null,
      artifact.supersedes_metric_run_id ?? null, JSON.stringify(artifact),
    ],
  );
  if (result.rowCount !== 1) {
    throw new Error(`metric run already exists: ${artifact.metric_run_id}`);
  }
}

export async function computeSqlMetricRunsWithClient(
  client: Queryable,
  input: Any,
  persist = true,
): Promise<Any[]> {
  const scope = scopeForInput(input);
  const fxPolicy = input.fx_policy;
  if (!fxPolicy || fxPolicy.rates?.length !== 1) {
    throw new Error("v0.2 SQL metric runs require exactly one structured FX rate");
  }
  const definitions = new Map<string, Any>(
    M1B_METRIC_DEFINITIONS.map((definition) => [definition.metric_name, definition]),
  );
  for (const definition of input.metric_definitions ?? []) {
    definitions.set(definition.metric_name, definition);
  }
  const output: Any[] = [];

  for (const evaluation of input.metric_evaluations ?? []) {
    const snapshot = await scanSnapshotRecords(
      client,
      scope,
      evaluation.input_received_at_watermark,
      evaluation.privacy_state,
    );
    const records = snapshot.records;
    const grouping = evaluation.grouping;
    const costs = await currentCosts(client, scope, evaluation.input_received_at_watermark, grouping);
    for (const cost of costs) {
      snapshot.append([
        "cost", cost.as_of, cost.cost_record_id,
        cost.report_snapshot_digest, cost.dimension_digest,
      ]);
    }
    const inputSnapshotId = snapshot.finish();
    const evidenceRefs = [
      ...records.map((record) => ({
        tenant_id: record.tenant_id,
        app_id: record.app_id,
        ref: record.record_id,
        lifecycle_status: record.lifecycle_status,
        access_class: "protected",
      })),
      ...costs.map((cost) => ({
        tenant_id: cost.tenant_id,
        app_id: cost.app_id,
        ref: cost.cost_record_id,
        lifecycle_status: "available",
        access_class: "protected",
      })),
    ].sort((left, right) => compareText(left.ref, right.ref)
      || compareText(left.tenant_id, right.tenant_id)
      || compareText(left.app_id, right.app_id));
    const privacyAffected = records.some((record) =>
      record.lifecycle_status !== "available" && record.privacy_request_id !== null);
    const states = records.map((record) => record.lifecycle_status);
    const reproducibilityStatus = privacyAffected || states.includes("redacted")
      ? "redaction_affected"
      : states.includes("purged") ? "retention_affected" : "fully_reproducible";
    const ledger = records.at(-1);
    const fxRate = fxPolicy.rates[0];

    for (const metricName of evaluation.metric_names ?? []) {
      const definition = definitions.get(metricName);
      if (!definition) throw new Error(`unknown metric definition: ${metricName}`);
      const value = await metricValue(
        client,
        scope,
        evaluation.input_received_at_watermark,
        grouping,
        definition,
        fxPolicy,
        evaluation.privacy_state,
      );
      const moneyFields = definition.value_type === "money" && value.value_state === "present" ? {
        fx_rate_unscaled: fxRate.rate_unscaled,
        fx_rate_scale: fxRate.rate_scale,
        fx_rate_source: fxRate.source,
        fx_rate_as_of: fxRate.as_of,
        fx_rate_snapshot_id: sha256(fxPolicy.rates),
        fx_policy_version: fxPolicy.policy_version,
        amount_scale: definition.amount_scale,
        currency: definition.currency,
      } : {};
      const artifact = {
        metric_run_id: `${evaluation.metric_run_id_prefix}:${metricName}`,
        metric_name: metricName,
        metric_definition_version: definition.metric_definition_version,
        input_snapshot_id: inputSnapshotId,
        input_received_at_watermark: evaluation.input_received_at_watermark,
        input_ledger_position: ledger ? `${ledger.received_at}|${ledger.record_id}` : "empty",
        computed_at: evaluation.computed_at,
        data_freshness: evaluation.data_freshness,
        aggregation_time_zone: definition.aggregation_time_zone,
        rule_bundle_id: definition.rule_bundle_id,
        rule_bundle_version: definition.rule_bundle_version,
        rule_bundle_hash: definition.rule_bundle_hash,
        rounding_mode: fxPolicy.rounding_mode,
        reproducibility_status: reproducibilityStatus,
        value_type: definition.value_type,
        ...(value.value_state === "undefined"
          ? { value_state: "undefined", undefined_reason: value.undefined_reason }
          : { value_unscaled: value.value_unscaled }),
        ...moneyFields,
        ...(definition.value_type === "ratio" ? { ratio_scale: definition.ratio_scale } : {}),
        ...(grouping ? {
          grouping: { dimensions: grouping, dimension_digest: sha256(grouping) },
        } : {}),
        evidence_refs: evidenceRefs,
        ...(evaluation.supersedes_metric_run_id_prefix ? {
          supersedes_metric_run_id: `${evaluation.supersedes_metric_run_id_prefix}:${metricName}`,
        } : {}),
      };
      if (persist) await persistMetricRun(client, scope, artifact);
      output.push(artifact);
    }
  }
  return output.sort((left, right) => compareText(left.metric_run_id, right.metric_run_id));
}

export async function computeSqlMetricRuns(pool: Pool, input: Any, persist = true): Promise<Any[]> {
  const scope = scopeForInput(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query("SELECT set_config('open_mmp.tenant_id', $1, true)", [scope.tenant_id]);
    const output = await computeSqlMetricRunsWithClient(client, input, persist);
    await client.query("COMMIT");
    return output;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
