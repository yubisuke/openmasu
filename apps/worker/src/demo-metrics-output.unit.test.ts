import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildDemoMetricsOutput } from "./demo-metrics-output.js";

describe("WO13 metric demo provenance", () => {
  it("labels database counts and contract preview with distinct structural origins", () => {
    const output = buildDemoMetricsOutput({
      tenantId: "tenant-synthetic-demo",
      appId: "app-synthetic-demo",
      ledgerCounts: { raw_records: 3 },
      syntheticMetricRuns: [{ metric_name: "d7_roas", value_unscaled: "1500000" }],
    });
    assert.deepEqual(output.ledger_counts, {
      raw_records: 3,
      origin: "postgresql_ledger",
    });
    assert.deepEqual(output.synthetic_contract_preview, [{
      metric_name: "d7_roas",
      value_unscaled: "1500000",
      origin: "contract_fixture",
      fixture: "33-stage-b-cohort-metrics",
    }]);
  });
});
