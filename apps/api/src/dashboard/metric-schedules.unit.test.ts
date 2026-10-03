import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { normalizeMetricScheduleRequest, type MetricScheduleRecord } from "../metric-schedules.js";
import { matchRoute } from "../routes.js";
import { metricScheduleFormRequest, renderMetricSchedules } from "./metric-schedules.js";
import { SELECTED_ACQUISITION_METRIC_DEFINITIONS } from "@openmasu/contracts/definitions";

it("decodes schedule forms without changing the API request and rejects ambiguous transport", () => {
  const body = JSON.parse(readFileSync("examples/synthetic/metric-schedule.json", "utf8"));
  const form = new URLSearchParams({ csrf_token: "synthetic-csrf", request_json: JSON.stringify(body) });
  const parsed = metricScheduleFormRequest(form);
  assert.deepEqual(parsed, body);
  const now = new Date("2026-08-10T12:00:00.000Z");
  assert.deepEqual(normalizeMetricScheduleRequest(parsed, now), normalizeMetricScheduleRequest(body, now));
  for (const value of ["", "null", "[]", "1", "{bad"]) {
    assert.throws(() => metricScheduleFormRequest(new URLSearchParams({ request_json: value })), /metric_schedule_json_invalid/);
  }
  const duplicated = new URLSearchParams(form); duplicated.append("request_json", "{}");
  assert.throws(() => metricScheduleFormRequest(duplicated), /metric_schedule_form_invalid/);
  assert.throws(() => metricScheduleFormRequest(new URLSearchParams("tenant_id=other&request_json=%7B%7D")), /metric_schedule_form_invalid/);
  assert.throws(() => metricScheduleFormRequest(form, true), /metric_schedule_form_invalid/);
  assert.deepEqual(metricScheduleFormRequest(new URLSearchParams("csrf_token=synthetic"), true), {});
  const selection = new URLSearchParams("csrf_token=synthetic&custom_conversion_event_keys=tutorial_complete&custom_conversion_event_keys=signup_complete&lag_days=9&start_date=2026-08-06");
  assert.deepEqual(metricScheduleFormRequest(selection), { custom_conversion_event_keys: ["tutorial_complete", "signup_complete"],
    lag_days: 9, start_date: "2026-08-06" });
  selection.append("request_json", "{}");
  assert.throws(() => metricScheduleFormRequest(selection), /metric_schedule_form_invalid/);
});

it("renders immutable schedule state and checkpoints with administer-only routes and escaped evidence", () => {
  const body = JSON.parse(readFileSync("examples/synthetic/metric-schedule.json", "utf8"));
  const normalized = normalizeMetricScheduleRequest(body, new Date("2026-08-10T12:00:00.000Z"));
  const record: MetricScheduleRecord = {
    metric_schedule_id: "metric-schedule:synthetic", tenant_id: "tenant-synthetic", app_id: "app-synthetic",
    lag_days: normalized.lagDays, start_date: normalized.startDate, definition: normalized.definition,
    definition_digest: normalized.definitionDigest, status: "active", created_at: "2026-08-10T12:00:00.000Z",
    status_changed_at: "2026-08-10T12:00:00.000Z", last_target_date: null, pending_target_date: "2026-08-02",
    safe_reason: "<script>synthetic</script>", latest_discovery: { selection_state: "partial_unknown" },
  };
  const html = renderMetricSchedules("app-synthetic", [record], "csrf<&");
  for (const value of [normalized.definitionDigest, "2026-08-02", "not processed", "partial_unknown", "metric-schedule:synthetic"]) assert.ok(html.includes(value));
  assert.ok(html.includes("&lt;script&gt;synthetic&lt;/script&gt;"));
  assert.ok(html.includes('value="csrf&lt;&amp;"'));
  assert.ok(html.includes("metric-schedule%3Asynthetic/disable"));
  assert.doesNotMatch(html, /<script\b|javascript:|\son[a-z]+=/i);
  const disabled = renderMetricSchedules("app-synthetic", [{ ...record, status: "disabled" }], "csrf");
  assert.ok(!disabled.includes("metric-schedule%3Asynthetic/disable"));
  assert.ok(disabled.includes("Disabled; retained for history"));
  assert.ok(renderMetricSchedules("app-synthetic", [], "csrf").includes("No metric schedules"));
  const registered = SELECTED_ACQUISITION_METRIC_DEFINITIONS[0];
  const profiles = renderMetricSchedules("app-synthetic", [{ ...record, definition: { ...record.definition,
    metric_definitions: [registered, { ...registered, metric_name: "synthetic_legacy",
      rule_bundle_id: "synthetic-unregistered-bundle" }],
  } }], "csrf");
  assert.ok(profiles.includes("Selected acquisition"));
  assert.ok(profiles.includes("Unregistered bundle identity (legacy or external declaration)"));
  assert.doesNotMatch(profiles, /<script\b|javascript:|\son[a-z]+=/i);
  const conversionForm = renderMetricSchedules("app-synthetic", [], "csrf<&", ["signup_complete", "tutorial_complete"]);
  assert.match(conversionForm, /name="custom_conversion_event_keys" value="signup_complete"/);
  assert.match(conversionForm, /value="csrf&lt;&amp;"/);
  assert.doesNotMatch(conversionForm, /<script\b|javascript:|\son[a-z]+=/i);
  for (const [method, suffix, mutates] of [["GET", "", false], ["POST", "", true], ["POST", "/metric-schedule%3Asynthetic/disable", true]] as const) {
    const route = matchRoute(method, `/dashboard/apps/app-synthetic/metric-schedules${suffix}`)!;
    assert.equal(route.auth, "dashboard_session"); assert.equal(route.capability, "administer"); assert.equal(route.mutates, mutates);
  }
});
