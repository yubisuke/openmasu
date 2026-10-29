export { buildMetricQuery } from "@openmasu/runtime/metric-report-query";
import { ReportQueryError, type GroupingDimension, type MetricQuery, type ParameterizedQuery } from "./report-query-model.js";
export * from "./report-query-model.js";

function push(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${values.length}`;
}

function runDateExpression(alias: string): string {
  return `COALESCE(NULLIF(${alias}.grouping->>'metric_date',''), NULLIF(${alias}.grouping->>'cohort_date',''))`;
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
