import { M1B_METRIC_DEFINITIONS, REFERENCE_AD_REVENUE_METRIC_DEFINITIONS } from "@openmasu/contracts/definitions";
import { assertMetricDefinitionSeries } from "@openmasu/contracts/validation";
import type { MetricCalculationInput, MetricDefinition, MetricScope, PreparedMetricCalculation } from "./model.js";

type LegacyScopeInput = {
  batches?: { server_context: MetricScope; records: readonly unknown[] }[];
  server_context: MetricScope;
  records?: readonly unknown[];
};

function inputAttempts(raw: unknown): Array<{ server: MetricScope; record: unknown }> {
  // Preserve historical scope inference; operational callers pass an explicit scope.
  const input = raw as LegacyScopeInput;
  if (Array.isArray(input.batches)) {
    return input.batches.flatMap((batch) =>
      batch.records.map((record) => ({ server: batch.server_context, record })),
    );
  }
  return (input.records ?? []).map((record) => ({ server: input.server_context, record }));
}

export function metricScopeForInput(input: unknown): MetricScope {
  const scopes = new Map<string, MetricScope>();
  for (const { server } of inputAttempts(input)) {
    scopes.set(`${server.tenant_id}\u0000${server.app_id}`, {
      tenant_id: server.tenant_id,
      app_id: server.app_id,
    });
  }
  if (scopes.size !== 1) throw new Error("one SQL cohort evaluation must have exactly one tenant/app scope");
  return [...scopes.values()][0];
}

export function prepareMetricCalculation(raw: unknown): PreparedMetricCalculation {
  // This adapter retains the existing admission rules. It does not introduce a
  // closed JSON-schema gate for legacy replay inputs or strip saved properties.
  const input = raw as MetricCalculationInput;
  const fxPolicy = input.fx_policy;
  if (!fxPolicy || fxPolicy.rates?.length !== 1) {
    throw new Error("v0.2 SQL metric runs require exactly one structured FX rate");
  }
  const definitions = new Map<string, MetricDefinition>(
    [...REFERENCE_AD_REVENUE_METRIC_DEFINITIONS, ...M1B_METRIC_DEFINITIONS]
      .map((definition) => [definition.metric_name, definition]),
  );
  for (const definition of input.metric_definitions ?? []) {
    definitions.set(definition.metric_name, definition);
  }
  for (const definition of definitions.values()) assertMetricDefinitionSeries(definition);
  return { fxPolicy, definitions, evaluations: input.metric_evaluations ?? [] };
}
