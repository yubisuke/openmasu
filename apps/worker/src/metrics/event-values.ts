import { selectedAcquisitionSql, selectedClickJoinSql } from "./selected-acquisition.js";
import type { MetricClient, MetricDefinition, MetricGrouping, MetricScope, MetricValue } from "./model.js";

export async function eventCountValue(
  client: MetricClient,
  scope: MetricScope,
  watermark: string,
  grouping: MetricGrouping | undefined,
  definition: MetricDefinition,
  privacyState: "before" | "after",
): Promise<{ value_state: "present"; value_unscaled: string }> {
  const eventNames = definition.event_names ?? [];
  const eventName = eventNames[0];
  if (eventNames.length !== 1 || ![
    "click", "install", "deep_link_open", "skan_postback", "adattributionkit_postback",
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
    const expectedEventName = definition.metric_name.startsWith("aak_attributed_")
      ? "adattributionkit_postback"
      : "skan_postback";
    if (![
      "skan_attributed_installs", "skan_conversion_value_distribution", "aak_attributed_installs",
      "aak_attributed_reengagements",
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
         SELECT candidate.status, candidate.reason_code
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
         AND ($8::text IS NULL
           OR ($8='install' AND (fact.conversion_type IS NULL OR fact.conversion_type IN ('download','redownload')))
           OR ($8='re-engagement' AND fact.conversion_type='re-engagement'))
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
        definition.metric_name === "aak_attributed_installs"
          ? "install"
          : definition.metric_name === "aak_attributed_reengagements"
            ? "re-engagement"
            : null,
      ],
    );
    return { value_state: "present", value_unscaled: aggregate.rows[0].value_unscaled };
  }
  if (grouping.attribution_status !== undefined && !["install", "deep_link_open"].includes(eventName)) {
    throw new Error("SQL event_count attribution_status applies only to install or deep_link_open");
  }
  const result = await client.query<{ value_unscaled: string }>(
    `WITH event AS (
       SELECT
         install.installation_id,
         CASE WHEN logical.event_name='click' THEN click.campaign_id
              WHEN logical.event_name='deep_link_open' THEN deep.campaign_id
              ELSE install.campaign_id END AS campaign_id,
         CASE WHEN logical.event_name='click' THEN click.network
              WHEN logical.event_name='deep_link_open' THEN NULL
              ELSE install.network END AS network,
         CASE WHEN logical.event_name='click' THEN click.country
              WHEN logical.event_name='deep_link_open' THEN NULL
              ELSE install.country END AS country,
         CASE WHEN logical.event_name IN ('install','deep_link_open')
              THEN coalesce(attribution.status, 'unattributed') END AS attribution_status
       FROM ledger.logical_events AS logical
       JOIN ledger.raw_records_current AS raw
         ON raw.tenant_id=logical.tenant_id
        AND raw.app_id=logical.app_id
        AND raw.record_id=logical.record_id
       LEFT JOIN ledger.click_facts AS click ON click.logical_event_id=logical.logical_event_id
       LEFT JOIN ledger.install_facts AS install ON install.logical_event_id=logical.logical_event_id
       LEFT JOIN ledger.deep_link_open_facts AS deep ON deep.logical_event_id=logical.logical_event_id
       LEFT JOIN LATERAL (
         SELECT candidate.status
         FROM ledger.attribution_results AS candidate
         WHERE candidate.tenant_id=logical.tenant_id
           AND candidate.app_id=logical.app_id
           AND ((logical.event_name='install'
                 AND candidate.subject_scope='installation_level'
                 AND candidate.subject_ref=install.installation_id)
             OR (logical.event_name='deep_link_open'
                 AND candidate.subject_scope='engagement_level'
                 AND candidate.subject_ref='engagement:' || raw.record_id))
           AND candidate.decided_at <= $3
         ORDER BY candidate.decided_at DESC, candidate.attribution_id DESC
         LIMIT 1
       ) AS attribution ON logical.event_name IN ('install','deep_link_open')
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
       AND ($11::text IS NULL OR attribution_status=$11)
       AND ($12::text='gross' OR NOT EXISTS (SELECT 1 FROM ledger.attribution_results AS excluded
              WHERE excluded.tenant_id=$1 AND excluded.app_id=$2
                AND excluded.reason_code='fraud_excluded'
                AND excluded.subject_ref=event.installation_id
                AND excluded.decided_at <= $3
                AND NOT EXISTS (
                  SELECT 1 FROM ledger.attribution_results AS newer
                  WHERE newer.tenant_id=excluded.tenant_id AND newer.app_id=excluded.app_id
                    AND newer.artifact->>'supersedes_attribution_id'=excluded.attribution_id
                    AND newer.decided_at <= $3
                )))`,
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
      definition.fraud_policy ?? "gross",
    ],
  );
  return { value_state: "present", value_unscaled: result.rows[0].value_unscaled };
}
export async function customConversionValue(
  client: MetricClient, scope: MetricScope, watermark: string, grouping: MetricGrouping | undefined, definition: MetricDefinition,
  privacyState: "before" | "after",
): Promise<MetricValue> {
  const result = await client.query<{ cohort_size: string; value_unscaled: string | null }>(
    `WITH acquisition AS (${selectedAcquisitionSql}),
     cohort AS (
       SELECT DISTINCT install.installation_id, install.occurred_at_ts AS installed_at
       FROM ledger.install_facts AS install
       JOIN ledger.logical_events AS logical USING (logical_event_id)
       JOIN ledger.raw_records_current AS raw
         ON raw.record_id=logical.record_id AND raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id
       ${selectedClickJoinSql("$7", "$8")}
       WHERE install.tenant_id=$1 AND install.app_id=$2 AND install.occurred_at IS NOT NULL
         AND raw.received_at <= $3 AND ($8='before' OR raw.payload_lifecycle_status='available')
         AND ($4::text IS NULL OR coalesce(install.campaign_id, acquisition_source.campaign_id)=$4)
         AND ($5::text IS NULL OR coalesce(install.network, acquisition_source.network)=$5)
         AND ($6::text IS NULL OR install.country=$6)
         AND ($9::text IS NULL OR timezone('UTC', install.occurred_at_ts)::date::text=$9)
         AND ($10::text IS NULL OR coalesce(acquisition.status, 'unattributed')=$10)
         AND ($11::text='gross' OR acquisition.reason_code IS DISTINCT FROM 'fraud_excluded')
     ), converted AS (
       SELECT count(DISTINCT event.installation_id)::numeric AS value
       FROM ledger.custom_event_facts AS event
       JOIN cohort USING (installation_id)
       JOIN ledger.logical_events AS logical USING (logical_event_id)
       JOIN ledger.raw_records_current AS raw
         ON raw.record_id=logical.record_id AND raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id
       WHERE event.tenant_id=$1 AND event.app_id=$2 AND event.event_key=$12
         AND raw.received_at <= $3 AND ($8='before' OR raw.payload_lifecycle_status='available')
         AND control.canonical_timestamp_value(raw.occurred_at) >= cohort.installed_at
         AND control.canonical_timestamp_value(raw.occurred_at) < cohort.installed_at + interval '8 days'
     ), totals AS (SELECT count(DISTINCT installation_id)::numeric AS size FROM cohort)
     SELECT totals.size::text AS cohort_size,
       CASE WHEN totals.size=0 THEN NULL
         WHEN $13::text='converted_installations' THEN converted.value
         ELSE ledger.half_even_div(converted.value * 1000000, totals.size) END::text AS value_unscaled
     FROM totals CROSS JOIN converted`,
    [scope.tenant_id, scope.app_id, watermark, grouping?.campaign_id ?? null, grouping?.network ?? null,
      grouping?.country ?? null, true, privacyState, grouping?.cohort_date ?? null, grouping?.attribution_status ?? null,
      definition.fraud_policy ?? "gross", definition.conversion_event_key, definition.definition.calculation],
  );
  return result.rows[0].cohort_size === "0" ? { value_state: "undefined", undefined_reason: "empty_cohort" }
    : { value_state: "present", value_unscaled: result.rows[0].value_unscaled! };
}
