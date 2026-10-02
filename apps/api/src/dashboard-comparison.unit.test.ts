import assert from "node:assert/strict";
import { it } from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { comparisonWorkflowLimits as limits, readComparisonSubmission, boundedComparisonOutput, validateComparisonPair } from "./dashboard-comparison.js";
import { renderComparisonWorkflow } from "./dashboard/comparison-workflow.js";
import { compareSnapshots, comparisonDigest } from "./cohort-comparison.js";

const scope = { tenantId: "synthetic-tenant", appId: "synthetic-app" };
const snapshot = () => ({ source: "synthetic <script>not markup</script>", conditions: { date_from: "2026-01-01", date_to: "2026-01-02", time_zone: "UTC",
  maturity: "unknown", aggregation: "cumulative", attribution_scope: "all", metric_definition: "synthetic-ratio", source_cutoff: "2026-01-10T00:00:00Z" },
  rows: [{ key: '{"cohort_date":"2026-01-01"}', currency: "none", scale: 6, state: "present", value: "0" }] });
const mapping = () => ({ version: 1, source: "synthetic-csv", conditions: snapshot().conditions,
  grouping: { cohort_date: { column: "day" } }, value: { column: "ratio", input: "decimal", scale: 6, currency: { constant: "none" } } });
function review() {
  const form = new FormData(); form.set("csrf_token", "synthetic-token"); form.set("action", "review");
  form.set("saved_json", new File([JSON.stringify(snapshot())], "never-display-private-filename.json"));
  form.set("external_csv", new File(["day,ratio,unused\n2026-01-01,0,never-retain-unused-value\n"], "external.csv"));
  form.set("mapping_json", new File([JSON.stringify(mapping())], "mapping.json")); return form;
}
async function message(form: FormData): Promise<IncomingMessage> {
  const request = new Request("http://synthetic.invalid", { method: "POST", body: form });
  const bytes = Buffer.from(await request.arrayBuffer()), stream = Readable.from([bytes]) as IncomingMessage;
  stream.headers = { "content-type": request.headers.get("content-type")!, "content-length": String(bytes.length) }; return stream;
}
const read = async (form: FormData) => readComparisonSubmission(await message(form), scope, token => token === "synthetic-token", performance.now() + limits.milliseconds);

it("reviews only normalized aggregates, escapes them, and leaves opt-in unchecked", async () => {
  const submission = await read(review()); assert.equal(submission.action, "review"); assert.equal(submission.allowExternalDeclaration, false);
  const html = renderComparisonWorkflow(scope.appId, "synthetic-token", submission);
  assert.match(html, /No numerical comparison has been performed/); assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|javascript:|never-retain-unused-value|never-display-private-filename| checked/);
  assert.equal(submission.right.mapping_provenance?.interpretation, "operator_declared");
  const result = compareSnapshots(submission.left, submission.right);
  assert.equal(result.status, "incomparable");
  const resultHtml = renderComparisonWorkflow(scope.appId, "synthetic-token", submission, result, true);
  assert.match(resultHtml, /name="external_opt_in" value="yes"/); assert.match(resultHtml, /No numerical comparison/);
});
it("validates every resubmitted snapshot and limits action, fields, field kinds and CSRF", async () => {
  const form = new FormData(); form.set("action", "json"); form.set("csrf_token", "synthetic-token");
  form.set("left", JSON.stringify(snapshot())); form.set("right", JSON.stringify(snapshot())); form.set("external_opt_in", "yes");
  assert.equal((await read(form)).allowExternalDeclaration, true);
  form.set("external_opt_in", "true"); await assert.rejects(read(form), /invalid_opt_in/);
  form.delete("external_opt_in"); form.set("left", "private bad json"); await assert.rejects(read(form), /invalid_json/);
  const duplicate = review(); duplicate.append("csrf_token", "synthetic-token"); await assert.rejects(read(duplicate), /invalid_fields/);
  const unknown = review(); unknown.set("private-field", "private-value"); await assert.rejects(read(unknown), /invalid_fields/);
  const wrongCsrf = review(); wrongCsrf.set("csrf_token", "wrong"); await assert.rejects(read(wrongCsrf), /csrf_rejected/);
  const wrongFile = review(); wrongFile.set("external_csv", "not a file"); await assert.rejects(read(wrongFile), /file_required/);
  const invalidUtf8 = review(); invalidUtf8.set("external_csv", new File([new Uint8Array([0xff])], "bad.csv")); await assert.rejects(read(invalidUtf8), /invalid_utf8/);
  const badCsv = review(); badCsv.set("external_csv", new File(["day,ratio\n2026-01-01,private-value\n"], "bad.csv"));
  await assert.rejects(read(badCsv), error => error instanceof Error && error.message === "comparison_csv_number_invalid");
});
it("enforces input request output and time bounds with safe errors and no partial result", async () => {
  const large = review(); large.set("saved_json", new File([" ".repeat(limits.inputBytes + 1)], "too-large.json"));
  await assert.rejects(read(large), /input_limit/);
  const request = await message(review()); request.headers["content-length"] = String(limits.requestBytes + 1);
  await assert.rejects(readComparisonSubmission(request, scope, () => true, performance.now() + 1000), /request_limit/);
  const expired = await message(review());
  await assert.rejects(readComparisonSubmission(expired, scope, () => true, performance.now() - 1), /timeout/);
  const interrupted = Readable.from((async function* () { yield Buffer.from("partial"); throw Error("private stream exception"); })()) as IncomingMessage;
  interrupted.headers = { "content-type": "multipart/form-data; boundary=synthetic" };
  await assert.rejects(readComparisonSubmission(interrupted, scope, () => true, performance.now() + 1000), /comparison_interrupted/);
  const slow = new Readable({ read() {} }) as IncomingMessage; slow.headers = { "content-type": "multipart/form-data; boundary=synthetic" };
  await assert.rejects(readComparisonSubmission(slow, scope, () => true, performance.now() + 15), /comparison_timeout/);
  assert.ok(slow.destroyed);
  assert.throws(() => boundedComparisonOutput("x".repeat(limits.outputBytes + 1), performance.now() + 1000), /output_limit/);
});
it("rejects a valid foreign acquisition receipt without certifying receipt-less uploads", () => {
  const base = snapshot(); base.conditions.source_cutoff = "2026-01-10T00:00:00.000000Z";
  const runs = [{ key: base.rows[0].key, metric_run_id: "synthetic-run", input_snapshot_id: "a".repeat(64) }];
  const foreign = { tenant_id: "other-tenant", app_id: scope.appId }, filters = { metric_definition_version: null, grouping: {} };
  const captured = { ...base, provenance: { report_sha256: "b".repeat(64), runs }, acquisition: { version: 1, state: "complete", method: "postgres_repeatable_read",
    scope: foreign, filters, row_count: 1, selection_sha256: comparisonDigest(runs), query_sha256: comparisonDigest({ scope: foreign, filters, conditions: base.conditions }), upstream_completeness: "unknown" } };
  assert.throws(() => validateComparisonPair(captured, base, scope), /scope_mismatch/);
  const pair = validateComparisonPair(base, base, scope); assert.equal(pair.left.acquisition, undefined);
});
