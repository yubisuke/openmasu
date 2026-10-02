import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dashboardHeaders } from "../router.js";
import { encodeMetricReport, metricColumns, type MetricReportPage, type MetricReportRow } from "../reporting.js";
import { renderDashboard } from "./render.js";
import { renderSparkline } from "./svg.js";
import { buildDashboardView } from "./view.js";
import { exactDecimal, metricValueLabel } from "./metric-value.js";
import { dashboardReportParams, reportSelectionParams } from "./report-controls.js";
import { parseMetricQuery } from "../report-query.js";
import { metricCharts } from "./metric-charts.js";
import { M1B_METRIC_DEFINITIONS } from "@openmasu/contracts";
import { captureMetricComparisonContext } from "@openmasu/runtime";
import { comparisonDigest } from "../cohort-comparison.js";
import { buildRetentionMatrices } from "./retention-matrix.js";

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

function savedRetention(date: string, day: number, overrides: Partial<MetricReportRow> = {}): MetricReportRow {
  const definition = structuredClone(M1B_METRIC_DEFINITIONS.find(d => d.metric_name === "retention_d1")!);
  definition.metric_name = `saved_activity_${day}`; // Deliberately no retention-name heuristic.
  definition.definition.window.day = day;
  const row = metric({ metric_run_id: `saved:${date}:${day}`, metric_name: definition.metric_name,
    metric_definition_version: definition.metric_definition_version, rule_bundle_id: definition.rule_bundle_id,
    rule_bundle_hash: definition.rule_bundle_hash, policy_versions: [`rule_bundle:${definition.rule_bundle_version}`],
    aggregation_time_zone: definition.aggregation_time_zone, ratio_scale: definition.ratio_scale!,
    grouping: { cohort_date: date, country: "JP" }, ...overrides });
  return { ...row, comparison_context: captureMetricComparisonContext(row, definition, { policy_version: "synthetic", target_currency: "USD",
    target_scale: 6, rounding_mode: "half_even", rates: [{ currency: "EUR", rate_unscaled: "500000", rate_scale: 6, as_of: "2026-08-01T00:00:00.000Z" }] }, "before", comparisonDigest) };
}

describe("M3 zero-JavaScript dashboard", () => {
  it("aligns saved retention horizons and cohorts without conflating zero undefined missing or unelapsed windows", () => {
    const rows = [savedRetention("2026-08-02", 7, { value_state: "undefined", value_unscaled: undefined, undefined_reason: "empty_cohort" }),
      savedRetention("2026-08-01", 7, { value_unscaled: "250000" }), savedRetention("2026-08-02", 1, { value_unscaled: "0" }),
      savedRetention("2026-08-01", 1, { value_unscaled: "500000" }), savedRetention("2026-08-19", 1)];
    const view = buildDashboardView({ apps: [], selectedAppId: "app-a", metrics: { data: rows }, csrfToken: "synthetic" });
    assert.equal(view.retention.matrices.length, 1);
    const matrix = view.retention.matrices[0];
    assert.deepEqual(matrix.days, [1, 7]);
    assert.deepEqual(matrix.cohorts.map(c => c.date), ["2026-08-01", "2026-08-02", "2026-08-19"]);
    assert.deepEqual(matrix.cohorts[0].cells.map(c => c.observations[0].row.value_unscaled), ["500000", "250000"]);
    assert.equal(matrix.cohorts[1].cells[0].observations[0].row.value_unscaled, "0");
    assert.equal(matrix.cohorts[1].cells[1].observations[0].row.undefined_reason, "empty_cohort");
    assert.equal(matrix.cohorts[0].cells[0].observations[0].maturity, "window_elapsed");
    assert.equal(matrix.cohorts[2].cells[0].observations[0].maturity, "conservative_end_not_reached");
    assert.equal(matrix.cohorts[2].cells[1].observations.length, 0);
    const html = renderDashboard(view);
    assert.match(html, /data-retention-cohort="2026-08-01" data-retention-day="1"/);
    assert.match(html, /data-retention-value-unscaled="500000" data-ratio-scale="6">0\.5 ×/);
    assert.match(html, /data-retention-value-unscaled="0" data-ratio-scale="6">0 ×/);
    assert.match(html, /— \(empty_cohort\)/);
    assert.match(html, /No saved run in this filtered selection/);
    assert.match(html, /saved%3A2026-08-01%3A7\/explanation/);
    assert.match(html, /Conservative window end not reached/);
    assert.deepEqual(buildRetentionMatrices([...rows].reverse(), false), view.retention);
  });

  it("never merges retention snapshots or incompatible saved populations policies grouping and cutoffs", () => {
    const original = savedRetention("2026-08-01", 1);
    const duplicate = savedRetention("2026-08-01", 1, { metric_run_id: "another:snapshot", input_snapshot_id: "f".repeat(64) });
    const changedPopulation = savedRetention("2026-08-01", 1);
    changedPopulation.comparison_context!.definition.fraud_policy = "net";
    changedPopulation.comparison_context!.definition_digest = comparisonDigest(changedPopulation.comparison_context!.definition);
    const rows = [original, duplicate, changedPopulation,
      savedRetention("2026-08-01", 1, { grouping: { cohort_date: "2026-08-01", country: "GB" } }),
      savedRetention("2026-08-01", 1, { policy_versions: [...original.policy_versions, "synthetic:new-policy"] }),
      savedRetention("2026-08-01", 1, { input_received_at_watermark: "2026-08-21T00:00:00.000Z" })];
    const result = buildRetentionMatrices(rows, false);
    assert.equal(result.matrices.length, 5);
    assert.equal(result.matrices.flatMap(m => m.cohorts.flatMap(c => c.cells)).find(c => c.observations.length === 2)!.observations.length, 2);
    assert.match(renderDashboard(buildDashboardView({ apps: [], metrics: { data: rows }, csrfToken: "synthetic" })), /Multiple saved snapshots; not combined/);
    const legacy = savedRetention("2026-08-01", 1, { comparison_context: null });
    const invalid = savedRetention("2026-08-01", 1); invalid.comparison_context!.definition_digest = "0".repeat(64);
    const page = [ { ...legacy, comparison_context: null }, invalid, savedRetention("2026-08-01", 1, { superseded: true }), metric({ metric_name: "retention_d7" }) ];
    const view = buildDashboardView({ apps: [], metrics: { data: page }, csrfToken: "synthetic" });
    assert.equal(view.retention.matrices.length, 0); assert.equal(view.rows.length, page.length);
    assert.match(renderDashboard(view), /retention_d7/);
    assert.equal(buildRetentionMatrices([savedRetention("2026-08-01", 1, { input_received_at_watermark: "unknown" })], false).matrices[0].cohorts[0].cells[0].observations[0].maturity, "unknown");
  });

  it("keeps retention page gaps unknown even on the last keyset page and bounds the row-column expansion", () => {
    const rows = [savedRetention("2026-08-01", 1), savedRetention("2026-08-02", 7)];
    const query = parseMetricQuery({ tenantId: "tenant-a", appId: "app-a", searchParams: new URLSearchParams("grouping_country=JP&limit=2") }).query;
    for (const view of [
      buildDashboardView({ apps: [], selectedAppId: "app-a", query, metrics: { data: rows, next_cursor: "synthetic-next" }, csrfToken: "synthetic" }),
      buildDashboardView({ apps: [], selectedAppId: "app-a", query: { ...query, after: { metricName: "retention_d1", groupingDigest: "a".repeat(64), metricRunId: "prior" } }, metrics: { data: rows }, csrfToken: "synthetic" }),
    ]) {
      assert.equal(view.retention.partialPage, true);
      const html = renderDashboard(view);
      assert.match(html, /Not fetched on this page/); assert.doesNotMatch(html, /No saved run in this filtered selection/);
    }
    const large = Array.from({ length: 46 }, (_, day) => savedRetention(new Date(Date.UTC(2026, 6, day + 1)).toISOString().slice(0, 10), day));
    const bounded = buildDashboardView({ apps: [], metrics: { data: large }, csrfToken: "synthetic" });
    assert.equal(bounded.retention.cellLimitReached, true); assert.equal(bounded.retention.matrices.length, 0);
    assert.equal(bounded.rows.length, 46); assert.match(renderDashboard(bounded), /2000-cell display limit/);
  });
  it("labels revised cost and pending recalculation without changing the saved value", () => {
    for (const state of ["input_revised", "recalculation_pending"] as const) {
      const row = metric({ cost_update_state: state });
      const html = renderDashboard(buildDashboardView({ apps: [], metrics: { data: [row] }, csrfToken: "synthetic" }));
      assert.match(html, /Cost input revised/);
      assert.match(html, /data-value-unscaled="1250000"/);
      assert.equal(row.data_freshness, "complete");
    }
  });
  it("keeps SSR filter selection and CSV export scope identical without weakening API validation", () => {
    const input = new URLSearchParams("metric_name=d7_roas&metric_name=&grouping_campaign_id=campaign-synthetic&grouping_country=JP&grouping_attribution_status=organic&date_from=2026-08-01&date_to=2026-08-20&watermark_at_most=2026-08-21T00%3A00%3A00.000Z&supersession=all&grouping_network=");
    const parse = (searchParams: URLSearchParams) => parseMetricQuery({ tenantId: "tenant-a", appId: "app-a", searchParams });
    assert.throws(() => parse(input));
    const { query } = parse(dashboardReportParams(input));
    assert.deepEqual(parse(reportSelectionParams(query)).query, query);
    assert.throws(() => parse(dashboardReportParams(new URLSearchParams("unknown="))), /unknown_filter/);
    assert.throws(() => parse(dashboardReportParams(new URLSearchParams("date_from=invalid"))));
    const html = renderDashboard(buildDashboardView({ apps: [], selectedAppId: "app-a", query, metrics: { data: [metric()] }, csrfToken: "synthetic" }));
    const href = /href="([^"]+cohorts\.csv\?[^"]+)"/.exec(html)![1].replaceAll("&amp;", "&");
    const exported = new URL(href, "https://synthetic.example").searchParams;
    assert.equal(exported.get("export"), "true");
    exported.delete("export");
    assert.deepEqual(parse(exported).query, query);
    assert.match(html, /form method="get"/);
    assert.match(html, /Cohort maturity: unknown/);
  });

  it("separates chart dimensions, currencies, history and ambiguous snapshots with honest gaps", () => {
    const rows = [metric(), metric({ metric_run_id: "next", grouping: { cohort_date: "2026-08-21", attribution_status: "non_organic" } })];
    assert.deepEqual(metricCharts(rows)[0].series, [1250000, undefined, 1250000]);
    assert.equal(metricCharts([...rows, metric({ grouping: { cohort_date: "2026-08-19", attribution_status: "organic" } })]).length, 2);
    assert.equal(metricCharts([metric(), metric({ superseded: true })]).length, 2);
    assert.equal(metricCharts([metric(), metric({ metric_run_id: "another-snapshot" })]).length, 2);
    assert.equal(metricCharts([metric({ currency: "USD" }), metric({ currency: "JPY" })]).length, 2);
    assert.deepEqual(metricCharts([metric({ value_unscaled: "9007199254740993" })])[0].series, [undefined]);
  });
  it("formats money, ratios and counts exactly without inferring units from metric names", () => {
    assert.equal(metricValueLabel(metric()), "1.25 ×");
    assert.equal(metricValueLabel(metric({ metric_name: "retention_d1" })), "1.25 ×");
    assert.equal(metricValueLabel(metric({ value_type: "money", currency: "USD", amount_scale: 6 })), "USD 1.25");
    assert.equal(metricValueLabel(metric({ value_type: "money", currency: "JPY", amount_scale: 0, value_unscaled: "-900719925474099312345" })), "JPY -900719925474099312345");
    assert.equal(metricValueLabel(metric({ value_type: "count", value_unscaled: "0" })), "0 count");
    assert.equal(metricValueLabel(metric({ value_unscaled: "1", ratio_scale: 18 })), "0.000000000000000001 ×");
    assert.equal(exactDecimal("-0", 6), "0");
    assert.throws(() => exactDecimal("1.25", 6), /invalid_metric_decimal/);
    assert.throws(() => exactDecimal("1", 19), /invalid_metric_decimal/);
    assert.match(metricValueLabel(metric({ value_state: "undefined", value_unscaled: undefined, undefined_reason: "empty_cohort" })), /—.*empty_cohort/);
  });

  it("changes only the visible metric label while preserving audit attributes and CSV", () => {
    const row = metric();
    const page = { data: [row] };
    const before = encodeMetricReport(page, "csv").body;
    const html = renderDashboard(buildDashboardView({ apps: [], metrics: page, csrfToken: "synthetic" }));
    assert.match(html, /data-metric-run-id="metric:one" data-value-unscaled="1250000">1\.25 ×<\/span>/);
    assert.equal(encodeMetricReport(page, "csv").body, before);
    assert.equal(row.value_unscaled, "1250000");
  });
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

  it("renders explicit continuation links for every bounded report surface", () => {
    const html = renderDashboard(buildDashboardView({
      apps: [{ app_id: "app-one", created_at: "2026-08-20T00:00:00.000Z" }],
      selectedAppId: "app-one",
      query: {
        tenantId: "tenant-one",
        appId: "app-one",
        metricNames: ["daily_click_count"],
        watermarkAtMost: "2026-08-30T00:00:00.000Z",
        supersession: "latest",
        limit: 2,
      },
      metrics: { data: [metric()], next_cursor: "metric-cursor" },
      records: [{ metric_name: "daily_click_count", grouping: { metric_date: "2026-08-29" }, count: "1" }],
      recordNextCursor: "record-cursor",
      differences: { data: [{
        reconciliation_id: "reconciliation:one",
        difference_reason_code: "candidate_missing",
        input_snapshot_id: "input:one",
        external_snapshot_id: "external:one",
        matching_keys: [], candidates: [], exclusions: [], windows: [], joins: [], freshness: "current",
      }] },
      differenceNextCursor: "difference-cursor",
      csrfToken: "synthetic-csrf",
    }));
    assert.match(html, /Next metric page/);
    assert.match(html, /Next aggregate-record page/);
    assert.match(html, /Next difference-audit page/);
    assert.match(html, /\/dashboard\/apps\/app-one\/records\?/);
    assert.match(html, /\/dashboard\/apps\/app-one\/differences\?/);
    assert.equal(html.includes("tenant-one"), false);
    assert.equal(html.includes("<script"), false);
  });

  it("WO18 renders zero-JavaScript lifecycle forms only for permitted roles", () => {
    const base = {
      apps: [{ app_id: "app-one", created_at: "2026-08-20T00:00:00.000Z" }],
      selectedAppId: "app-one",
      trackingLinks: [{
        tracking_link_id: "tracking-link:one",
        measurement_url: "https://measure.example/r/synthetic",
        destination_url: "https://destination.example/",
        status: "active" as const,
        created_at: "2026-08-20T00:00:00.000Z",
      }],
      sdkKeys: [{
        sdk_key_id: "sdk-key:one", platform: "android" as const, status: "active" as const,
        created_at: "2026-08-20T00:00:00.000Z", status_changed_at: "2026-08-20T00:00:00.000Z",
      }],
      serverKeys: [{
        server_key_id: "server-key:one", producer: "postback:first-party", status: "active" as const,
        created_at: "2026-08-20T00:00:00.000Z", status_changed_at: "2026-08-20T00:00:00.000Z",
      }],
      operatorWebhooks: [{
        destination_id: "webhook:one", endpoint_url: "https://events.example.test/openmasu",
        events: ["custom_event"], status: "active" as const,
        created_at: "2026-08-20T00:00:00.000Z", status_changed_at: "2026-08-20T00:00:00.000Z",
      }],
      csrfToken: "synthetic-csrf",
    };
    const readOnly = renderDashboard(buildDashboardView(base));
    assert.doesNotMatch(readOnly, /Issue successor key|Register a link domain|>Pause<|>Archive</);
    const operator = renderDashboard(buildDashboardView({ ...base, canOperate: true }));
    assert.match(operator, />Pause</);
    assert.match(operator, />Archive</);
    assert.doesNotMatch(operator, /Issue successor key|Register a link domain/);
    const admin = renderDashboard(buildDashboardView({ ...base, canOperate: true, canAdminister: true }));
    assert.match(admin, /Issue successor key/);
    assert.match(admin, /Server-to-server keys/);
    assert.match(admin, /postback:first-party/);
    assert.match(admin, /Operator event webhooks/);
    assert.match(admin, /events\.example\.test/);
    assert.match(admin, />Disable</);
    assert.match(admin, /Register a link domain/);
    assert.match(admin, /Complete activation request JSON/);
    assert.equal(admin.includes("<script"), false);
    assert.equal(/\son[a-z]+\s*=/i.test(admin), false);
  });

  it("WO18 never renders SDK secrets in key metadata", () => {
    const secret = "synthetic-secret-that-must-not-be-rendered";
    const html = renderDashboard(buildDashboardView({
      apps: [], selectedAppId: "app-one", csrfToken: "synthetic-csrf", canAdminister: true,
      sdkKeys: [{
        sdk_key_id: "sdk-key:one", platform: "ios", status: "retired",
        created_at: "2026-08-20T00:00:00.000Z", status_changed_at: "2026-08-21T00:00:00.000Z",
      }],
    }));
    assert.match(html, /secrets are never listed/);
    assert.match(html, /sdk-key:one/);
    assert.equal(html.includes(secret), false);
    assert.doesNotMatch(html, /secret_ref|SDK key <code>/);
  });

  it("never renders server secrets in key metadata", () => {
    const secret = "synthetic-server-secret-that-must-not-be-rendered";
    const html = renderDashboard(buildDashboardView({
      apps: [], selectedAppId: "app-one", csrfToken: "synthetic-csrf", canAdminister: true,
      serverKeys: [{
        server_key_id: "server-key:one", producer: "postback:first-party", status: "retired",
        created_at: "2026-08-20T00:00:00.000Z", status_changed_at: "2026-08-21T00:00:00.000Z",
      }],
    }));
    assert.match(html, /Server key metadata \(secrets are never listed\)/);
    assert.match(html, /server-key:one/);
    assert.equal(html.includes(secret), false);
    assert.doesNotMatch(html, /secret_ref|Server key <code>/);
  });

  it("renders bounded Google delivery health without secret-bearing identifiers", () => {
    const forbidden = [
      "request_ref", "provider_request_id", "request_digest", "transaction_digest",
      "encrypted:synthetic", "provider-request-synthetic", "a".repeat(64),
    ];
    const html = renderDashboard(buildDashboardView({
      apps: [],
      selectedAppId: "app-one",
      csrfToken: "synthetic-csrf",
      googleDeliveryHealth: {
        destination: {
          configured: true,
          enabled: true,
          next_request_at: "2026-08-31T10:00:00.000Z",
        },
        summary: {
          total: 2,
          due_now: 0,
          scheduled: 1,
          by_state: {
            queued: 1,
            http_accepted: 0,
            diagnostics_processing: 0,
            succeeded: 0,
            partial_success: 0,
            failed: 1,
            expired: 0,
          },
        },
        deliveries: [{
          delivery_id: "00000000-0000-7000-8000-000000000127",
          state: "queued",
          attempts: 2,
          next_attempt_at: "2026-08-31T10:01:00.000Z",
          diagnostics_deadline_at: null,
          safe_reason: "rate_limited",
          created_at: "2026-08-31T09:00:00.000Z",
          updated_at: "2026-08-31T09:59:00.000Z",
        }],
        maximum_rows: 50,
      },
    }));
    assert.match(html, /Google Data Manager delivery health/);
    assert.match(html, /rate_limited/);
    assert.match(html, /2026-08-31T10:01:00.000Z/);
    assert.match(html, /provider-side exactly-once proof/);
    assert.equal(html.includes("<script"), false);
    for (const value of forbidden) assert.equal(html.includes(value), false, value);
  });

  it("renders bounded operator delivery health without secret-bearing identifiers", () => {
    const html = renderDashboard(buildDashboardView({
      apps: [],
      selectedAppId: "app-one",
      csrfToken: "synthetic-csrf",
      operatorDeliveryHealth: {
        webhooks: {
          summary: {
            total: 1, due_now: 1, scheduled: 0,
            by_state: { queued: 0, retry: 1, succeeded: 0, failed: 0, suppressed: 0 },
          },
          deliveries: [{
            delivery_id: "00000000-0000-7000-8000-000000000129",
            destination_id: "webhook:synthetic",
            event_name: "custom_event",
            state: "retry",
            attempts: 2,
            next_attempt_at: "2026-08-31T11:00:00.000Z",
            last_http_status: 503,
            safe_reason: "transport_error",
            created_at: "2026-08-31T10:00:00.000Z",
            updated_at: "2026-08-31T10:30:00.000Z",
          }],
        },
        bulk_exports: {
          summary: {
            total: 1, due_now: 0, scheduled: 0,
            by_state: { queued: 0, retry: 0, succeeded: 1, failed: 0, suppressed: 0 },
          },
          batches: [{
            batch_id: "00000000-0000-7000-8000-000000000130",
            destination_id: "bulk:synthetic",
            row_count: 25,
            state: "succeeded",
            attempts: 1,
            next_attempt_at: "2026-08-31T11:00:00.000Z",
            last_http_status: 200,
            safe_reason: null,
            created_at: "2026-08-31T10:00:00.000Z",
            updated_at: "2026-08-31T10:31:00.000Z",
          }],
        },
        maximum_rows_per_channel: 50,
      },
    }));
    assert.match(html, /Operator delivery health/);
    assert.match(html, /transport_error/);
    assert.match(html, /custom_event/);
    assert.match(html, />25</);
    assert.equal(html.includes("<script"), false);
    for (const forbidden of [
      "request_ref", "request_digest", "record_id", "object_key", "object_ref", "object_digest",
      "credential_ref", "secret_ref", "encrypted:synthetic", "artifact",
    ]) assert.equal(html.includes(forbidden), false, forbidden);
  });

  it("reports signed purchase net revenue without exposing purchase identifiers", () => {
    const netRevenue = metric({
      metric_run_id: "metric:purchase-net-negative",
      metric_name: "cohort_purchase_net_revenue_d0_usd",
      metric_definition_version: "0.4.8",
      value_unscaled: "-2000000",
      value_type: "money",
      currency: "USD",
      amount_scale: 6,
      ratio_scale: null,
    });
    const page: MetricReportPage = { data: [netRevenue] };
    const json = encodeMetricReport(page, "json").body;
    const csv = encodeMetricReport(page, "csv").body;
    const html = renderDashboard(buildDashboardView({
      apps: [], selectedAppId: "app-one", metrics: page, csrfToken: "synthetic-csrf",
    }));
    for (const output of [json, csv, html]) {
      assert.match(output, /cohort_purchase_net_revenue_d0_usd/);
      assert.equal(output.includes("transaction_id"), false);
      assert.equal(output.includes("installation_id"), false);
      assert.equal(output.includes("correction_target_record_id"), false);
    }
    assert.match(json, /-2000000/);
    assert.match(csv, /-2000000/);
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
