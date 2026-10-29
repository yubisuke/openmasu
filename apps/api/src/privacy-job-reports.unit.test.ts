import assert from "node:assert/strict";
import { it } from "node:test";
import { parsePrivacyJobRequest, projectPrivacyProgress, PrivacyJobQueryError, type PrivacyJobProgressRow } from "./privacy-job-reports.js";
import { renderPrivacyJobs } from "./dashboard/privacy-jobs.js";

it("privacy progress separates purge retries from unavailable, pending and completed replay without sensitive artifacts", () => {
  const row: PrivacyJobProgressRow = { privacy_request_id: "synthetic-request", requested_at: "2026-10-29T00:00:00.000Z",
    completed_at: null, payload_state: "processing", payload_total: "2", payload_purged: "1", payload_failed: "1",
    metric_total: "1", metric_completed: "0", metric_pending: "1", metric_failed: "0", metric_unavailable: "0" };
  const pending = projectPrivacyProgress({ ...row, subject: "forbidden", payload_ref: "forbidden" } as PrivacyJobProgressRow);
  assert.equal(pending.payload.state, "retry_pending"); assert.equal(pending.recalculation.state, "processing");
  assert.equal(pending.all_recorded_steps_completed, false); assert.ok(!JSON.stringify(pending).includes("forbidden"));
  const erased = { ...row, payload_state: "completed" as const, completed_at: "2026-10-29T00:01:00.000Z", payload_purged: "2", payload_failed: "0" };
  const unsupportedReplay = projectPrivacyProgress({ ...erased, metric_pending: "0", metric_unavailable: "1" });
  assert.deepEqual(unsupportedReplay.recalculation, {
    state: "unavailable", total: "1", completed: "0", pending: "0", failed: "0", unavailable: "1",
  });
  assert.equal(unsupportedReplay.all_recorded_steps_completed, false);
  assert.equal(projectPrivacyProgress({ ...erased, metric_total: "0", metric_pending: "0" }).recalculation.state, "not_recorded");
  const failed = projectPrivacyProgress({ ...erased, metric_pending: "0", metric_failed: "1" });
  assert.equal(failed.recalculation.state, "failed"); assert.equal(failed.all_recorded_steps_completed, false);
  assert.equal(projectPrivacyProgress({ ...erased, metric_pending: "0" }).recalculation.state, "unavailable");
  const complete = projectPrivacyProgress({ ...erased, metric_pending: "0", metric_completed: "1" });
  assert.equal(complete.all_recorded_steps_completed, true);
  const html = renderPrivacyJobs("app-synthetic", { data: [complete], has_more: true });
  assert.match(html, /Older requests exist/); assert.match(html, /All recorded steps completed/);
  assert.doesNotMatch(html, /<form|<script|javascript:/);
});

it("privacy job reads accept only a bounded list or a scoped opaque request path", () => {
  const url = (suffix = "") => new URL(`https://synthetic.invalid/v1/admin/apps/app-synthetic/privacy-jobs${suffix}`);
  assert.equal(parsePrivacyJobRequest(url()), undefined);
  assert.equal(parsePrivacyJobRequest(url("/request%3Asynthetic")), "request:synthetic");
  for (const suffix of ["?tenant=foreign", "?limit=10000", "/invalid%2Fsubject", "/%", `/${"a".repeat(129)}`]) {
    assert.throws(() => parsePrivacyJobRequest(url(suffix)), PrivacyJobQueryError);
  }
  const html = renderPrivacyJobs("app-synthetic", { data: [], has_more: false }, "privacy_job_not_found");
  assert.match(html, /role="alert">privacy_job_not_found/);
  assert.doesNotMatch(html, /All recorded steps completed/);
});
