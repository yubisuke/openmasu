import { sha256 } from "@openmasu/attribution-core/canonical";
import type { MetricComparisonContext, RoasCalculationEvidence } from "@openmasu/runtime";
import type { MetricClient, MetricDefinition, MetricEvaluation, MetricFxPolicy, MetricReplayArtifact, MetricRun, MetricScope } from "./model.js";

export function metricReplayArtifact(
  artifact: Pick<MetricRun, "metric_run_id" | "metric_name">,
  definition: MetricDefinition,
  evaluation: MetricEvaluation,
  fxPolicy: MetricFxPolicy,
): MetricReplayArtifact {
  const { schedule_supersessions: _oneTimeHandoff, ...replayEvaluation } = evaluation;
  return {
    version: 1,
    source_metric_run_id: artifact.metric_run_id,
    metric_definition: definition,
    evaluation: { ...replayEvaluation, metric_names: [artifact.metric_name] },
    fx_policy: fxPolicy,
  };
}

export async function persistCalculatedMetricRun(client: MetricClient, scope: MetricScope, artifact: MetricRun, comparisonContext?: MetricComparisonContext): Promise<void> {
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
      supersedes_metric_run_id, artifact, comparison_context
    ) VALUES (
      $1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
      $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32::jsonb,$33::jsonb
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
      comparisonContext ? JSON.stringify(comparisonContext) : null,
    ],
  );
  if (result.rowCount !== 1) {
    throw new Error(`metric run already exists: ${artifact.metric_run_id}`);
  }
}

export async function persistMetricReplayManifest(
  client: MetricClient,
  scope: MetricScope,
  artifact: MetricRun,
  definition: MetricDefinition,
  evaluation: MetricEvaluation,
  fxPolicy: MetricFxPolicy,
): Promise<void> {
  const replayArtifact = metricReplayArtifact(artifact, definition, evaluation, fxPolicy);
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

export async function persistMetricScheduleMembership(client: MetricClient, scope: MetricScope, artifact: MetricRun, evaluation: MetricEvaluation): Promise<void> {
  const provenance = evaluation.metric_schedule;
  if (provenance) {
    await client.query(`INSERT INTO control.metric_schedule_runs
      (tenant_id,app_id,metric_run_id,metric_schedule_id,target_date,evaluation,definition_digest)
      VALUES ($1,$2,$3,$4,$5::date,$6,$7)`, [scope.tenant_id, scope.app_id, artifact.metric_run_id,
      provenance.metric_schedule_id, provenance.target_date, provenance.evaluation, provenance.definition_digest]);
  } else if (artifact.supersedes_metric_run_id) {
    // Legacy manifests can inherit already indexed provenance via their explicit source.
    await client.query(`INSERT INTO control.metric_schedule_runs
      (tenant_id,app_id,metric_run_id,metric_schedule_id,target_date,evaluation,definition_digest)
      SELECT tenant_id,app_id,$3,metric_schedule_id,target_date,evaluation,definition_digest
      FROM control.metric_schedule_runs WHERE tenant_id=$1 AND app_id=$2 AND metric_run_id=$4`,
    [scope.tenant_id, scope.app_id, artifact.metric_run_id, artifact.supersedes_metric_run_id]);
  }
}

export async function persistMetricCalculationEvidence(
  client: MetricClient, scope: MetricScope, artifact: MetricRun, evidence: RoasCalculationEvidence,
): Promise<void> {
  await client.query(
    `INSERT INTO ledger.metric_calculation_evidence
               (metric_run_id, tenant_id, app_id, input_snapshot_id, created_at, artifact)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [artifact.metric_run_id, scope.tenant_id, scope.app_id, artifact.input_snapshot_id,
      artifact.computed_at, JSON.stringify(evidence)],
  );
}
