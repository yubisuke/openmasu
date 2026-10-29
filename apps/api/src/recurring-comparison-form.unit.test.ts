import assert from "node:assert/strict";
import { it } from "node:test";
import { jcs } from "@openmasu/attribution-core/canonical";
import { parseComparisonRegistration, recurringComparisonResult } from "@openmasu/runtime/recurring-comparisons";
import { syntheticComparisonRegistration } from "../../../tools/synthetic-recurring-comparison.js";
import { confirmedComparisonForm, previewComparisonForm } from "./recurring-comparison-form.js";
import { renderComparisonFormPreview, renderRecurringComparisons } from "./dashboard/recurring-comparisons.js";

const scope = { tenantId: "tenant-synthetic", appId: "app-a" };
function registrationForm(registration = syntheticComparisonRegistration()) {
  const form = new FormData();
  form.set("csrf_token", "synthetic-csrf"); form.set("action", "register");
  for (const name of ["name", "first_date", "last_date", "watermark_lag_days", "retention_days", "mode"] as const) form.set(name, String(registration[name]));
  form.set("supersedes_id", "");
  form.set("threshold_value_unscaled", registration.threshold.value_unscaled); form.set("threshold_scale", String(registration.threshold.scale));
  for (const side of ["left", "right"] as const) form.set(`${side}_snapshot`, new Blob([jcs(registration[`${side}_snapshot`])]), `${side}.json`);
  return form;
}
it("typed recurring forms preserve the JSON service command and review without storing", async () => {
  const registration = syntheticComparisonRegistration(), parsed = parseComparisonRegistration(registration);
  const preview = await previewComparisonForm(registrationForm(), scope, []);
  assert.equal(jcs(preview.command), jcs({ action: "register", registration }));
  assert.equal(preview.resultState, recurringComparisonResult(parsed.definition, parsed.definition.first_date, parsed.left, parsed.right).state);
  const confirmation = new FormData(); confirmation.set("csrf_token", "synthetic-csrf");
  confirmation.set("command", jcs(preview.command)); confirmation.set("confirmation_digest", preview.digest);
  assert.deepEqual(confirmedComparisonForm(confirmation), preview.command);
  confirmation.set("confirmation_digest", "0".repeat(64));
  assert.throws(() => confirmedComparisonForm(confirmation), /comparison_confirmation_mismatch/);
  const html = renderComparisonFormPreview("app-a", "synthetic-csrf", preview);
  assert.match(html, /No revision, input or result has been stored/);
  assert.match(html, /source_cutoff/); assert.match(html, /window_elapsed/);
  assert.doesNotMatch(html, /<script|javascript:|\son\w+=/i);
  const page = renderRecurringComparisons("app-a", { plans: [], runs: [] }, "synthetic-csrf", true);
  assert.match(page, /name="left_snapshot"/); assert.doesNotMatch(page, /textarea|Command JSON/);
});
it("typed recurring preview uses existing meaning, maturity, bounds and exact fields", async () => {
  const changed = syntheticComparisonRegistration();
  changed.right_snapshot.conditions.attribution_scope = "organic";
  assert.equal((await previewComparisonForm(registrationForm(changed), scope, [])).resultState, "incomparable");
  const immature = syntheticComparisonRegistration(); immature.watermark_lag_days = 1;
  for (const snapshot of [immature.left_snapshot, immature.right_snapshot]) {
    snapshot.conditions.source_cutoff = "2026-08-02T00:00:00.000000Z";
  }
  // Even a syntactically valid declaration cannot become a mature threshold decision.
  const immatureForm = registrationForm(immature);
  assert.equal((await previewComparisonForm(immatureForm, scope, [])).resultState, "incomparable");
  const excessive = registrationForm(); excessive.set("retention_days", "91");
  await assert.rejects(previewComparisonForm(excessive, scope, []), /comparison_settings_invalid/);
  const duplicate = registrationForm(); duplicate.append("name", "other");
  await assert.rejects(previewComparisonForm(duplicate, scope, []), /comparison_input_invalid/);
  const raw = registrationForm(); raw.set("left_snapshot", new Blob(["not json"]), "bad.json");
  await assert.rejects(previewComparisonForm(raw, scope, []), /comparison_invalid_json/);
});
