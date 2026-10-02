import assert from "node:assert/strict";
import { it } from "node:test";
import { normalizeMetricRecalculationRequest } from "@openmasu/runtime";
import { matchRoute } from "../routes.js";
import { metricRecalculationFormRequest, renderMetricRecalculations } from "./metric-recalculations.js";

const request = { cost_import_run_id: "01800000-0000-7000-8000-000000000000",
  date_from: "2026-08-01", date_to: "2026-08-31", watermark: "2026-09-01T00:00:00.000Z" };

it("normalizes cost-only confirmation forms with the existing API rules and rejects ambiguous transport", () => {
  const form = new URLSearchParams({ ...request, csrf_token: "synthetic", metric_names: "d7_roas, d1_roas d7_roas" });
  const parsed = metricRecalculationFormRequest(form);
  assert.deepEqual(parsed, normalizeMetricRecalculationRequest({ ...request, metric_names: ["d7_roas", "d1_roas", "d7_roas"] }));
  assert.deepEqual(metricRecalculationFormRequest(new URLSearchParams(request)), request);
  for (const [key, value] of [["date_to", "2026-09-01"], ["cost_import_run_id", "not-a-receipt"], ["watermark", "2026-09-01"]]) {
    const bad = new URLSearchParams(form); bad.set(key, value);
    assert.throws(() => metricRecalculationFormRequest(bad), /metric_recalculation_request_invalid/);
  }
  for (const [key, value] of [["tenant_id", "other"], ["trigger_kind", "late_events"], ["watermark", request.watermark]]) {
    const bad = new URLSearchParams(form); bad.append(key, value);
    assert.throws(() => metricRecalculationFormRequest(bad), /metric_recalculation_form_invalid/);
  }
});

it("renders separate review and submit actions with read-only job state and escaped saved-run links", () => {
  const rows = [{ recalculation_id: "recalculation:synthetic", trigger_kind: "cost_revision", cost_import_run_id: request.cost_import_run_id,
    date_from: request.date_from, date_to: request.date_to, watermark: request.watermark, state: "queued",
    safe_reason: "<script>synthetic</script>", selection_status: null, source_metric_run_id: "run:original", replacement_metric_run_id: null }];
  const html = renderMetricRecalculations("app-a", rows, "csrf<&", true);
  assert.match(html, /metric-recalculations\/preview/);
  assert.match(html, /run%3Aoriginal\/explanation/);
  assert.ok(html.includes("&lt;script&gt;synthetic&lt;/script&gt;"));
  assert.doesNotMatch(html, /<script\b|javascript:|\son[a-z]+=/i);
  const preview = renderMetricRecalculations("app-a", rows, "csrf<&", true, request);
  assert.match(preview, /No job has been requested by this preview/);
  assert.match(preview, /Request this recalculation/);
  assert.ok(preview.includes('value="csrf&lt;&amp;"'));
  assert.doesNotMatch(preview, /action="[^"]+\/preview"/);
  const read = renderMetricRecalculations("app-a", rows, "csrf", false);
  assert.doesNotMatch(read, /<form/);
  assert.match(read, /operate capability/);
  const complete = renderMetricRecalculations("app-a", [{ ...rows[0], state: "completed", replacement_metric_run_id: "run:new" }], "csrf", false);
  assert.match(complete, /run%3Anew\/explanation/);
  assert.match(renderMetricRecalculations("app-a", [{ ...rows[0], state: null, source_metric_run_id: null }], "csrf", false), /not a completed calculation/);
  for (const [method, suffix, capability, mutates] of [["GET", "", "read", false], ["POST", "/preview", "operate", false], ["POST", "", "operate", true]] as const) {
    const route = matchRoute(method, `/dashboard/apps/app-a/metric-recalculations${suffix}`)!;
    assert.equal(route.auth, "dashboard_session"); assert.equal(route.capability, capability); assert.equal(route.mutates, mutates);
  }
});
