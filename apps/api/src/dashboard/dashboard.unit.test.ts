import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dashboardHeaders } from "../router.js";
import { encodeMetricReport, metricColumns, type MetricReportPage, type MetricReportRow } from "../reporting.js";
import { renderDashboard } from "./render.js";
import { renderSparkline } from "./svg.js";
import { buildDashboardView } from "./view.js";

function metric(overrides: Partial<MetricReportRow> = {}): MetricReportRow {
  return {
    metric_run_id: "metric:one",
    metric_name: "d7_roas",
    metric_definition_version: "0.3.1",
    policy_versions: ["rule_bundle:0.3.1"],
    input_received_at_watermark: "2026-08-20T00:00:00.000Z",
    input_snapshot_id: "a".repeat(64),
    data_freshness: "complete",
    value_state: "present",
    undefined_reason: null,
    value_unscaled: "1250000",
    value_type: "ratio",
    currency: null,
    amount_scale: null,
    ratio_scale: 6,
    grouping: { cohort_date: "2026-08-19", attribution_status: "non_organic" },
    rule_bundle_id: "metric-stage-m1",
    rule_bundle_hash: "b".repeat(64),
    aggregation_time_zone: "UTC",
    computed_at: "2026-08-20T00:01:00.000Z",
    reproducibility_status: "fully_reproducible",
    supersedes_metric_run_id: null,
    input_ledger_position: "2026-08-19T23:59:59.000Z|record",
    grouping_digest: "c".repeat(64),
    superseded: false,
    ...overrides,
  };
}

function xmlWellFormed(xml: string): boolean {
  const stack: string[] = [];
  const tags = xml.match(/<\/?[A-Za-z][^>]*>/g) ?? [];
  for (const tag of tags) {
    if (tag.startsWith("</")) {
      const name = /^<\/([A-Za-z][\w:-]*)/.exec(tag)?.[1];
      if (!name || stack.pop() !== name) return false;
    } else if (!tag.endsWith("/>")) {
      const name = /^<([A-Za-z][\w:-]*)/.exec(tag)?.[1];
      if (!name) return false;
      stack.push(name);
    }
  }
  return stack.length === 0;
}

describe("M3 zero-JavaScript dashboard", () => {
  it("C17 renders semantic HTML under the exact CSP without executable markup", () => {
    const view = buildDashboardView({
      apps: [{ app_id: "app-one", created_at: "2026-08-20T00:00:00.000Z" }],
      selectedAppId: "app-one",
      metrics: { data: [metric()] },
      trackingLinks: [{
        tracking_link_id: "tracking-link:one",
        measurement_url: "https://measure.example/r/synthetic",
        destination_url: "https://destination.example/?value=<unsafe>",
        campaign_id: "campaign-one",
        status: "active",
        created_at: "2026-08-20T00:00:00.000Z",
      }],
      csrfToken: "synthetic-csrf",
    });
    const html = renderDashboard(view);
    assert.equal(html.includes("<script"), false);
    assert.equal(html.includes("javascript:"), false);
    assert.equal(/\son[a-z]+\s*=/i.test(html), false);
    assert.ok(html.indexOf("<h1") < html.indexOf("<h2"));
    assert.ok(html.indexOf("<h2") < html.indexOf("<table"));
    assert.match(html, /Measurement links/);
    assert.match(html, /https:\/\/measure\.example\/r\/synthetic/);
    assert.equal(html.includes("<unsafe>"), false);
    assert.match(html, /&lt;unsafe&gt;/);
    assert.equal(
      dashboardHeaders["content-security-policy"],
      "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
  });

  it("C18 keeps undefined values visible, empty in CSV, and absent from the SVG line", () => {
    const undefinedRow = metric({
      metric_run_id: "metric:undefined",
      value_state: "undefined",
      undefined_reason: "no_attributed_cost",
      value_unscaled: undefined,
    });
    const page: MetricReportPage = { data: [undefinedRow] };
    const html = renderDashboard(buildDashboardView({
      apps: [],
      selectedAppId: "app-one",
      metrics: page,
      csrfToken: "synthetic-csrf",
    }));
    assert.match(html, /—/);
    assert.match(html, /no_attributed_cost/);
    assert.equal(html.includes('data-value-unscaled="0"'), false);
    const csv = encodeMetricReport(page, "csv").body.trimEnd().split("\n");
    const header = csv[0].split(",");
    const values = csv[1].split(",");
    assert.equal(values[header.indexOf("value_unscaled")], "");
    assert.equal(values[header.indexOf("undefined_reason")], "no_attributed_cost");
    assert.deepEqual(metricColumns.slice(0, 15), [
      "metric_run_id", "metric_name", "metric_definition_version", "policy_versions",
      "input_received_at_watermark", "input_snapshot_id", "data_freshness",
      "value_state", "undefined_reason", "value_unscaled", "value_type",
      "currency", "amount_scale", "ratio_scale", "grouping",
    ]);
    const svg = renderSparkline([1, undefined, 3]);
    assert.equal((svg.match(/<path /g) ?? []).length, 2);
    assert.equal(svg.includes("L120"), false);
  });

  it("C19 emits deterministic, well-formed, self-contained SVG with gaps", () => {
    const first = renderSparkline([1, 2, undefined, 4, 3], { label: "Synthetic trend" });
    const second = renderSparkline([1, 2, undefined, 4, 3], { label: "Synthetic trend" });
    assert.equal(first, second);
    assert.equal(xmlWellFormed(first), true);
    assert.equal((first.match(/<path /g) ?? []).length, 2);
    assert.equal(first.includes("<script"), false);
    assert.equal(/(?:href|src)=/i.test(first), false);
  });

  it("M4-A12 renders deterministic and Apple aggregate series without combining them", () => {
    const deterministic = metric({ metric_run_id: "metric:deterministic", metric_name: "daily_install_count" });
    const skan = metric({
      metric_run_id: "metric:skan", metric_name: "skan_attributed_installs",
      metric_definition_version: "0.3.3", value_unscaled: "2",
      grouping: { metric_date: "2026-08-20" },
    });
    const aak = metric({
      metric_run_id: "metric:aak", metric_name: "aak_attributed_installs",
      metric_definition_version: "0.3.3", value_unscaled: "1",
      grouping: { metric_date: "2026-08-20" },
    });
    const view = buildDashboardView({
      apps: [], selectedAppId: "app-one", metrics: { data: [deterministic, skan, aak] }, csrfToken: "synthetic-csrf",
    });
    assert.deepEqual(view.deterministicRows.map((row) => row.metric_run_id), ["metric:deterministic"]);
    assert.deepEqual(view.appleAggregateRows.map((row) => row.metric_run_id), ["metric:aak", "metric:skan"]);
    const html = renderDashboard(view);
    assert.match(html, /Deterministic cohort metrics/);
    assert.match(html, /Apple aggregate postback metrics/);
    assert.equal(html.includes("aggregate total"), false);
    assert.equal(view.charts.length, 3);
    assert.equal(view.deterministicCharts.length, 1);
    assert.equal(view.appleAggregateCharts.length, 2);
  });
});
