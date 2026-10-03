import type { Pool, PoolClient } from "pg";
import { compareCandidateAttempts, evaluate, IndexedCandidateProvider, sortCandidateAttempts, type CandidateAttempt } from "@openmasu/attribution-core";
import { clickInjectionPolicyDigest, fraudNumberParameter } from "@openmasu/fraud-rules";
import { withTenant } from "@openmasu/runtime";
import { resolveActiveFraudBundle, serverBundleContext } from "../fraud-bundle-runtime.js";
import { assertNonFraudArtifactBinding, nonFraudServerContext, resolveNonFraudBundle, type BoundNonFraudBundle } from "../non-fraud-bundle-runtime.js";
import { inputAttempts, defaultTimestamp, policyDigestForRecord, refundProjectionTargets } from "./input.js";
import { persistRawWithClient, persistDeliveryWithClient, persistLogicalWithClient, persistCorrectionWithClient, persistRejectionWithClient } from "./record-repository.js";
import { persistProjectionWithClient } from "./fact-projections.js";
import { type Any, type RuntimeIngestionResult } from "./model.js";
import { schemaInvalidArtifacts, runtimeInput } from "./admission.js";
import { resolveDeepLinkAttempts, ineligibleHistoricalPurchaseTargetIds } from "./candidate-queries.js";
import { persistAttributionWithClient, persistFraudWithClient, persistReconciliationWithClient } from "./derived-repository.js";
import { prepareRuntimeBulk, persistPreparedRuntimeBulkWithClient } from "./bulk-repository.js";

export async function ensureApps(appPool: Pool, input: Any): Promise<void> {
  const values = inputAttempts(input).map(({ server }) => [server.tenant_id, server.app_id] as const);
  const unique = new Map(values.map(([tenantId, appId]) => [`${tenantId}\u0000${appId}`, [tenantId, appId] as const]));
  for (const [tenantId, appId] of unique.values()) {
    await withTenant(appPool, tenantId, async (client) => {
      await client.query(
        `INSERT INTO control.apps (tenant_id, app_id, created_at)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id, app_id) DO NOTHING`,
        [tenantId, appId, defaultTimestamp(input)],
      );
    });
  }
}

export async function persistCorrection(appPool: Pool, artifact: Any): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistCorrectionWithClient(client, artifact));
}

export async function persistAttribution(
  appPool: Pool,
  artifact: Any,
  expectedBinding?: BoundNonFraudBundle,
): Promise<Any> {
  if (expectedBinding) assertNonFraudArtifactBinding(artifact, expectedBinding);
  return withTenant(appPool, artifact.tenant_id, (client) => persistAttributionWithClient(client, artifact));
}

export async function persistFraud(
  appPool: Pool,
  artifact: Any,
  scope: { tenant_id: string; app_id: string },
  expectedRevisionId?: string,
): Promise<Any> {
  return withTenant(appPool, scope.tenant_id, (client) => persistFraudWithClient(client, artifact, scope, expectedRevisionId));
}

export async function persistReconciliation(appPool: Pool, artifact: Any): Promise<Any> {
  return withTenant(appPool, artifact.tenant_id, (client) => persistReconciliationWithClient(client, artifact));
}

export async function persistRuntimeBulk(
  appPool: Pool,
  attempts: readonly CandidateAttempt[],
  selected: RuntimeIngestionResult,
  input: Any,
  activeRevision: Awaited<ReturnType<typeof resolveActiveFraudBundle>>,
  nonFraudBindings: ReadonlyMap<string, BoundNonFraudBundle>,
  acceptedLogicals: readonly Any[],
): Promise<void> {
  const prepared = prepareRuntimeBulk(attempts, selected, input, activeRevision, nonFraudBindings, acceptedLogicals);
  await withTenant(appPool, prepared.tenantId, (client) => persistPreparedRuntimeBulkWithClient(client, prepared));
}

/**
 * Persist a production import batch through the same evaluator and ledger writers used by
 * golden parity. Historical import attempts participate in candidate selection so retries are
 * classified deterministically, while only the current deliveries are appended.
 */
export async function ingestRuntimeBatch(
  attempts: readonly CandidateAttempt[],
  appPool: Pool,
  historicalAttempts: readonly CandidateAttempt[] = [],
  options: { bulkPersistence?: boolean; persistenceClient?: PoolClient } = {},
): Promise<RuntimeIngestionResult> {
  if (attempts.length === 0) {
    return { raw_records: [], deliveries: [], logical_events: [], corrections: [], rejections: [], attributions: [], fraud_decisions: [], reconciliation: [], validation_failures: [] };
  }
  const scopes = [...new Set(attempts.map((attempt) =>
    `${attempt.server.tenant_id}\u0000${attempt.server.app_id}`))];
  if (options.persistenceClient && scopes.length !== 1) {
    throw new Error("runtime_transaction_requires_one_scope");
  }
  if (scopes.length > 1) {
    const combined: RuntimeIngestionResult = {
      raw_records: [], deliveries: [], logical_events: [], corrections: [], rejections: [], attributions: [],
      fraud_decisions: [], reconciliation: [], validation_failures: [],
    };
    for (const scope of scopes.sort()) {
      const [tenantId, appId] = scope.split("\u0000");
      const scopedAttempts = attempts.filter((attempt) =>
        attempt.server.tenant_id === tenantId && attempt.server.app_id === appId);
      const scopedHistory = historicalAttempts.filter((attempt) =>
        attempt.server.tenant_id === tenantId && attempt.server.app_id === appId);
      const result = await ingestRuntimeBatch(scopedAttempts, appPool, scopedHistory, options);
      for (const key of Object.keys(combined) as Array<keyof RuntimeIngestionResult>) {
        (combined[key] as Any[]).push(...result[key]);
      }
    }
    return combined;
  }
  if (options.persistenceClient) {
    const [scopeTenantId, scopeAppId] = scopes[0].split("\u0000");
    await options.persistenceClient.query(
      `INSERT INTO control.apps (tenant_id, app_id, created_at)
       VALUES ($1, $2, $3) ON CONFLICT (tenant_id, app_id) DO NOTHING`,
      [scopeTenantId, scopeAppId, defaultTimestamp(runtimeInput(attempts))],
    );
  } else {
    await ensureApps(appPool, runtimeInput(attempts));
  }
  const [tenantId, appId] = scopes[0].split("\u0000");
  const activeRevision = await resolveActiveFraudBundle(appPool, tenantId, appId);
  const attributionBinding = await resolveNonFraudBundle(appPool, tenantId, appId, "attribution-default");
  const applePostbackBinding = await resolveNonFraudBundle(appPool, tenantId, appId, "apple-postback-default");
  const nonFraudBindings = new Map<string, BoundNonFraudBundle>([
    [attributionBinding.ruleBundleId, attributionBinding],
    [applePostbackBinding.ruleBundleId, applePostbackBinding],
  ]);
  const bind = (attempt: CandidateAttempt): CandidateAttempt => {
    const enabled = attempt.server.fraud_enabled !== false && activeRevision !== undefined;
    const nonFraudRuleBundles = {
      "attribution-default": nonFraudServerContext(attributionBinding),
      "apple-postback-default": nonFraudServerContext(applePostbackBinding),
    };
    if (!enabled) return { ...attempt, server: {
      ...attempt.server, fraud_enabled: false, non_fraud_rule_bundles: nonFraudRuleBundles,
    } };
    const thresholdSeconds = fraudNumberParameter(activeRevision.definition, "ctit_lower_bound_seconds", 10);
    const policy = {
      threshold_seconds: thresholdSeconds,
      authority: "server" as const,
      policy_version: `${activeRevision.ruleBundleId}:${activeRevision.ruleBundleVersion}`,
    };
    return {
      ...attempt,
      server: {
        ...attempt.server,
        non_fraud_rule_bundles: nonFraudRuleBundles,
        fraud_enabled: true,
        fraud_rule_bundle: serverBundleContext(activeRevision),
        click_injection_policy: { ...policy, policy_digest: clickInjectionPolicyDigest(policy) },
      },
    };
  };
  const boundAttempts = attempts.map(bind);
  const boundHistory = historicalAttempts.map(bind);
  const invalid = boundAttempts.map(schemaInvalidArtifacts).filter((value): value is NonNullable<typeof value> => value !== undefined);
  const invalidAttempts = new Set(invalid.map(({ failure }) => `${failure.record_id}\u0000${failure.delivery_id}`));
  const validAttempts = boundAttempts.filter((attempt) => !invalidAttempts.has(`${attempt.record.record_id}\u0000${attempt.record.delivery_id}`));
  // Historical runtime candidates are reconstructed from accepted ledger rows.
  // They have already passed contract validation and must not require protected
  // payload access merely to process a new delivery.
  const currentAttempts = sortCandidateAttempts(await resolveDeepLinkAttempts(appPool, validAttempts));
  // Non-SDK importers still supply fully decoded historical attempts. Keep
  // those in the evaluator input until their own ledger-backed projection is
  // introduced; SDK history is explicitly marked and remains provider-only.
  const decodedHistory = boundHistory.filter((attempt) => attempt.history_state === undefined);
  const ineligiblePurchaseTargets = await ineligibleHistoricalPurchaseTargetIds(appPool, decodedHistory, options.persistenceClient);
  const applyPurchaseEligibility = (attempt: CandidateAttempt): CandidateAttempt =>
    ineligiblePurchaseTargets.length === 0 ? attempt : {
      ...attempt,
      server: {
        ...attempt.server,
        refund_target_ineligible_record_ids: ineligiblePurchaseTargets,
      },
    };
  const evaluationHistory = boundHistory.map(applyPurchaseEligibility);
  const evaluationCurrent = currentAttempts.map(applyPurchaseEligibility);
  const providerAttempts = sortCandidateAttempts([...evaluationHistory, ...evaluationCurrent]);
  const input = runtimeInput([
    ...evaluationHistory.filter((attempt) => attempt.history_state === undefined),
    ...evaluationCurrent,
  ]);
  const output = evaluate(input, () => new IndexedCandidateProvider(providerAttempts));
  const recordIds = new Set(validAttempts.map((attempt) => attempt.record.record_id));
  const deliveryIds = new Set(validAttempts.map((attempt) => attempt.record.delivery_id));
  const refundCorrectionIds = new Set(validAttempts
    .filter((attempt) => attempt.record.event_name === "refund")
    .map((attempt) => `correction:${attempt.record.record_id}`));
  const belongsToCurrent = (artifact: Any): boolean =>
    recordIds.has(artifact.record_id)
    || recordIds.has(artifact.subject_ref)
    || deliveryIds.has(artifact.delivery_id)
    || (artifact.evidence_refs ?? []).some((ref: Any) => recordIds.has(ref.record_id ?? ref.ref));

  const selected: RuntimeIngestionResult = {
    raw_records: output.raw_records.filter(belongsToCurrent),
    deliveries: [...output.deliveries.filter(belongsToCurrent), ...invalid.map(({ delivery }) => delivery)],
    logical_events: output.logical_events.filter(belongsToCurrent),
    corrections: output.corrections.filter((artifact: Any) =>
      refundCorrectionIds.has(artifact.correction_id) || belongsToCurrent(artifact)),
    rejections: [...output.rejections.filter(belongsToCurrent), ...invalid.map(({ rejection }) => rejection)],
    attributions: output.attributions.filter(belongsToCurrent),
    fraud_decisions: output.fraud_decisions.filter(belongsToCurrent),
    reconciliation: (output.reconciliation ?? []).filter((artifact: Any) =>
      artifact.tenant_id === attempts[0].server.tenant_id && artifact.app_id === attempts[0].server.app_id),
    validation_failures: invalid.map(({ failure }) => failure),
  };
  if (options.persistenceClient && (
    selected.attributions.length > 0
    || selected.fraud_decisions.length > 0
    || selected.reconciliation.length > 0
  )) {
    throw new Error("runtime_transaction_auxiliary_artifacts_unsupported");
  }
  if (options.bulkPersistence) {
    if (options.persistenceClient) throw new Error("runtime_transaction_bulk_persistence_unsupported");
    await persistRuntimeBulk(appPool, attempts, selected, input, activeRevision, nonFraudBindings, output.logical_events);
    return selected;
  }
  const rawByRecord = new Map(selected.raw_records.map((artifact) => [artifact.record_id, artifact]));
  const deliveryByRecord = new Map(selected.deliveries.map((artifact) => [`${artifact.record_id}\u0000${artifact.delivery_id}`, artifact]));
  const logicalByRecord = new Map(selected.logical_events.map((artifact) => [artifact.record_id, artifact]));
  const refundTargets = refundProjectionTargets(
    selected.logical_events,
    input,
    selected.corrections,
    output.logical_events,
  );
  const rejectionByRecord = new Map(selected.rejections.map((artifact) => [`${artifact.record_id}\u0000${artifact.delivery_id}`, artifact]));
  const persistenceAttempts = [...attempts].sort((left, right) => {
    const priority = (attempt: CandidateAttempt) =>
      attempt.record.event_name === "purchase" ? 0 : attempt.record.event_name === "refund" ? 2 : 1;
    return priority(left) - priority(right) || compareCandidateAttempts(left, right);
  });
  for (const attempt of persistenceAttempts) {
    const raw = rawByRecord.get(attempt.record.record_id);
    const delivery = deliveryByRecord.get(`${attempt.record.record_id}\u0000${attempt.record.delivery_id}`);
    const logical = logicalByRecord.get(attempt.record.record_id);
    const rejection = rejectionByRecord.get(`${attempt.record.record_id}\u0000${attempt.record.delivery_id}`);
    const persistAttempt = async (client: PoolClient): Promise<void> => {
      if (raw) {
        await persistRawWithClient(client, raw, policyDigestForRecord(input, raw.record_id));
        await client.query(
          `INSERT INTO ledger.raw_payload_states (
            tenant_id, app_id, record_id, lifecycle_status, changed_at
          ) VALUES ($1,$2,$3,'available',$4)
          ON CONFLICT (record_id, lifecycle_status) DO NOTHING`,
          [raw.tenant_id, raw.app_id, raw.record_id, raw.received_at],
        );
      }
      if (delivery) await persistDeliveryWithClient(client, delivery);
      if (logical) {
        await persistLogicalWithClient(client, logical);
        await persistProjectionWithClient(client, logical, input, refundTargets);
      }
      if (rejection) await persistRejectionWithClient(client, rejection);
    };
    if (options.persistenceClient) await persistAttempt(options.persistenceClient);
    else await withTenant(appPool, attempt.server.tenant_id, persistAttempt);
  }
  if (options.persistenceClient) {
    for (const correction of selected.corrections) {
      await persistCorrectionWithClient(options.persistenceClient, correction);
    }
    return selected;
  }
  for (const attribution of selected.attributions) {
    const binding = nonFraudBindings.get(attribution.rule_bundle_id);
    if (!binding) throw new Error("non_fraud_rule_bundle_binding_missing");
    await persistAttribution(appPool, attribution, binding);
  }
  for (const correction of selected.corrections) await persistCorrection(appPool, correction);
  for (const fraud of selected.fraud_decisions) {
    const matchingScopes = attempts.filter((attempt) => {
      const payload = attempt.record.payload ?? {};
      return [attempt.record.record_id, attempt.record.event_id, payload.installation_id, payload.click_id]
        .includes(fraud.subject_ref)
        || (fraud.evidence ?? []).some((evidence: Any) =>
          [attempt.record.record_id, attempt.record.event_id].includes(evidence.record_id ?? evidence.ref));
    }).map((attempt) => ({ tenant_id: attempt.server.tenant_id, app_id: attempt.server.app_id }));
    const uniqueScopes = [...new Map(matchingScopes.map((scope) => [
      `${scope.tenant_id}\u0000${scope.app_id}`, scope,
    ])).values()];
    if (uniqueScopes.length !== 1) throw new Error(`fraud_scope_ambiguous:${fraud.fraud_decision_id}`);
    await persistFraud(appPool, fraud, uniqueScopes[0], activeRevision?.ruleBundleRevisionId);
  }
  for (const reconciliation of selected.reconciliation) await persistReconciliation(appPool, reconciliation);
  return selected;
}
