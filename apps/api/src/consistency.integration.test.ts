import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Pool } from "pg";
import { createAppPool, createReaderPool, createSeedPool } from "@openmasu/runtime";
import { buildDashboardView } from "./dashboard/view.js";
import { renderDashboard } from "./dashboard/render.js";
import { parseMetricQuery } from "./report-query.js";
import { metricReport, recordCounts, type MetricReportRow, type RecordCountRow } from "./reporting.js";
import { ingestFixture } from "../../worker/src/ingestion.js";
import { computeSqlMetricRuns } from "../../worker/src/metrics/cohort.js";

type Any = Record<string, any>;
type ConsistencyRow = {
  readonly metric_name: string;
  readonly grouping: Readonly<Record<string, string>>;
  readonly count: string;
};

const watermark = "2026-08-21T00:00:00.000Z";
const identity = { keyId: "key:synthetic-consistency", tenantId: "tenant-a", appId: "app-a", role: "admin" } as const;

function fixture(): Any {
  const input = JSON.parse(readFileSync(
    join(process.cwd(), "fixtures", "v0.4", "42-daily-metric-date", "input.json"),
    "utf8",
  ));
  const click = input.records.find((record: Any) => record.event_name === "click");
  click.payload.network = "synthetic-network";
  click.payload.country = "JP";
  const install = input.records.find((record: Any) => record.event_name === "install");
  install.payload.import_context = {
    imported_at: "2026-08-20T15:00:00.500Z",
    source_snapshot_id: "synthetic-m3-consistency",
    row_number: 1,
    provider_install_id: "synthetic-install-42",
    provider_campaign_ref: "campaign-42",
    provider_network: "synthetic-network",
    provider_country: "JP",
  };
  return input;
}

function normalizedMetrics(rows: readonly MetricReportRow[]): ConsistencyRow[] {
  return rows.map((row) => ({
    metric_name: row.metric_name,
    grouping: row.grouping,
    count: row.value_unscaled ?? "undefined",
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
}

function normalizedRecords(rows: readonly RecordCountRow[]): ConsistencyRow[] {
  return rows.map((row) => ({ ...row })).sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
}

function htmlValues(html: string): Map<string, string> {
  return new Map([...html.matchAll(/data-metric-run-id="([^"]+)" data-value-unscaled="([^"]+)"/g)]
    .map((match) => [match[1], match[2]] as const));
}

describe("M3 four-surface consistency", { concurrency: false }, () => {
  let appPool: Pool;
  let readerPool: Pool;
  let seedPool: Pool;

  before(() => {
    appPool = createAppPool();
    readerPool = createReaderPool();
    seedPool = createSeedPool();
  });

  after(async () => {
    await appPool?.end();
    await readerPool?.end();
    await seedPool?.end();
  });

  const cases = [
    { name: "default", query: "", grouping: { metric_date: "2026-08-20" } },
    { name: "campaign", query: "grouping_campaign_id=campaign-42", grouping: { metric_date: "2026-08-20", campaign_id: "campaign-42" } },
    { name: "country", query: "grouping_country=JP", grouping: { metric_date: "2026-08-20", country: "JP" } },
    { name: "attribution status", query: "metric_name=daily_install_count&grouping_attribution_status=organic", grouping: { metric_date: "2026-08-20", attribution_status: "organic" }, installOnly: true },
    { name: "date sub-range", query: "date_from=2026-08-20&date_to=2026-08-21", grouping: { metric_date: "2026-08-20" } },
    { name: "single metric", query: "metric_name=daily_click_count", grouping: { metric_date: "2026-08-20" }, clickOnly: true },
    { name: "all supersession history", query: "supersession=all", grouping: { metric_date: "2026-08-20" } },
    { name: "empty result", query: "grouping_campaign_id=missing-campaign", grouping: { metric_date: "2026-08-20", campaign_id: "campaign-42" }, empty: true },
  ] as const;

  for (const [index, candidate] of cases.entries()) {
    it(`C15 matches raw counts, API rows, DashboardView, and HTML for ${candidate.name}`, async () => {
      const input = fixture();
      const selected = "clickOnly" in candidate && candidate.clickOnly ? [input.metric_evaluations[0]]
        : "installOnly" in candidate && candidate.installOnly ? [input.metric_evaluations[1]]
          : input.metric_evaluations;
      input.metric_evaluations = selected.map((evaluation: Any) => ({
        ...evaluation,
        metric_run_id_prefix: `${evaluation.metric_run_id_prefix}-consistency-${index}`,
        grouping: candidate.grouping,
      }));
      await ingestFixture(`m3-consistency-${index}`, input, appPool, seedPool);
      await computeSqlMetricRuns(appPool, input, true);
      const params = new URLSearchParams(candidate.query);
      params.set("watermark_at_most", watermark);
      const parsed = parseMetricQuery({
        tenantId: identity.tenantId,
        appId: identity.appId,
        searchParams: params,
      });
      const api = await metricReport(readerPool, identity, parsed.query);
      const raw = await recordCounts(readerPool, identity, parsed.query);
      const view = buildDashboardView({
        apps: [{ app_id: identity.appId, created_at: "2026-08-20T00:00:00.000Z" }],
        selectedAppId: identity.appId,
        query: parsed.query,
        metrics: api,
        records: raw,
        csrfToken: "synthetic-consistency-csrf",
      });
      const expected = "empty" in candidate && candidate.empty ? [] : normalizedRecords(raw);
      assert.deepEqual(normalizedMetrics(api.data), expected);
      assert.deepEqual(normalizedMetrics(view.rows), expected);
      assert.deepEqual(normalizedRecords(view.records), expected);
      const rendered = htmlValues(renderDashboard(view));
      assert.deepEqual(
        [...rendered.values()].sort(),
        api.data.map((row) => row.value_unscaled ?? "undefined").sort(),
      );
      if (index === 0) {
        const mutation = structuredClone(normalizedMetrics(api.data));
        mutation[0] = { ...mutation[0], count: "999" };
        assert.throws(() => assert.deepEqual(mutation, expected));
      }
    });
  }

  it("prints the fixed-watermark evidence summary", () => {
    console.log(`C15 consistency passed: ${cases.length} synthetic filter combinations at ${watermark}.`);
  });
});
