import { sha256 } from "./canonical.js";
import { selectDisjointCosts } from "./cost-selection.js";
import { selectPlatformAcquisition, platformAcquisitionDimensions, selectedPlatformProofRows } from "./platform-acquisition.js";
import { engagementInputs, engagementSnapshotRows, engagementValue } from "./engagement-metrics.js";
import { REFERENCE_AD_REVENUE_METRIC_DEFINITIONS } from "@openmasu/contracts/definitions";
import { assertMetricDefinitionSeries } from "@openmasu/contracts/validation";
import { attemptEvidenceKey, decisionFor, evidenceKey, sortCandidateAttempts } from "./candidates.js";
import { resolveRefundTarget } from "./ingestion-decisions.js";
import { CONTRACT_VERSION, type Any, type Attempt, type Attribution, type CostRecord, type Decisions, type LifecycleStatus, type MetricDefinition, type MetricRun } from "./evaluation-model.js";
import { compareText, compositeKey, dateAt, DAY_MS, roundHalfEven, sortByKey, time } from "./evaluation-utils.js";

function baseMetricDefinitions(): MetricDefinition[] {
  return REFERENCE_AD_REVENUE_METRIC_DEFINITIONS.map((definition) => structuredClone(definition));
}

export function metricDefinitions(input: Any): MetricDefinition[] {
  const definitions = [...baseMetricDefinitions(), ...(input.metric_definitions ?? [])];
  const names = new Set<string>();
  for (const definition of definitions) {
    if (names.has(definition.metric_name)) throw new Error(`duplicate metric definition: ${definition.metric_name}`);
    assertMetricDefinitionSeries(definition, "reference");
    names.add(definition.metric_name);
  }
  return sortByKey(definitions, (definition) => [definition.metric_name, definition.metric_definition_version]);
}


export function costRecords(input: Any): CostRecord[] {
  const records: CostRecord[] = (input.cost_records ?? []).map((record: Any) => {
    const dimensions = Object.fromEntries(
      ["network", "campaign_id", "ad_group_id", "creative_id", "country"]
        .filter((field) => record[field] !== undefined)
        .map((field) => [field, record[field]]),
    );
    if (record.dimension_digest !== sha256(dimensions)) {
      throw new Error(`cost dimension_digest mismatch: ${record.cost_record_id}`);
    }
    return { ...record, contract_version: CONTRACT_VERSION };
  });
  return sortByKey(records, (record) => [record.cost_record_id, record.tenant_id, record.app_id, record.as_of]);
}

function convertMoney(payload: Any, fxPolicy: Any): bigint {
  const rate = (fxPolicy.rates ?? []).find((candidate: Any) => candidate.currency === payload.currency);
  if (!rate) throw new Error(`missing FX rate for ${payload.currency}`);
  const numerator = BigInt(payload.amount_unscaled) * BigInt(rate.rate_unscaled) * (10n ** BigInt(fxPolicy.target_scale));
  const denominator = 10n ** BigInt(Number(payload.amount_scale) + Number(rate.rate_scale));
  return roundHalfEven(numerator, denominator);
}

function selectedAcquisitionAttributions(
  attributions: Attribution[], included: Attempt[], watermark: string,
): Map<string, Attribution> {
  const records = new Set(included.map(attemptEvidenceKey));
  const subjects = new Set(included.filter((attempt) => attempt.record.event_name === "install")
    .map((attempt) => compositeKey([attempt.server.tenant_id, attempt.server.app_id, attempt.record.payload.installation_id])));
  const eligible = attributions.filter((attribution) => attribution.subject_scope === "installation_level"
    && subjects.has(compositeKey([attribution.tenant_id, attribution.app_id, attribution.subject_ref]))
    && attribution.decided_at <= watermark && attribution.input_cutoff_at <= watermark
    && attribution.evidence_refs.every((ref) => ref.tenant_id === attribution.tenant_id && ref.app_id === attribution.app_id
      && records.has(evidenceKey(ref.tenant_id, ref.app_id, ref.ref))));
  const superseded = new Set(eligible.filter((item) => item.supersedes_attribution_id)
    .map((item) => compositeKey([item.tenant_id, item.app_id, item.supersedes_attribution_id])));
  return new Map(sortByKey(eligible.filter((item) =>
    !superseded.has(compositeKey([item.tenant_id, item.app_id, item.attribution_id]))),
  (item) => [item.decided_at, item.attribution_id]).map((item) => [
    compositeKey([item.tenant_id, item.app_id, item.subject_ref]), item,
  ]));
}

function acquisitionAttributionRows(attributions: Attribution[]): string[][] {
  return sortByKey(attributions, (item) => [item.tenant_id, item.app_id, item.attribution_id])
    .map((item) => [item.tenant_id, item.app_id, item.attribution_id, sha256(item)]);
}

function importedInstall(attempt: Attempt, provider: string): boolean {
  return attempt.record.event_name === "install" && attempt.record.producer === `import:${provider}`
    && attempt.record.payload.import_context?.provider === provider;
}

function importedAcquisitionAttributions(attributions: Attribution[], included: Attempt[], provider: string, watermark: string) {
  const anchors = included.filter(attempt => importedInstall(attempt, provider));
  return selectedAcquisitionAttributions(attributions.filter(attribution => attribution.method === "imported"
    && attribution.model === "provider_reported" && anchors.some(install =>
      install.server.tenant_id === attribution.tenant_id && install.server.app_id === attribution.app_id
      && install.record.payload.installation_id === attribution.subject_ref
      && attribution.evidence_refs.some(ref => ref.tenant_id === install.server.tenant_id
        && ref.app_id === install.server.app_id && ref.ref === install.record.record_id))), included, watermark);
}

function importedContextRows(included: Attempt[], provider: string): string[][] {
  return sortByKey(included.filter(attempt => importedInstall(attempt, provider)), attempt =>
    [attempt.server.tenant_id, attempt.server.app_id, attempt.record.record_id]).map(attempt =>
    [attempt.server.tenant_id, attempt.server.app_id, attempt.record.record_id, attempt.record.producer,
      sha256(attempt.record.payload.import_context)]);
}

function importedDimensions(install: Attempt, attributions: Map<string, Attribution>) {
  const context = install.record.payload.import_context;
  const attribution = attributions.get(compositeKey([install.server.tenant_id, install.server.app_id,
    install.record.payload.installation_id]));
  return { country: context.provider_country, ...(attribution?.status === "non_organic" ? {
    campaign_id: context.provider_campaign_ref, network: context.provider_network, ad_group_id: context.provider_adgroup_ref,
  } : {}) };
}

function selectedAcquisitionDimensions(
  install: Attempt, visible: Attempt[], attributions: Map<string, Attribution>,
): { campaign_id?: string; network?: string; ad_group_id?: string; creative_id?: string } {
  if (install.record.producer.startsWith("import:")) return {};
  const attribution = attributions.get(compositeKey([
    install.server.tenant_id, install.server.app_id, install.record.payload.installation_id,
  ]));
  if (attribution?.status !== "non_organic" || attribution.method !== "install_referrer"
      || attribution.reason_code !== "valid_install_referrer") return {};
  const clicks = visible.filter((candidate) => candidate.record.event_name === "click"
    && candidate.server.tenant_id === install.server.tenant_id && candidate.server.app_id === install.server.app_id
    && candidate.record.payload.click_id === install.record.payload.click_id
    && attribution.evidence_refs.some((ref) => ref.ref === candidate.record.record_id
      && ref.tenant_id === candidate.server.tenant_id && ref.app_id === candidate.server.app_id));
  if (clicks.length !== 1) return {};
  const payload = clicks[0].record.payload;
  return { campaign_id: payload.campaign_id, network: payload.network, ad_group_id: payload.ad_group_id, creative_id: payload.creative_id };
}

export function metricRuns(
  input: Any,
  all: Attempt[],
  decisions: Decisions,
  lifecycle: Map<string, LifecycleStatus>,
  attributions: Attribution[],
  excludedInstallationIds: ReadonlySet<string> = new Set(),
): MetricRun[] {
  const evaluations = input.metric_evaluations ?? [];
  if (!evaluations.length) return [];
  const fxPolicy = input.fx_policy;
  const definitions = metricDefinitions(input);
  const definitionsByName = new Map(definitions.map((definition) => [definition.metric_name, definition]));
  const cost_records = costRecords(input);
  const attributionStatuses = new Map(attributions
    .filter((attribution) => ["installation_level", "engagement_level"].includes(attribution.subject_scope))
    .map((attribution) => [
      compositeKey([attribution.tenant_id, attribution.app_id, attribution.subject_ref]),
      attribution.status,
    ]));
  const output: MetricRun[] = [];
  for (const evaluation of evaluations) {
    const included = all.filter((attempt) =>
      decisionFor(decisions, attempt).ingestion_status === "accepted" &&
      decisionFor(decisions, attempt).duplicate_resolution === "unique" &&
      compareText(attempt.record.received_at, evaluation.input_received_at_watermark) <= 0,
    );
    const recordSnapshotRows = sortCandidateAttempts(included).map((attempt) => [
      attempt.record.received_at,
      attempt.record.record_id,
      evaluation.privacy_state === "after" ? (lifecycle.get(attemptEvidenceKey(attempt)) ?? "available") : "available",
      attempt.server.policy_digest,
    ]);
    const visible = included.filter((attempt) => evaluation.privacy_state !== "after" || !lifecycle.has(attemptEvidenceKey(attempt)));
    const engagement = engagementInputs(included, attributions, evaluation.input_received_at_watermark);
    const platform = selectPlatformAcquisition(attributions, included, input.platform_acquisition_inputs ?? [], evaluation.input_received_at_watermark);
    const platformStates = [...platform.attributions.values()].flatMap(attribution => {
      const proof = platform.proofs.get(compositeKey([attribution.tenant_id,attribution.app_id,attribution.attribution_id]));
      return proof ? [proof.lifecycle_status] : [];
    });
    const historicalCandidates = new Map(attributions.map(attribution => [compositeKey([attribution.tenant_id, attribution.app_id, attribution.attribution_id]), attribution]));
    for (const proof of platform.proofs.values()) historicalCandidates.set(compositeKey([proof.attribution.tenant_id, proof.attribution.app_id, proof.attribution.attribution_id]), proof.attribution);
    const acquisitionAttributions = selectedAcquisitionAttributions([...historicalCandidates.values()], included, evaluation.input_received_at_watermark);
    const platformStatuses = new Map([...platform.attributions].map(([key, attribution]) => [key, attribution.status]));
    const platformInstalls = visible.filter(attempt => {
      if (attempt.record.event_name !== "install") return false;
      const dimensions = platformAcquisitionDimensions(attempt, platform);
      return dimensions !== undefined && matchesGrouping(attempt, evaluation.grouping, platformStatuses, dimensions, true);
    });
    const acquisitionStatuses = new Map<string, Attribution["status"]>(included
      .filter((attempt) => attempt.record.event_name === "install")
      .map((attempt) => [compositeKey([attempt.server.tenant_id, attempt.server.app_id,
        attempt.record.payload.installation_id]), "unattributed"]));
    for (const [key, attribution] of acquisitionAttributions) acquisitionStatuses.set(key, attribution.status);
    const acquisitionInstalls = visible.filter((attempt) => attempt.record.event_name === "install" && !attempt.record.producer.startsWith("import:") &&
      matchesGrouping(attempt, evaluation.grouping, acquisitionStatuses,
        selectedAcquisitionDimensions(attempt, visible, acquisitionAttributions)));
    const installs = visible.filter((attempt) => attempt.record.event_name === "install" &&
      matchesGrouping(attempt, evaluation.grouping, attributionStatuses));
    const revenue = visible.filter((attempt) => attempt.record.event_name === "ad_revenue" &&
      attempt.record.payload.subject_scope === "installation_level");
    const purchases = visible.filter((attempt) =>
      attempt.record.event_name === "purchase" && attempt.record.payload.financial_status === "settled");
    const refunds = visible.filter((attempt) =>
      attempt.record.event_name === "refund" && attempt.record.payload.financial_status === "settled");
    const activities = visible;
    const affectedStates = evaluation.privacy_state === "after"
      ? included.map((attempt) => lifecycle.get(attemptEvidenceKey(attempt))).filter(Boolean)
      : [];
    const reproducibility_status = affectedStates.includes("redacted")
      ? "redaction_affected"
      : affectedStates.includes("purged") ? "retention_affected" : "fully_reproducible";
    const ledger = recordSnapshotRows.at(-1);
    const recordEvidence: MetricRun["evidence_refs"] = sortCandidateAttempts(included).map((attempt) => ({
      tenant_id: attempt.server.tenant_id,
      app_id: attempt.server.app_id,
      ref: attempt.record.record_id,
      lifecycle_status: evaluation.privacy_state === "after" ? (lifecycle.get(attemptEvidenceKey(attempt)) ?? "available") : "available",
      access_class: "protected",
    }));
    if (fxPolicy.rates.length !== 1) throw new Error("v0.2 metric runs require exactly one structured FX rate");
    const fxRate = fxPolicy.rates[0];
    const selectedNames = evaluation.metric_names ?? [
      "d0_install_to_24h_ad_revenue_usd", "d0_utc_install_calendar_ad_revenue_usd", "d0_jst_install_calendar_ad_revenue_usd",
    ];
    for (const metricName of selectedNames) {
      const definition = definitionsByName.get(metricName);
      if (!definition) throw new Error(`unknown metric definition: ${metricName}`);
      if (definition.acquisition_basis === "selected_verified_platform" && (evaluation.grouping?.campaign_id || evaluation.grouping?.ad_group_id)
          && !evaluation.grouping?.network) throw new Error("platform_acquisition_source_required");
      if (!definition.acquisition_dimension_policy && !(["selected_verified_platform", "selected_imported_provider"].includes(definition.acquisition_basis ?? "") && evaluation.grouping?.creative_id === undefined) && (evaluation.grouping?.ad_group_id !== undefined || evaluation.grouping?.creative_id !== undefined)) {
        throw new Error(`unsupported detail grouping for ${metricName}`);
      }
      const imported = definition.import_provider ? importedAcquisitionAttributions(attributions, included, definition.import_provider, evaluation.input_received_at_watermark) : undefined;
      const importedStatuses = imported ? new Map([...imported].map(([key, item]) => [key, item.status])) : undefined;
      if (importedStatuses) for (const install of included.filter(attempt => importedInstall(attempt, definition.import_provider!))) {
        const key = compositeKey([install.server.tenant_id, install.server.app_id, install.record.payload.installation_id]);
        if (!importedStatuses.has(key)) importedStatuses.set(key, "unattributed");
      }
      const selectedInstalls = imported ? visible.filter(install => importedInstall(install, definition.import_provider!)
        && matchesGrouping(install, evaluation.grouping, importedStatuses!, importedDimensions(install, imported), true, true)
        && (definition.fraud_policy !== "net" || imported.get(compositeKey([install.server.tenant_id, install.server.app_id,
          install.record.payload.installation_id]))?.reason_code !== "fraud_excluded"))
        : definition.acquisition_basis === "selected_verified_platform" ? platformInstalls.filter(install => definition.fraud_policy !== "net"
        || platform.attributions.get(compositeKey([install.server.tenant_id, install.server.app_id, install.record.payload.installation_id]))?.reason_code !== "fraud_excluded")
        : definition.acquisition_basis ? acquisitionInstalls : installs;
      const selectedDaily = definition.rule_bundle_id === "metric-selected-daily-acquisition";
      if (selectedDaily && evaluation.grouping?.acquisition_campaign_state !== undefined &&
          !["known", "unknown"].includes(evaluation.grouping.acquisition_campaign_state)) {
        throw new Error("daily_acquisition_campaign_state_invalid");
      }
      if (!selectedDaily && evaluation.grouping?.acquisition_campaign_state !== undefined) {
        throw new Error(`unsupported acquisition campaign state for ${metricName}`);
      }
    const cohortScopes = new Set(selectedInstalls.map((install) => compositeKey([install.server.tenant_id, install.server.app_id])));
    const groupedCosts = cost_records.filter((cost) => {
      if (definition.engagement_credit_policy || selectedDaily) return false;
      const grouping = evaluation.grouping;
      if (cost.creative_id !== undefined && !definition.acquisition_dimension_policy) return false;
      if (grouping?.attribution_status !== undefined && grouping.attribution_status !== "non_organic") return false;
      if (compareText(cost.as_of, evaluation.input_received_at_watermark) > 0) return false;
      if (cohortScopes.size && !cohortScopes.has(compositeKey([cost.tenant_id, cost.app_id]))) return false;
      if (!grouping) return true;
      return ["campaign_id", "ad_group_id", "creative_id", "network", "country"].every((field) => grouping[field] === undefined || cost[field] === grouping[field]) &&
        (grouping.cohort_date === undefined || cost.date === grouping.cohort_date);
    });
    const disjoint = definition.cost_selection_policy || definition.acquisition_dimension_policy
      ? selectDisjointCosts(groupedCosts, !!definition.acquisition_dimension_policy) : undefined;
    const currentCosts = disjoint?.rows ?? [...new Map(groupedCosts
      .sort((a, b) => compareText(a.as_of, b.as_of) || compareText(a.cost_record_id, b.cost_record_id))
      .map((cost) => [compositeKey([cost.tenant_id, cost.app_id, cost.dimension_digest]), cost])).values()];
    const costSnapshotRows = sortByKey(currentCosts, (cost) => [cost.as_of, cost.cost_record_id]).map((cost) => [
      "cost", cost.as_of, cost.cost_record_id, cost.report_snapshot_digest, cost.dimension_digest,
    ]);
    const snapshotRows = [...recordSnapshotRows, ...costSnapshotRows];
    const costEvidence: MetricRun["evidence_refs"] = currentCosts.map((cost) => ({
      tenant_id: cost.tenant_id,
      app_id: cost.app_id,
      ref: cost.cost_record_id,
      lifecycle_status: "available",
      access_class: "protected",
    }));
    const evidence_refs = sortByKey([...recordEvidence, ...costEvidence], (evidence) => [evidence.ref, evidence.tenant_id, evidence.app_id]);
      if (evaluation.grouping && definition.grouping_dimensions) {
        const groupingDimensions = new Set<string>(definition.grouping_dimensions);
        const unsupported = Object.keys(evaluation.grouping)
          .filter((dimension) => !groupingDimensions.has(dimension));
        if (unsupported.length) throw new Error(`unsupported grouping for ${metricName}: ${unsupported.join(",")}`);
      }
      const eligibleInstalls = definition.fraud_policy === "net"
        ? selectedInstalls.filter((candidate) => !excludedInstallationIds.has(candidate.record.payload.installation_id))
        : selectedInstalls;
      const revenueValue = definition.engagement_credit_policy || definition.conversion_event_key !== undefined ? 0n : revenue.reduce((sum, item) => {
        if (definition.import_provider && item.record.producer !== `import:${definition.import_provider}`) return sum;
        const installation = eligibleInstalls.find((candidate) =>
          candidate.server.tenant_id === item.server.tenant_id && candidate.server.app_id === item.server.app_id &&
          candidate.record.payload.installation_id === item.record.payload.installation_id,
        );
        return installation && eligibleRevenue(definition, installation.record, item.record)
          ? sum + convertMoney(item.record.payload, fxPolicy)
          : sum;
      }, 0n);
      const includesPurchaseNet = ["purchase_net_revenue", "total_net_revenue"].includes(
        definition.definition.numerator,
      );
      const purchaseNetRevenueValue = includesPurchaseNet
        ? purchases.reduce((sum, item) => {
        const installation = eligibleInstalls.find((candidate) =>
          candidate.server.tenant_id === item.server.tenant_id && candidate.server.app_id === item.server.app_id &&
          candidate.record.payload.installation_id === item.record.payload.installation_id,
        );
        return installation && eligibleRevenue(definition, installation.record, item.record)
          ? sum + convertMoney(item.record.payload, fxPolicy)
          : sum;
      }, 0n) - refunds.reduce((sum, item) => {
        const target = resolveRefundTarget(item, visible);
        if (!target || target.record.payload.financial_status !== "settled") return sum;
        if (definition.refund_reversal_policy && visible.some((reversal) =>
          reversal.record.event_name === "refund" && reversal.record.payload.financial_status === "reversed"
          && reversal.server.tenant_id === item.server.tenant_id && reversal.server.app_id === item.server.app_id
          && reversal.record.payload.reverses_refund_record_id === item.record.record_id)) return sum;
        const installation = eligibleInstalls.find((candidate) =>
          candidate.server.tenant_id === target.server.tenant_id && candidate.server.app_id === target.server.app_id &&
          candidate.record.payload.installation_id === target.record.payload.installation_id,
        );
        return installation && eligibleRevenue(definition, installation.record, item.record)
          ? sum + convertMoney(item.record.payload, fxPolicy)
          : sum;
      }, 0n)
        : 0n;
      const selectedRevenueValue = definition.definition.numerator === "purchase_net_revenue"
        ? purchaseNetRevenueValue
        : definition.definition.numerator === "total_net_revenue"
          ? revenueValue + purchaseNetRevenueValue
          : revenueValue;
      const cohortSize = BigInt(new Set(eligibleInstalls.map((install) => install.record.payload.installation_id)).size);
      let value: bigint | undefined;
      let undefined_reason: "no_attributed_cost" | "no_activity_events" | "empty_cohort" | "overlapping_cost_grains" | undefined;
      if (definition.engagement_credit_policy) {
        if (definition.value_type === "money" && (fxPolicy.target_currency !== definition.currency || fxPolicy.target_scale !== definition.amount_scale)) {
          throw new Error("engagement_metric_fx_target_mismatch");
        }
        value = engagementValue({ opens: engagement, visible, definition, grouping: evaluation.grouping,
          available: attempt => evaluation.privacy_state !== "after" || !lifecycle.has(attemptEvidenceKey(attempt as Attempt)),
          money: payload => convertMoney(payload, fxPolicy) });
        if (value === undefined) undefined_reason = "empty_cohort";
      } else if (definition.definition.calculation === "revenue_sum") {
        value = selectedRevenueValue;
      } else if (definition.definition.calculation === "revenue_over_cost") {
        const cost = currentCosts.reduce((sum, item) => {
          if (item.currency !== fxPolicy.target_currency) throw new Error(`cost currency mismatch: ${item.cost_record_id}`);
          return sum + scaleMoney(item, fxPolicy.target_scale);
        }, 0n);
        if (disjoint?.overlapping) {
          undefined_reason = "overlapping_cost_grains";
        } else if (cost === 0n) {
          undefined_reason = "no_attributed_cost";
        } else {
          value = roundHalfEven(selectedRevenueValue * (10n ** BigInt(definition.ratio_scale ?? 6)), cost);
        }
      } else if (["converted_installations", "converted_installations_over_cohort"].includes(definition.definition.calculation)) {
        if (cohortSize === 0n) {
          undefined_reason = "empty_cohort";
        } else {
          const converted = new Set<string>();
          for (const event of visible.filter((item) => item.record.event_name === "custom_event"
              && item.record.payload.event_key === definition.conversion_event_key)) {
            const installation = eligibleInstalls.find((candidate) => candidate.server.tenant_id === event.server.tenant_id
              && candidate.server.app_id === event.server.app_id
              && candidate.record.payload.installation_id === event.record.payload.installation_id);
            if (installation && eligibleRevenue(definition, installation.record, event.record)) {
              converted.add(installation.record.payload.installation_id);
            }
          }
          value = definition.definition.calculation === "converted_installations" ? BigInt(converted.size)
            : roundHalfEven(BigInt(converted.size) * 1_000_000n, cohortSize);
        }
      } else if (definition.definition.calculation === "active_installations_over_cohort") {
        if (cohortSize === 0n) {
          undefined_reason = "empty_cohort";
        } else {
          const activityEvents = new Set(definition.activity_events ?? ["session_start"]);
          const active = new Set<string>();
          for (const session of activities.filter((item) => activityEvents.has(item.record.event_name))) {
            if (definition.import_provider && session.record.producer !== `import:${definition.import_provider}`) continue;
            const installation = eligibleInstalls.find((candidate) =>
              candidate.server.tenant_id === session.server.tenant_id && candidate.server.app_id === session.server.app_id &&
              candidate.record.payload.installation_id === session.record.payload.installation_id,
            );
            if (!installation) continue;
            const dayIndex = Math.floor((time(session.record.occurred_at, "occurred_at") - time(installation.record.occurred_at, "occurred_at")) / DAY_MS);
            if (dayIndex === definition.definition.window.day) active.add(installation.record.payload.installation_id);
          }
          value = roundHalfEven(BigInt(active.size) * (10n ** BigInt(definition.ratio_scale ?? 6)), cohortSize);
        }
      } else if (definition.definition.calculation === "revenue_over_cohort") {
        if (cohortSize === 0n) {
          undefined_reason = "empty_cohort";
        } else {
          value = roundHalfEven(selectedRevenueValue, cohortSize);
        }
      } else if (definition.definition.calculation === "cohort_size") {
        value = cohortSize;
      } else if (definition.definition.calculation === "event_count") {
        const eventNames = new Set<string>(definition.event_names ?? []);
        const eventName = [...eventNames][0];
        const metricDate = evaluation.grouping?.metric_date;
        if (metricDate === undefined) throw new Error(`event_count requires metric_date grouping: ${metricName}`);
        if (eventNames.size !== 1 || !["click", "install", "deep_link_open", "skan_postback", "adattributionkit_postback"].includes(eventName)) {
          throw new Error(`event_count requires exactly one supported event name: ${metricName}`);
        }
        const aggregatePostback = eventName === "skan_postback" || eventName === "adattributionkit_postback";
        if (selectedDaily) {
          value = BigInt(eligibleInstalls.filter((attempt) => {
            if (attempt.record.producer.startsWith("import:") ||
                dateAt(attempt.record.occurred_at, "UTC", "occurred_at") !== metricDate) return false;
            const campaign = selectedAcquisitionDimensions(attempt, visible, acquisitionAttributions).campaign_id;
            const state = campaign === undefined ? "unknown" : "known";
            return evaluation.grouping?.acquisition_campaign_state === undefined ||
              evaluation.grouping.acquisition_campaign_state === state;
          }).length);
        } else if (aggregatePostback) {
          if (definition.aggregation_time_zone !== "UTC") {
            throw new Error(`aggregate event_count requires UTC aggregation: ${metricName}`);
          }
          if (evaluation.grouping?.attribution_status !== undefined) {
            throw new Error(`aggregate event_count forbids attribution_status: ${metricName}`);
          }
          const expectedEventName = metricName.startsWith("aak_attributed_")
            ? "adattributionkit_postback"
            : "skan_postback";
          if (!["skan_attributed_installs", "skan_conversion_value_distribution", "aak_attributed_installs", "aak_attributed_reengagements"].includes(metricName) || eventName !== expectedEventName) {
            throw new Error(`aggregate event_count metric and event mismatch: ${metricName}`);
          }
          const conversionBucket = evaluation.grouping?.apple_conversion_bucket;
          if (metricName === "skan_conversion_value_distribution" && conversionBucket === undefined) {
            throw new Error(`SKAN conversion distribution requires apple_conversion_bucket: ${metricName}`);
          }
          if (metricName !== "skan_conversion_value_distribution" && conversionBucket !== undefined) {
            throw new Error(`apple_conversion_bucket is reserved for SKAN conversion distribution: ${metricName}`);
          }
          value = BigInt(visible.filter((attempt) => {
            if (attempt.record.event_name !== eventName ||
                dateAt(attempt.record.received_at, "UTC", "received_at") !== metricDate) return false;
            if (metricName === "aak_attributed_installs" &&
                !["download", "redownload"].includes(attempt.record.payload.conversion_type)) return false;
            if (metricName === "aak_attributed_reengagements" &&
                attempt.record.payload.conversion_type !== "re-engagement") return false;
            const attribution = attributions.find((candidate) =>
              candidate.tenant_id === attempt.server.tenant_id &&
              candidate.app_id === attempt.server.app_id &&
              candidate.subject_scope === "aggregate" &&
              candidate.status === "non_organic" &&
              candidate.evidence_refs.some((reference) => reference.ref === attempt.record.record_id));
            if (!attribution) return false;
            if (conversionBucket === undefined) return true;
            const payload = attempt.record.payload;
            const actualBucket = payload.conversion_value !== undefined
              ? `fine:${payload.conversion_value}`
              : payload.coarse_conversion_value !== undefined
                ? `coarse:${payload.coarse_conversion_value}`
                : undefined;
            return actualBucket === conversionBucket;
          }).length);
        } else {
          if (evaluation.grouping?.apple_conversion_bucket !== undefined) {
            throw new Error(`apple_conversion_bucket requires aggregate SKAN events: ${metricName}`);
          }
          if (evaluation.grouping?.attribution_status !== undefined && !["install", "deep_link_open"].includes(eventName)) {
            throw new Error(`attribution_status event_count requires install or deep_link_open events: ${metricName}`);
          }
          value = BigInt(visible.filter((attempt) =>
            eventNames.has(attempt.record.event_name) &&
            (definition.fraud_policy !== "net" || attempt.record.event_name !== "install" ||
              !excludedInstallationIds.has(attempt.record.payload.installation_id)) &&
            matchesGrouping(attempt, evaluation.grouping, attributionStatuses) &&
            dateAt(attempt.record.occurred_at, definition.aggregation_time_zone, "occurred_at") === metricDate,
          ).length);
        }
      } else {
        throw new Error(`unsupported metric calculation: ${definition.definition.calculation}`);
      }
      if (!definition.engagement_credit_policy && definition.definition.calculation !== "event_count" && evaluation.grouping?.metric_date !== undefined) {
        throw new Error(`metric_date grouping is reserved for event_count: ${metricName}`);
      }
      const grouping = evaluation.grouping ? {
        dimensions: evaluation.grouping,
        dimension_digest: sha256(evaluation.grouping),
      } : undefined;
      const moneyFields = definition.value_type === "money" && value !== undefined ? {
        fx_rate_unscaled: fxRate.rate_unscaled,
        fx_rate_scale: fxRate.rate_scale,
        fx_rate_source: fxRate.source,
        fx_rate_as_of: fxRate.as_of,
        fx_rate_snapshot_id: sha256(fxPolicy.rates),
        fx_policy_version: fxPolicy.policy_version,
        amount_scale: definition.amount_scale,
        currency: definition.currency,
      } : {};
      output.push({
        metric_run_id: `${evaluation.metric_run_id_prefix}:${metricName}`,
        metric_name: metricName,
        metric_definition_version: definition.metric_definition_version,
        input_snapshot_id: definition.engagement_credit_policy ? sha256({
          record_snapshot_id: sha256(snapshotRows), engagement_inputs: engagementSnapshotRows(engagement, sha256),
        }) : imported ? sha256({
          record_and_cost_snapshot_id: sha256(snapshotRows), acquisition_attributions: acquisitionAttributionRows([...imported.values()]),
          imported_acquisition_contexts: importedContextRows(included, definition.import_provider!),
        }) : definition.acquisition_basis === "selected_verified_platform" ? sha256({
          record_and_cost_snapshot_id: sha256(snapshotRows),
          acquisition_attributions: acquisitionAttributionRows([...platform.attributions.values()]),
          platform_acquisition_inputs: selectedPlatformProofRows(platform, sha256),
        }) : definition.acquisition_basis ? sha256({
          record_and_cost_snapshot_id: sha256(snapshotRows),
          acquisition_attributions: acquisitionAttributionRows([...acquisitionAttributions.values()]),
        }) : sha256(snapshotRows),
        input_received_at_watermark: evaluation.input_received_at_watermark,
        input_ledger_position: ledger ? `${ledger[0]}|${ledger[1]}` : "empty",
        computed_at: evaluation.computed_at,
        data_freshness: evaluation.data_freshness,
        aggregation_time_zone: definition.aggregation_time_zone,
        rule_bundle_id: definition.rule_bundle_id,
        rule_bundle_version: definition.rule_bundle_version,
        rule_bundle_hash: definition.rule_bundle_hash,
        rounding_mode: fxPolicy.rounding_mode,
        reproducibility_status: definition.acquisition_basis !== "selected_verified_platform" ? reproducibility_status
          : reproducibility_status === "redaction_affected" || platformStates.includes("redacted") ? "redaction_affected"
          : reproducibility_status === "retention_affected" || platformStates.includes("purged") ? "retention_affected" : "fully_reproducible",
        value_type: definition.value_type,
        ...(definition.fraud_policy ? { fraud_policy: definition.fraud_policy } : {}),
        ...(value === undefined
          ? { value_state: "undefined" as const, undefined_reason }
          : { value_unscaled: value.toString() }),
        ...moneyFields,
        ...(definition.value_type === "ratio" ? { ratio_scale: definition.ratio_scale } : {}),
        ...(grouping ? { grouping } : {}),
        evidence_refs,
        ...(evaluation.supersedes_metric_run_id_prefix ? {
          supersedes_metric_run_id: `${evaluation.supersedes_metric_run_id_prefix}:${metricName}`,
        } : {}),
      });
    }
  }
  return sortByKey(output, (run) => [run.metric_run_id]);
}

function scaleMoney(payload: Any, targetScale: number): bigint {
  const difference = targetScale - Number(payload.amount_scale);
  if (difference >= 0) return BigInt(payload.amount_unscaled) * (10n ** BigInt(difference));
  return roundHalfEven(BigInt(payload.amount_unscaled), 10n ** BigInt(-difference));
}

function matchesGrouping(
  attempt: Attempt,
  grouping: Any,
  attributionStatuses: Map<string, Attribution["status"]>,
  acquisition?: { campaign_id?: string; network?: string; ad_group_id?: string; creative_id?: string; country?: string },
  authoritativeAcquisition = false,
  authoritativeCountry = false,
): boolean {
  if (!grouping) return true;
  const payload = attempt.record.payload;
  const campaign = authoritativeAcquisition ? acquisition?.campaign_id : payload.campaign_id ?? attempt.server.deep_link_resolution?.campaign_id ?? payload.import_context?.provider_campaign_ref ?? acquisition?.campaign_id;
  const network = authoritativeAcquisition ? acquisition?.network : payload.network ?? payload.ad_network ?? payload.import_context?.provider_network ?? acquisition?.network;
  const country = authoritativeCountry ? acquisition?.country : payload.country ?? payload.import_context?.provider_country;
  if (grouping.campaign_id !== undefined && campaign !== grouping.campaign_id) return false;
  if (grouping.network !== undefined && network !== grouping.network) return false;
  for (const field of ["ad_group_id", "creative_id"] as const) {
    if (grouping[field] !== undefined && acquisition?.[field] !== grouping[field]) return false;
  }
  if (grouping.country !== undefined && country !== grouping.country) return false;
  if (grouping.cohort_date !== undefined && attempt.record.event_name === "install" &&
      dateAt(attempt.record.occurred_at, "UTC", "occurred_at") !== grouping.cohort_date) return false;
  if (grouping.attribution_status !== undefined && ["install", "deep_link_open"].includes(attempt.record.event_name)) {
    const subjectRef = attempt.record.event_name === "install"
      ? attempt.record.payload.installation_id
      : `engagement:${attempt.record.record_id}`;
    const status = attributionStatuses.get(compositeKey([
      attempt.server.tenant_id,
      attempt.server.app_id,
      subjectRef,
    ]));
    if (status !== grouping.attribution_status) return false;
  }
  return true;
}

function eligibleRevenue(definition: MetricDefinition, install: Any, revenue: Any): boolean {
  const dayIndex = definition.definition.window.day;
  if (definition.definition.window.type === "calendar_day") {
    return dateAt(revenue.occurred_at, definition.aggregation_time_zone, "occurred_at") ===
      dateAt(new Date(time(install.occurred_at, "occurred_at") + dayIndex * DAY_MS).toISOString(), definition.aggregation_time_zone, "occurred_at");
  }
  const elapsed = time(revenue.occurred_at, "occurred_at") - time(install.occurred_at, "occurred_at");
  return elapsed >= 0 && elapsed < (dayIndex + 1) * DAY_MS;
}
