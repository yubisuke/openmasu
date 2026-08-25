import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMetricQuery,
  encodeMetricCursor,
  parseMetricQuery,
  ReportQueryError,
} from "./report-query.js";

const scope = { tenantId: "tenant-query", appId: "app-query" } as const;

function parse(query: string) {
  return parseMetricQuery({ ...scope, searchParams: new URLSearchParams(query) });
}

function rejects(query: string, code: string): void {
  assert.throws(
    () => parse(query),
    (error: unknown) => error instanceof ReportQueryError && error.code === code,
  );
}

describe("M3 typed reporting query", () => {
  it("C09 parses the same query twice into deeply equal typed values", () => {
    const cursor = encodeMetricCursor({
      metricName: "daily_install_count",
      groupingDigest: "a".repeat(64),
      metricRunId: "metric:cursor",
    });
    const query = [
      "app_id=app-query",
      "metric_name=daily_install_count",
      "metric_name=daily_click_count",
      "metric_definition_version=0.3.1",
      "grouping_country=JP",
      "grouping_attribution_status=organic",
      "date_from=2026-08-19",
      "date_to=2026-08-21",
      "watermark_at_most=2026-08-21T00%3A00%3A00.000Z",
      "supersession=all",
      "limit=50",
      `after=${cursor}`,
    ].join("&");
    assert.deepEqual(parse(query), parse(query));
    assert.deepEqual(parse(query).query.metricNames, ["daily_click_count", "daily_install_count"]);
  });

  it("C09 rejects unknown, identifying, duplicate, invalid, and over-limit filters", () => {
    rejects("app_id=app-query&mystery=value", "unknown_filter");
    rejects("app_id=app-query&grouping_installation_id=synthetic", "identifying_grouping");
    rejects("app_id=app-query&app_id=app-query", "duplicate_filter");
    rejects("app_id=other-app", "app_scope_mismatch");
    rejects("app_id=app-query&grouping_country=japan", "grouping_value_invalid");
    rejects("app_id=app-query&date_from=2026-08-21&date_to=2026-08-21", "date_range_invalid");
    rejects("app_id=app-query&watermark_at_most=2026-08-21T00:00:00Z", "watermark_invalid");
    rejects("app_id=app-query&limit=1001", "limit_invalid");
    rejects("app_id=app-query&after=not-base64-json", "cursor_invalid");
    rejects("app_id=app-query&metric_name=skan_attributed_installs&grouping_attribution_status=non_organic", "metric_series_mismatch");
    rejects("app_id=app-query&metric_name=aak_attributed_installs&grouping_country=JP", "metric_series_mismatch");
    rejects("app_id=app-query&metric_name=skan_attributed_installs&grouping_apple_conversion_bucket=fine%3A21", "metric_series_mismatch");
    rejects("app_id=app-query&metric_name=daily_install_count&grouping_apple_conversion_bucket=fine%3A21", "metric_series_mismatch");
  });

  it("C09 binds every filter value and emits keyset rather than offset SQL", () => {
    const parsed = parse([
      "app_id=app-query",
      "metric_name=unique_metric_90731",
      "metric_definition_version=version_90731",
      "grouping_campaign_id=campaign_90731",
      "grouping_country=JP",
      "date_from=2026-08-19",
      "date_to=2026-08-21",
      "watermark_at_most=2026-08-21T00%3A00%3A00.000Z",
    ].join("&"));
    const statement = buildMetricQuery(parsed.query);
    for (const value of ["unique_metric_90731", "version_90731", "campaign_90731", "JP", "2026-08-19", "2026-08-21"]) {
      assert.equal(statement.text.includes(value), false, `${value} leaked into SQL text`);
      assert.equal(JSON.stringify(statement.values).includes(value), true, `${value} was not bound`);
    }
    assert.match(statement.text, /ORDER BY mr\.metric_name COLLATE "C"/);
    assert.match(statement.text, /mr\.grouping->>'campaign_id'/);
    assert.match(statement.text, /mr\.grouping->>'metric_date'/);
    assert.equal(statement.text.includes("grouping->'dimensions'"), false);
    assert.equal(/\bOFFSET\b/i.test(statement.text), false);
  });
});
