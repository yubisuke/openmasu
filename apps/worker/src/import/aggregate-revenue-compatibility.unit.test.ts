import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  reportAggregateRevenueCompatibility,
  reportAggregateRevenueCompatibilityFile,
} from "./aggregate-revenue-compatibility.js";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    day: "2026-08-23",
    country: "us",
    max_ad_unit_id: "synthetic-unit",
    network: "synthetic-network",
    estimated_revenue: "1.250000",
    ...overrides,
  };
}

describe("provider-reported aggregate-revenue compatibility", () => {
  it("accepts a synthetic report while keeping it outside installation cohorts", () => {
    const result = reportAggregateRevenueCompatibility({ code: 200, count: 1, results: [row()] });
    assert.equal(result.compatibility.status, "compatible");
    assert.equal(result.compatibility.execution_ready, true);
    assert.deepEqual(result.rows, { read: 1, selected: 1, filtered: 0, accepted: 1, rejected: 0 });
    assert.deepEqual(result.compatibility.series_semantics, {
      source_series: "provider_reported_aggregate",
      subject_scope: "aggregate",
      cohort_eligible: false,
      separate_from_installation_revenue: true,
    });
  });

  it("uses the same object, response-code, count, and row-limit envelope as runtime", () => {
    for (const input of [
      [row()],
      { code: 500, count: 1, results: [row()] },
      { code: 200, count: 2, results: [row()] },
    ]) {
      const result = reportAggregateRevenueCompatibility(input);
      assert.equal(result.compatibility.status, "not_compatible");
      assert.equal(result.compatibility.execution_ready, false);
      assert.deepEqual(result.rows, { read: 0, selected: 0, filtered: 0, accepted: 0, rejected: 0 });
    }
    const limited = reportAggregateRevenueCompatibility({ count: 2, results: [row(), row({ network: "other" })] }, 1);
    assert.equal(limited.compatibility.status, "not_compatible");
    assert.equal(limited.compatibility.execution_ready, false);
  });

  it("keeps partial and duplicate reports non-executable without exposing values", () => {
    const secret = "must-not-appear-in-report";
    const partial = reportAggregateRevenueCompatibility({ results: [row(), row({ network: secret, estimated_revenue: "1.0000001" })] });
    assert.equal(partial.compatibility.status, "partially_compatible");
    assert.equal(partial.compatibility.execution_ready, false);
    assert.deepEqual(partial.rejections, [{ reason_code: "aggregate_row_invalid", count: 1, fields: [] }]);
    assert.equal(JSON.stringify(partial).includes(secret), false);

    const duplicate = reportAggregateRevenueCompatibility({ results: [row(), row({ estimated_revenue: "2.000000" })] });
    assert.equal(duplicate.compatibility.status, "not_compatible");
    assert.equal(duplicate.compatibility.execution_ready, false);
    assert.deepEqual(duplicate.rejections, [{ reason_code: "aggregate_dimension_duplicate", count: 1, fields: [] }]);
  });

  it("distinguishes an empty report from malformed JSON without leaking the path", () => {
    assert.equal(reportAggregateRevenueCompatibility({ results: [] }).compatibility.status, "not_evaluated");
    const directory = mkdtempSync(join(tmpdir(), "openmasu-aggregate-compatibility-"));
    try {
      const file = join(directory, "private-report.json");
      writeFileSync(file, "{not-json");
      const malformed = reportAggregateRevenueCompatibilityFile({ filePath: file });
      assert.equal(malformed.compatibility.status, "not_compatible");
      assert.deepEqual(malformed.rejections, [{ reason_code: "aggregate_response_invalid", count: 1, fields: [] }]);
      assert.equal(JSON.stringify(malformed).includes(file), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("fails closed for missing and oversized private files without exposing their paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmasu-aggregate-compatibility-"));
    try {
      const missing = join(directory, "private-missing.json");
      const missingResult = reportAggregateRevenueCompatibilityFile({ filePath: missing });
      assert.equal(missingResult.compatibility.status, "not_compatible");
      assert.equal(JSON.stringify(missingResult).includes(missing), false);

      const large = join(directory, "private-large.json");
      writeFileSync(large, JSON.stringify({ results: [row()] }));
      const largeResult = reportAggregateRevenueCompatibilityFile({ filePath: large, maxBytes: 1 });
      assert.equal(largeResult.compatibility.status, "not_compatible");
      assert.equal(JSON.stringify(largeResult).includes(large), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
