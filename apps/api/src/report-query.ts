import { privacyMetricInvalidationSql, revisedMetricCostPredicate } from "@openmasu/runtime";
import { ReportQueryError, type GroupingDimension, type MetricQuery, type ParameterizedQuery } from "./report-query-model.js";
export * from "./report-query-model.js";

function push(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${values.length}`;
}

function runDateExpression(alias: string): string {
  return `COALESCE(NULLIF(${alias}.grouping->>'metric_date',''), NULLIF(${alias}.grouping->>'cohort_date',''))`;
}

export function buildMetricQuery(query: MetricQuery, checkEvidence = false): ParameterizedQuery {
  const values: unknown[] = [query.tenantId, query.appId];
  const predicates = ["mr.tenant_id=$1", "mr.app_id=$2"];
  if (query.metricNames) predicates.push(`mr.metric_name=ANY(${push(values, query.metricNames)}::text[])`);
  if (query.metricDefinitionVersion) predicates.push(`mr.metric_definition_version=${push(values, query.metricDefinitionVersion)}`);
  if (query.metricScheduleId) predicates.push(`EXISTS (
    SELECT 1 FROM control.metric_schedule_runs AS series WHERE series.tenant_id=mr.tenant_id
      AND series.app_id=mr.app_id AND series.metric_run_id=mr.metric_run_id
      AND series.metric_schedule_id=${push(values, query.metricScheduleId)})`);
  for (const [dimension, value] of Object.entries(query.grouping ?? {}) as [GroupingDimension, string][]) {
    predicates.push(`mr.grouping->>'${dimension}'=${push(values, value)}`);
  }
  if (query.dateFrom) predicates.push(`${runDateExpression("mr")} >= ${push(values, query.dateFrom)}`);
  if (query.dateTo) predicates.push(`${runDateExpression("mr")} < ${push(values, query.dateTo)}`);
  if (query.watermarkAtMost) predicates.push(`control.canonical_timestamp_value(mr.input_received_at_watermark) <= ${push(values, query.watermarkAtMost)}::timestamptz`);
  if (query.supersession === "latest") {
    predicates.push(`NOT EXISTS (
      SELECT 1 FROM ledger.metric_runs AS replacement
      WHERE replacement.tenant_id=mr.tenant_id AND replacement.app_id=mr.app_id
        AND replacement.supersedes_metric_run_id=mr.metric_run_id
    )`);
  }
  if (query.after) {
    const metric = push(values, query.after.metricName);
    const grouping = push(values, query.after.groupingDigest);
    const run = push(values, query.after.metricRunId);
    predicates.push(`(mr.metric_name COLLATE "C", mr.grouping_digest COLLATE "C", mr.metric_run_id COLLATE "C")
      > (${metric} COLLATE "C", ${grouping} COLLATE "C", ${run} COLLATE "C")`);
  }
  const revisionCutoff = query.watermarkAtMost ? push(values, query.watermarkAtMost) : undefined;
  const limit = push(values, query.limit + 1);
  return {
    text: `SELECT mr.artifact, mr.grouping_digest, mr.comparison_context,
      ${privacyMetricInvalidationSql("mr")} AS privacy_changed,
      (SELECT CASE WHEN item.state IN ('queued','processing','retry') THEN 'recalculation_pending'
          WHEN item.state='completed' THEN 'completed' ELSE 'unavailable' END
        FROM control.metric_recalculation_items AS item
        JOIN control.metric_recalculation_jobs AS job USING (tenant_id,app_id,recalculation_id)
        WHERE item.tenant_id=mr.tenant_id AND item.app_id=mr.app_id AND item.source_metric_run_id=mr.metric_run_id
          AND job.trigger_kind='privacy_deletion'
        ORDER BY job.created_at DESC,job.recalculation_id COLLATE "C" DESC LIMIT 1) AS privacy_update_state,
      CASE
        WHEN EXISTS (SELECT 1 FROM control.metric_recalculation_items AS item
          JOIN control.metric_recalculation_jobs AS job USING (tenant_id,app_id,recalculation_id)
          WHERE item.tenant_id=mr.tenant_id AND item.app_id=mr.app_id AND item.source_metric_run_id=mr.metric_run_id
            AND job.trigger_kind='cost_revision'
            AND item.state IN ('queued','processing','retry')
            ${revisionCutoff ? `AND control.canonical_timestamp_value(job.watermark)<=${revisionCutoff}::timestamptz` : ""}) THEN 'recalculation_pending'
        WHEN EXISTS (SELECT 1 FROM ledger.cost_records AS cost WHERE ${revisedMetricCostPredicate}
            ${revisionCutoff ? `AND control.canonical_timestamp_value(cost.as_of)<=${revisionCutoff}::timestamptz` : ""}) THEN 'input_revised'
        WHEN mr.comparison_context IS NULL THEN 'unknown'
        ELSE 'no_recorded_revision'
      END AS cost_update_state,
      coalesce((SELECT CASE WHEN item.state IN ('queued','processing','retry') THEN 'recalculation_pending'
          WHEN item.state IN ('unavailable','failed','skipped') THEN 'unavailable' ELSE 'completed' END
        FROM control.metric_recalculation_items AS item
        JOIN control.metric_recalculation_jobs AS job USING (tenant_id,app_id,recalculation_id)
        WHERE item.tenant_id=mr.tenant_id AND item.app_id=mr.app_id AND item.source_metric_run_id=mr.metric_run_id
          AND job.trigger_kind='late_events'
          ${revisionCutoff ? `AND control.canonical_timestamp_value(job.watermark)<=${revisionCutoff}::timestamptz` : ""}
        ORDER BY job.created_at DESC,job.recalculation_id COLLATE "C" DESC LIMIT 1),
        'no_recorded_request') AS late_input_update_state,
      ${checkEvidence ? `EXISTS (
        SELECT 1 FROM jsonb_array_elements(coalesce(mr.artifact->'evidence_refs', '[]'::jsonb)) AS ref
        LEFT JOIN ledger.raw_records_current AS raw
          ON raw.tenant_id=mr.tenant_id AND raw.app_id=mr.app_id AND raw.record_id=ref->>'ref'
        LEFT JOIN ledger.cost_records AS cost
          ON cost.tenant_id=mr.tenant_id AND cost.app_id=mr.app_id AND cost.cost_record_id=ref->>'ref'
        WHERE (raw.record_id IS NOT NULL AND raw.payload_lifecycle_status <> 'available')
          OR (raw.record_id IS NULL AND cost.cost_record_id IS NULL)
      ) AS evidence_unavailable,` : ""}
      EXISTS (
        SELECT 1 FROM ledger.metric_runs AS replacement
        WHERE replacement.tenant_id=mr.tenant_id AND replacement.app_id=mr.app_id
          AND replacement.supersedes_metric_run_id=mr.metric_run_id
      ) AS superseded
      FROM ledger.metric_runs AS mr
      WHERE ${predicates.join("\n        AND ")}
      ORDER BY mr.metric_name COLLATE "C", mr.grouping_digest COLLATE "C", mr.metric_run_id COLLATE "C"
      LIMIT ${limit}`,
    values,
  };
}

export function buildDifferenceQuery(query: MetricQuery): ParameterizedQuery {
  if (query.metricScheduleId) throw new ReportQueryError("metric_schedule_filter_unsupported");
  const values: unknown[] = [query.tenantId, query.appId];
  const selection = query.differenceAfter?.selectionSequence;
  const selectionQuery = selection === undefined
    ? `SELECT COALESCE(MAX(candidate.reconciliation_selection_seq), 0)::bigint AS selection_seq
         FROM ledger.reconciliation_results AS candidate
        WHERE candidate.tenant_id=$1 AND candidate.app_id=$2`
    : `SELECT ${push(values, selection)}::bigint AS selection_seq`;
  const predicates = [
    "rr.tenant_id=$1",
    "rr.app_id=$2",
    "rr.reconciliation_selection_seq <= selection_fence.selection_seq",
  ];
  if (query.differenceReasonCode) {
    predicates.push(`rr.difference_reason_code=${push(values, query.differenceReasonCode)}`);
  }
  const artifactDate = "COALESCE(NULLIF(rr.artifact->>'metric_date',''), NULLIF(rr.artifact->>'cohort_date',''))";
  if (query.dateFrom) predicates.push(`${artifactDate} >= ${push(values, query.dateFrom)}`);
  if (query.dateTo) predicates.push(`${artifactDate} < ${push(values, query.dateTo)}`);
  if (query.supersession === "latest") {
    predicates.push(`NOT EXISTS (
      SELECT 1 FROM ledger.reconciliation_results AS replacement
      WHERE replacement.tenant_id=rr.tenant_id AND replacement.app_id=rr.app_id
        AND replacement.supersedes_reconciliation_id=rr.reconciliation_id
        AND replacement.reconciliation_selection_seq <= selection_fence.selection_seq
    )`);
  }
  if (query.differenceAfter) {
    predicates.push(`rr.reconciliation_id COLLATE "C" > ${push(values, query.differenceAfter.reconciliationId)} COLLATE "C"`);
  }
  const limit = push(values, query.limit + 1);
  return {
    text: `WITH selection_fence AS MATERIALIZED (
      ${selectionQuery}
    )
    SELECT rr.artifact, selection_fence.selection_seq::text AS selection_seq,
      EXISTS (
        SELECT 1 FROM ledger.reconciliation_results AS replacement
        WHERE replacement.tenant_id=rr.tenant_id AND replacement.app_id=rr.app_id
          AND replacement.supersedes_reconciliation_id=rr.reconciliation_id
          AND replacement.reconciliation_selection_seq <= selection_fence.selection_seq
      ) AS superseded
      FROM ledger.reconciliation_results AS rr
      CROSS JOIN selection_fence
      WHERE ${predicates.join("\n        AND ")}
      ORDER BY rr.reconciliation_id COLLATE "C"
      LIMIT ${limit}`,
    values,
  };
}
