type JsonRecord = Readonly<Record<string, unknown>>;

export function buildDemoMetricsOutput(input: {
  readonly tenantId: string;
  readonly appId: string;
  readonly ledgerCounts: JsonRecord;
  readonly syntheticMetricRuns: readonly JsonRecord[];
}): JsonRecord {
  return {
    tenant_id: input.tenantId,
    app_id: input.appId,
    ledger_counts: {
      ...input.ledgerCounts,
      origin: "postgresql_ledger",
    },
    synthetic_contract_preview: input.syntheticMetricRuns.map((run) => ({
      ...run,
      origin: "contract_fixture",
      fixture: "33-stage-b-cohort-metrics",
    })),
  };
}
