import { sha256 } from "@openmasu/attribution-core/canonical";
import type { OpenMasuAttributionResultV04 } from "@openmasu/contracts/types";
import { captureMetricComparisonContext, metricScheduleCalculationKey, privacyMetricInvalidationSql,
  type MetricComparisonContext, type RoasCalculationEvidence } from "@openmasu/runtime";
import { platformAcquisitionSnapshot } from "@openmasu/runtime";
import { metricScopeForInput, prepareMetricCalculation } from "./input.js";
import { compareMetricText } from "./model.js";
import type { MetricClient, MetricRun, MetricScope } from "./model.js";
import { currentCosts, disjointCosts, scanSnapshotRecords } from "./snapshot.js";
import { selectedAcquisitionSql } from "./selected-acquisition.js";
import { engagementSnapshotRows } from "./engagement.js";
import { metricValue } from "./cohort-values.js";
import { persistCalculatedMetricRun, persistMetricCalculationEvidence, persistMetricReplayManifest, persistMetricScheduleMembership } from "./persistence.js";

// This application coordinator borrows its caller's client. It owns neither a
// pool, a transaction, nor a privacy fence.
export async function executeMetricCalculation(
  client: MetricClient,
  input: unknown,
  persist = true,
  scopeOverride?: MetricScope,
): Promise<MetricRun[]> {
  const scope = scopeOverride ?? metricScopeForInput(input);
  const { fxPolicy, definitions, evaluations } = prepareMetricCalculation(input);
  const output: MetricRun[] = [];

  for (const evaluation of evaluations) {
    const snapshot = await scanSnapshotRecords(
      client,
      scope,
      evaluation.input_received_at_watermark,
      evaluation.privacy_state,
    );
    const records = snapshot.records;
    const grouping = evaluation.grouping;
    const onlyDailyAcquisition = evaluation.metric_names?.length && evaluation.metric_names.every((name: string) =>
      definitions.get(name)?.rule_bundle_id === "metric-selected-daily-acquisition");
    const legacyCosts = onlyDailyAcquisition ? [] : await currentCosts(client, scope, evaluation.input_received_at_watermark, grouping);
    const needsDisjoint = (evaluation.metric_names ?? []).some((name: string) => definitions.get(name)?.cost_selection_policy);
    const safeCosts = needsDisjoint ? await disjointCosts(client, scope, evaluation.input_received_at_watermark, grouping) : undefined;
    const needsDetail = (evaluation.metric_names ?? []).some((name: string) => definitions.get(name)?.acquisition_dimension_policy);
    const detailCosts = needsDetail ? await disjointCosts(client, scope, evaluation.input_received_at_watermark, grouping, true) : undefined;
    const usesAcquisition = (evaluation.metric_names ?? []).some((name: string) => definitions.get(name)?.acquisition_basis);
    const usesPlatform = (evaluation.metric_names ?? []).some((name: string) => definitions.get(name)?.acquisition_basis === "selected_verified_platform");
    const platformSnapshot = usesPlatform ? await platformAcquisitionSnapshot(client, scope.tenant_id, scope.app_id, evaluation.input_received_at_watermark) : undefined;
    const usesEngagement = (evaluation.metric_names ?? []).some((name: string) => definitions.get(name)?.engagement_credit_policy);
    const engagementRows = usesEngagement ? await engagementSnapshotRows(client, scope, evaluation.input_received_at_watermark) : [];
    const acquisitionRows = usesAcquisition ? (await client.query<{ artifact: OpenMasuAttributionResultV04 }>(
      selectedAcquisitionSql, [scope.tenant_id, scope.app_id, evaluation.input_received_at_watermark],
    )).rows.map(({ artifact }) => artifact).sort((a, b) => compareMetricText(a.tenant_id, b.tenant_id)
      || compareMetricText(a.app_id, b.app_id) || compareMetricText(a.attribution_id, b.attribution_id))
      .map((artifact) => [artifact.tenant_id, artifact.app_id, artifact.attribution_id, sha256(artifact)]) : [];
    const recordEvidence = records.map((record) => ({
        tenant_id: record.tenant_id,
        app_id: record.app_id,
        ref: record.record_id,
        lifecycle_status: record.lifecycle_status,
        access_class: "protected" as const,
      }));
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
      if (definition.acquisition_basis === "selected_verified_platform" && (grouping?.campaign_id || grouping?.ad_group_id)
          && !grouping?.network) throw new Error("platform_acquisition_source_required");
      const selectedDaily = definition.rule_bundle_id === "metric-selected-daily-acquisition";
      if (selectedDaily && grouping?.acquisition_campaign_state !== undefined &&
          !["known", "unknown"].includes(grouping.acquisition_campaign_state)) {
        throw new Error("daily_acquisition_campaign_state_invalid");
      }
      if (!selectedDaily && grouping?.acquisition_campaign_state !== undefined) {
        throw new Error(`unsupported acquisition campaign state for ${metricName}`);
      }
      if (selectedDaily && Object.keys(grouping ?? {}).some((key) => !new Set<string>(definition.grouping_dimensions).has(key))) {
        throw new Error(`unsupported grouping for ${metricName}`);
      }
      if (!definition.acquisition_dimension_policy && !(definition.acquisition_basis === "selected_verified_platform" && grouping?.creative_id === undefined) && (grouping?.ad_group_id !== undefined || grouping?.creative_id !== undefined)) {
        throw new Error(`unsupported detail grouping for ${metricName}`);
      }
      const selectedCosts = definition.acquisition_dimension_policy ? detailCosts : definition.cost_selection_policy ? safeCosts : undefined;
      const costs = definition.engagement_credit_policy || selectedDaily ? [] : selectedCosts?.rows ?? legacyCosts;
      const inputSnapshotId = snapshot.finish(costs.map((cost) => [
        "cost", cost.as_of, cost.cost_record_id, cost.report_snapshot_digest, cost.dimension_digest,
      ]));
      const evidenceRefs = [...recordEvidence, ...costs.map((cost) => ({
        tenant_id: cost.tenant_id, app_id: cost.app_id, ref: cost.cost_record_id,
        lifecycle_status: "available" as const, access_class: "protected" as const,
      }))].sort((left, right) => compareMetricText(left.ref, right.ref)
        || compareMetricText(left.tenant_id, right.tenant_id) || compareMetricText(left.app_id, right.app_id));
      const value = await metricValue(
        client,
        scope,
        evaluation.input_received_at_watermark,
        grouping,
        definition,
        fxPolicy,
        evaluation.privacy_state,
        selectedCosts,
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
      const handoff = evaluation.supersedes_metric_run_id || evaluation.supersedes_metric_run_id_prefix
        ? undefined : evaluation.schedule_supersessions?.[metricName];
      const artifact: MetricRun = {
        metric_run_id: `${evaluation.metric_run_id_prefix}:${metricName}`,
        metric_name: metricName,
        metric_definition_version: definition.metric_definition_version,
        input_snapshot_id: definition.engagement_credit_policy ? sha256({
          record_snapshot_id: inputSnapshotId, engagement_inputs: engagementRows,
        }) : definition.acquisition_basis === "selected_verified_platform" ? sha256({
          record_and_cost_snapshot_id: inputSnapshotId,
          acquisition_attributions: platformSnapshot!.acquisition_attributions,
          platform_acquisition_inputs: platformSnapshot!.platform_acquisition_inputs,
        }) : definition.acquisition_basis ? sha256({
          record_and_cost_snapshot_id: inputSnapshotId, acquisition_attributions: acquisitionRows,
        }) : inputSnapshotId,
        input_received_at_watermark: evaluation.input_received_at_watermark,
        input_ledger_position: ledger ? `${ledger.received_at}|${ledger.record_id}` : "empty",
        computed_at: evaluation.computed_at,
        data_freshness: evaluation.data_freshness,
        aggregation_time_zone: definition.aggregation_time_zone,
        rule_bundle_id: definition.rule_bundle_id,
        rule_bundle_version: definition.rule_bundle_version,
        rule_bundle_hash: definition.rule_bundle_hash,
        rounding_mode: fxPolicy.rounding_mode,
        reproducibility_status: definition.acquisition_basis !== "selected_verified_platform" ? reproducibilityStatus
          : reproducibilityStatus === "redaction_affected" || platformSnapshot?.redacted ? "redaction_affected"
          : reproducibilityStatus === "retention_affected" || platformSnapshot?.purged ? "retention_affected" : "fully_reproducible",
        ...(definition.fraud_policy ? { fraud_policy: definition.fraud_policy } : {}),
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
        ...(handoff || evaluation.supersedes_metric_run_id || evaluation.supersedes_metric_run_id_prefix ? {
          supersedes_metric_run_id: handoff?.source_metric_run_id ?? evaluation.supersedes_metric_run_id ?? `${evaluation.supersedes_metric_run_id_prefix}:${metricName}`,
        } : {}),
      };
      const comparisonContext = captureMetricComparisonContext(artifact, definition, fxPolicy, evaluation.privacy_state, sha256);
      if (handoff) {
        const source = (await client.query<{ artifact: MetricRun; comparison_context: MetricComparisonContext | null;
          privacy_changed: boolean; conflicting_successor: boolean }>(
          `SELECT mr.artifact,mr.comparison_context,${privacyMetricInvalidationSql("mr")} AS privacy_changed,
            EXISTS (SELECT 1 FROM ledger.metric_runs AS successor WHERE successor.tenant_id=mr.tenant_id
              AND successor.app_id=mr.app_id AND successor.supersedes_metric_run_id=mr.metric_run_id
              AND successor.metric_run_id<>$4) AS conflicting_successor
            FROM ledger.metric_runs AS mr WHERE mr.tenant_id=$1 AND mr.app_id=$2 AND mr.metric_run_id=$3`,
          [scope.tenant_id, scope.app_id, handoff.source_metric_run_id, artifact.metric_run_id],
        )).rows[0];
        if (!source || source.privacy_changed || source.conflicting_successor
            || sha256(metricScheduleCalculationKey(scope, source.artifact, source.comparison_context)) !== handoff.calculation_key_digest
            || source.comparison_context?.definition_digest !== comparisonContext.definition_digest
            || source.comparison_context?.fx_digest !== comparisonContext.fx_digest
            || source.comparison_context?.privacy_state !== comparisonContext.privacy_state
            || sha256(source.artifact.grouping?.dimensions ?? {}) !== sha256(grouping ?? {})
            || source.artifact.input_received_at_watermark > evaluation.input_received_at_watermark) {
          throw new Error("metric_schedule_source_key_conflict");
        }
      }
      if (persist) {
        await persistCalculatedMetricRun(client, scope, artifact, comparisonContext);
        await persistMetricScheduleMembership(client, scope, artifact, evaluation);
        await persistMetricReplayManifest(client, scope, artifact, definition, evaluation, fxPolicy);
        if (value.operands || value.totalNetOperands) {
          const evidence: RoasCalculationEvidence = {
            calculation: "revenue_over_cost", denominator: "cost",
            metric_run_id: artifact.metric_run_id, input_snapshot_id: artifact.input_snapshot_id,
            metric_definition_version: definition.metric_definition_version, definition_digest: sha256(definition),
            anchor_event: definition.anchor_event,
            window: { type: "elapsed", day: definition.definition.window.day, boundary: "half_open" },
            aggregation_time_zone: definition.aggregation_time_zone,
            fraud_policy: definition.fraud_policy ?? "gross", cost_basis: "cohort_acquisition_day_current_snapshot",
            cost_selection_digest: sha256(costs), fx_policy_version: fxPolicy.policy_version,
            fx_snapshot_id: sha256(fxPolicy.rates), target_currency: fxPolicy.target_currency,
            target_scale: fxPolicy.target_scale,
            rates: fxPolicy.rates.map((rate) => ({ currency: rate.currency,
              rate_unscaled: rate.rate_unscaled, rate_scale: rate.rate_scale })),
            // Ratio profiles require this field; retain the legacy value without inventing a default.
            rounding_mode: "half_even", ratio_scale: definition.ratio_scale!,
            ...(value.totalNetOperands
              ? definition.refund_reversal_policy
                ? { version: 3, numerator: "total_net_revenue", refund_reversal_policy: "cancel_target_refund_at_watermark",
                  operands: { ...value.totalNetOperands,
                    refund_reversal_unscaled: value.totalNetOperands.refund_reversal_unscaled!,
                    refund_reversal_event_count: value.totalNetOperands.refund_reversal_event_count! } }
                : { version: 2, numerator: "total_net_revenue", operands: value.totalNetOperands }
              : { version: 1, numerator: "revenue", operands: value.operands! }),
          };
          await persistMetricCalculationEvidence(client, scope, artifact, evidence);
        }
      }
      output.push(artifact);
    }
  }
  return output.sort((left, right) => compareMetricText(left.metric_run_id, right.metric_run_id));
}
