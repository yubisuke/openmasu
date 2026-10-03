import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { normalizeMetricScheduleReplacement } from "./metric-schedule-replacements.js";
import { metricScheduleReplacementFormRequest } from "./dashboard/metric-schedules.js";
import { matchRoute } from "./routes.js";

const schedule = JSON.parse(readFileSync("examples/synthetic/metric-schedule.json", "utf8"));
const now = new Date("2026-08-10T00:00:00.000Z");
const source = { source_metric_run_id: "scheduled:synthetic:d7_roas", calculation_key_digest: "a".repeat(64) };

it("requires an explicit replacement mode and full source keys, never name-only supersession", () => {
  const body = { mode: "same_meaning", schedule, supersessions: [source] };
  assert.deepEqual(normalizeMetricScheduleReplacement(body, now), normalizeMetricScheduleReplacement(body, now));
  for (const invalid of [{ schedule }, { ...body, mode: "automatic" }, { ...body, mode: "new_series" },
    { ...body, supersessions: [{ metric_name: "d7_roas" }] }, { ...body, supersessions: [source, source] },
    { ...body, supersessions: [{ ...source, calculation_key_digest: "missing" }] }, { ...body, tenant_id: "other" }]) {
    assert.throws(() => normalizeMetricScheduleReplacement(invalid, now), /metric_schedule_/);
  }
});

it("shares closed replacement form decoding and administer-only routes without auto-selecting sources", () => {
  const body = { mode: "same_meaning", schedule, supersessions: [] };
  const form = new URLSearchParams({ csrf_token: "synthetic", request_json: JSON.stringify(body), preview_digest: "b".repeat(64) });
  assert.deepEqual(metricScheduleReplacementFormRequest(form), { ...body, preview_digest: "b".repeat(64) });
  form.append("supersession", JSON.stringify(source));
  assert.deepEqual(metricScheduleReplacementFormRequest(form), { ...body, preview_digest: "b".repeat(64), supersessions: [source] });
  form.append("request_json", "{}"); assert.throws(() => metricScheduleReplacementFormRequest(form), /form_invalid/);
  for (const prefix of ["/v1/admin", "/dashboard"]) {
    for (const action of ["preview-replacement", "replace"]) {
      const route = matchRoute("POST", `${prefix}/apps/app-a/metric-schedules/metric-schedule%3Atest/${action}`)!;
      assert.equal(route.capability, "administer");
      assert.equal(route.auth, prefix === "/dashboard" ? "dashboard_session" : "admin_bearer");
    }
  }
});
