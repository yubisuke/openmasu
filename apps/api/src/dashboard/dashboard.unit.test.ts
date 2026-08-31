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
