import type { Pool, PoolClient } from "pg";
import { createHash } from "node:crypto";
import { M1B_METRIC_DEFINITIONS } from "@open-mmp/contracts";
import { jcs, sha256 } from "@open-mmp/attribution-core";

type Any = Record<string, any>;
type Queryable = Pick<PoolClient, "query">;

export type MetricScope = { tenant_id: string; app_id: string };
type Scope = MetricScope;
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
  if (grouping?.attribution_status !== undefined && grouping.attribution_status !== "non_organic") return [];
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

async function eventCountValue(
  client: Queryable,
  scope: Scope,
  watermark: string,
  grouping: Any,
  definition: Any,
  privacyState: "before" | "after",
): Promise<{ value_state: "present"; value_unscaled: string }> {
  const eventNames = definition.event_names ?? [];
  const eventName = eventNames[0];
  if (eventNames.length !== 1 || ![
    "click", "install", "skan_postback", "adattributionkit_postback",
  ].includes(eventName)) {
    throw new Error("SQL event_count requires exactly one supported event");
  }
  if (typeof grouping?.metric_date !== "string") {
    throw new Error("SQL event_count requires grouping.metric_date");
  }
  const aggregatePostback = eventName === "skan_postback" || eventName === "adattributionkit_postback";
  if (aggregatePostback) {
    if (definition.aggregation_time_zone !== "UTC") {
      throw new Error(`SQL aggregate event_count requires UTC aggregation: ${definition.metric_name}`);
    }
    if (grouping.attribution_status !== undefined) {
      throw new Error(`SQL aggregate event_count forbids attribution_status: ${definition.metric_name}`);
    }
    const expectedEventName = definition.metric_name === "aak_attributed_installs"
      ? "adattributionkit_postback"
      : "skan_postback";
    if (![
      "skan_attributed_installs", "skan_conversion_value_distribution", "aak_attributed_installs",
    ].includes(definition.metric_name) || eventName !== expectedEventName) {
      throw new Error(`SQL aggregate metric and event mismatch: ${definition.metric_name}`);
    }
    const conversionBucket = grouping.apple_conversion_bucket;
    if (definition.metric_name === "skan_conversion_value_distribution" && conversionBucket === undefined) {
      throw new Error("SQL SKAN conversion distribution requires apple_conversion_bucket");
    }
    if (definition.metric_name !== "skan_conversion_value_distribution" && conversionBucket !== undefined) {
      throw new Error("SQL apple_conversion_bucket is reserved for SKAN conversion distribution");
    }
    const aggregate = await client.query<{ value_unscaled: string }>(
      `SELECT count(*)::text AS value_unscaled
       FROM ledger.logical_events AS logical
       JOIN ledger.raw_records_current AS raw
         ON raw.tenant_id=logical.tenant_id
        AND raw.app_id=logical.app_id
        AND raw.record_id=logical.record_id
       JOIN ledger.apple_postback_facts AS fact
         ON fact.tenant_id=logical.tenant_id
        AND fact.app_id=logical.app_id
        AND fact.logical_event_id=logical.logical_event_id
       JOIN LATERAL (
         SELECT candidate.status
         FROM ledger.attribution_results AS candidate
         WHERE candidate.tenant_id=logical.tenant_id
           AND candidate.app_id=logical.app_id
           AND candidate.subject_scope='aggregate'
           AND candidate.decided_at <= $3
           AND candidate.artifact->'evidence_refs' @>
             jsonb_build_array(jsonb_build_object('ref', raw.record_id))
         ORDER BY candidate.decided_at DESC, candidate.attribution_id DESC
         LIMIT 1
       ) AS attribution ON attribution.status='non_organic'
       WHERE logical.tenant_id=$1 AND logical.app_id=$2
         AND raw.received_at <= $3
         AND ($4='before' OR raw.payload_lifecycle_status='available')
         AND logical.event_name=$5
         AND fact.signature_verified
         AND fact.did_win
         AND fact.source_identifier_present
         AND fact.conversion_bucket IS NOT NULL
         AND timezone('UTC', control.canonical_timestamp_value(fact.received_at))::date=$6::date
         AND ($7::text IS NULL OR fact.conversion_bucket=$7)`,
      [
        scope.tenant_id,
        scope.app_id,
        watermark,
        privacyState,
        eventName,
        grouping.metric_date,
        conversionBucket ?? null,
      ],
    );
    return { value_state: "present", value_unscaled: aggregate.rows[0].value_unscaled };
  }
  if (grouping.attribution_status !== undefined && eventName !== "install") {
    throw new Error("SQL event_count attribution_status applies only to install");
  }
  const result = await client.query<{ value_unscaled: string }>(
    `WITH event AS (
       SELECT
         CASE WHEN logical.event_name='click' THEN click.campaign_id ELSE install.campaign_id END AS campaign_id,
         CASE WHEN logical.event_name='click' THEN click.network ELSE install.network END AS network,
         CASE WHEN logical.event_name='click' THEN click.country ELSE install.country END AS country,
         CASE WHEN logical.event_name='install' THEN coalesce(attribution.status, 'unattributed') END AS attribution_status
       FROM ledger.logical_events AS logical
       JOIN ledger.raw_records_current AS raw
         ON raw.tenant_id=logical.tenant_id
        AND raw.app_id=logical.app_id
        AND raw.record_id=logical.record_id
       LEFT JOIN ledger.click_facts AS click ON click.logical_event_id=logical.logical_event_id
       LEFT JOIN ledger.install_facts AS install ON install.logical_event_id=logical.logical_event_id
       LEFT JOIN LATERAL (
         SELECT candidate.status
         FROM ledger.attribution_results AS candidate
         WHERE candidate.tenant_id=logical.tenant_id
           AND candidate.app_id=logical.app_id
           AND candidate.subject_scope='installation_level'
           AND candidate.subject_ref=install.installation_id
           AND candidate.decided_at <= $3
         ORDER BY candidate.decided_at DESC, candidate.attribution_id DESC
         LIMIT 1
       ) AS attribution ON logical.event_name='install'
       WHERE logical.tenant_id=$1 AND logical.app_id=$2
         AND raw.received_at <= $3
         AND ($4='before' OR raw.payload_lifecycle_status='available')
         AND logical.event_name=$5
         AND control.canonical_timestamp_value(raw.occurred_at)
           >= ($6::date::timestamp AT TIME ZONE $7)
         AND control.canonical_timestamp_value(raw.occurred_at)
           < (($6::date + 1)::timestamp AT TIME ZONE $7)
     )
     SELECT count(*)::text AS value_unscaled
     FROM event
     WHERE ($8::text IS NULL OR campaign_id=$8)
       AND ($9::text IS NULL OR network=$9)
       AND ($10::text IS NULL OR country=$10)
       AND ($11::text IS NULL OR attribution_status=$11)`,
    [
      scope.tenant_id,
      scope.app_id,
      watermark,
      privacyState,
      eventName,
      grouping.metric_date,
      definition.aggregation_time_zone,
      grouping.campaign_id ?? null,
      grouping.network ?? null,
      grouping.country ?? null,
      grouping.attribution_status ?? null,
    ],
  );
  return { value_state: "present", value_unscaled: result.rows[0].value_unscaled };
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
  if (calculation === "event_count") {
    return eventCountValue(client, scope, watermark, grouping, definition, privacyState);
  }
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
         LEFT JOIN LATERAL (
           SELECT candidate.status
           FROM ledger.attribution_results AS candidate
           WHERE candidate.tenant_id=install.tenant_id
             AND candidate.app_id=install.app_id
             AND candidate.subject_scope='installation_level'
             AND candidate.subject_ref=install.installation_id
           ORDER BY candidate.decided_at DESC, candidate.attribution_id DESC
           LIMIT 1
         ) AS attribution ON true
         WHERE install.tenant_id=$1 AND install.app_id=$2 AND install.occurred_at IS NOT NULL
           AND raw.received_at <= $3
           AND ($15='before' OR raw.payload_lifecycle_status='available')
           AND ($4::text IS NULL OR install.campaign_id=$4)
           AND ($5::text IS NULL OR install.network=$5)
           AND ($6::text IS NULL OR install.country=$6)
           AND ($7::text IS NULL OR timezone($8, install.occurred_at_ts)::date::text=$7)
           AND ($16::text IS NULL OR attribution.status=$16)
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
             AND ($16::text IS NULL OR $16='non_organic')
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
      grouping?.attribution_status ?? null,
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

export async function persistMetricRun(client: Queryable, scope: Scope, artifact: Any): Promise<void> {
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

async function persistMetricReplayManifest(
  client: Queryable,
  scope: Scope,
  artifact: Any,
  definition: Any,
  evaluation: Any,
  fxPolicy: Any,
): Promise<void> {
  const replayArtifact = {
    version: 1,
    source_metric_run_id: artifact.metric_run_id,
    metric_definition: definition,
    evaluation: {
      ...evaluation,
      metric_names: [artifact.metric_name],
    },
    fx_policy: fxPolicy,
  };
  const manifestId = `metric-replay:${sha256(replayArtifact).slice(0, 48)}`;
  await client.query(
    `INSERT INTO control.metric_replay_manifests (
      metric_replay_manifest_id, tenant_id, app_id, source_metric_run_id, created_at, artifact
    ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    ON CONFLICT (tenant_id, app_id, source_metric_run_id) DO NOTHING`,
    [
      manifestId,
      scope.tenant_id,
      scope.app_id,
      artifact.metric_run_id,
      artifact.computed_at,
      JSON.stringify(replayArtifact),
    ],
  );
}

export async function computeSqlMetricRunsWithClient(
  client: Queryable,
  input: Any,
  persist = true,
  scopeOverride?: MetricScope,
): Promise<Any[]> {
  const scope = scopeOverride ?? scopeForInput(input);
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
  for (const definition of definitions.values()) assertMetricDefinitionSeries(definition);
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
      if (persist) {
        await persistMetricRun(client, scope, artifact);
        await persistMetricReplayManifest(client, scope, artifact, definition, evaluation, fxPolicy);
      }
      output.push(artifact);
    }
  }
  return output.sort((left, right) => compareText(left.metric_run_id, right.metric_run_id));
}

function assertMetricDefinitionSeries(definition: Any): void {
  const aggregateNames = new Set([
    "skan_attributed_installs", "skan_conversion_value_distribution", "aak_attributed_installs",
  ]);
  const eventNames = definition.event_names ?? [];
  const grouping = definition.grouping_dimensions ?? [];
  const fail = () => { throw new Error(`metric_definition_series_mismatch:${definition.metric_name}`); };
  if (aggregateNames.has(definition.metric_name)) {
    const expectedEvent = definition.metric_name === "aak_attributed_installs"
      ? "adattributionkit_postback" : "skan_postback";
    const expectedGrouping = definition.metric_name === "skan_conversion_value_distribution"
      ? ["metric_date", "apple_conversion_bucket"] : ["metric_date"];
    if (definition.definition?.calculation !== "event_count" || definition.definition?.numerator !== "events" ||
        definition.aggregation_time_zone !== "UTC" || eventNames.length !== 1 || eventNames[0] !== expectedEvent ||
        grouping.length !== expectedGrouping.length || expectedGrouping.some((value) => !grouping.includes(value))) fail();
    return;
  }
  if (eventNames.some((value: string) => value === "skan_postback" || value === "adattributionkit_postback") ||
      grouping.includes("apple_conversion_bucket")) fail();
}

export async function computeSqlMetricRuns(
  pool: Pool,
  input: Any,
  persist = true,
  scopeOverride?: MetricScope,
): Promise<Any[]> {
  const scope = scopeOverride ?? scopeForInput(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query("SELECT set_config('open_mmp.tenant_id', $1, true)", [scope.tenant_id]);
    const output = await computeSqlMetricRunsWithClient(client, input, persist, scope);
    await client.query("COMMIT");
    return output;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
