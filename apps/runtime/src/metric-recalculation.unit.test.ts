import assert from "node:assert/strict";
import { it } from "node:test";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { basisAcquisitionKpiDefinitions, horizonAcquisitionKpiDefinitions } from "@openmasu/contracts/definitions";
import { captureMetricComparisonContext } from "./metric-comparison.js";
import { correctionMetricNames, expandAcquisitionCompanions, normalizeMetricRecalculationRequest,
  type CorrectionCandidate } from "./metric-recalculation.js";

const request = { cost_import_run_id: "01800000-0000-7000-8000-000000000000", date_from: "2026-08-01",
  date_to: "2026-08-31", watermark: "2026-09-01T00:00:00.000Z" };
it("normalizes bounded correction requests deterministically without accepting credentials or global history", () => {
  assert.deepEqual(normalizeMetricRecalculationRequest({ ...request, metric_names: ["d7_roas", "d1_roas", "d7_roas"] }),
    { ...request, metric_names: ["d1_roas", "d7_roas"] });
  for (const mutation of [{ date_to: "2026-09-01" }, { date_from: "2026-02-30" }, { date_to: "2026-07-31" },
    { watermark: "2026-09-01" }, { cost_import_run_id: "private-invalid-value" }, { all_history: true },
    { metric_names: [] }, { metric_names: ["private-invalid-value!"] }]) {
    assert.throws(() => normalizeMetricRecalculationRequest({ ...request, ...mutation }), error =>
      error instanceof Error && error.message === "metric_recalculation_request_invalid");
  }
});

it("keeps late-input requests bounded, explicit and independent from cost receipts", () => {
  const late = { trigger_kind: "late_events", date_from: "2026-08-01", date_to: "2026-08-31",
    watermark: request.watermark, source_record_ids: ["synthetic-b", "synthetic-a", "synthetic-b"] };
  assert.deepEqual(normalizeMetricRecalculationRequest(late), { ...late, source_record_ids: ["synthetic-a", "synthetic-b"] });
  for (const mutation of [{ source_record_ids: [] }, { source_record_ids: Array(101).fill("synthetic-a") },
    { source_record_ids: ["not/an/identifier"] }, { cost_import_run_id: request.cost_import_run_id },
    { trigger_kind: "all_events" }, { date_to: "2026-09-01" }, { source_record_ids: null }]) {
    assert.throws(() => normalizeMetricRecalculationRequest({ ...late, ...mutation }), /metric_recalculation_request_invalid/);
  }
});

it("discovers input only within one explicit bounded receipt interval, never an implicit history scan", () => {
  const range = { trigger_kind: "late_events", date_from: "2026-08-01", date_to: "2026-08-31",
    watermark: request.watermark, source_received_from: "2026-08-31T00:00:00.000Z", source_received_to: request.watermark };
  assert.deepEqual(normalizeMetricRecalculationRequest(range), range);
  for (const mutation of [{ source_received_from: "2026-08-30T00:00:00.000Z" }, { source_received_to: "2026-09-02T00:00:00.000Z" },
    { source_received_from: request.watermark }, { source_record_ids: ["synthetic-a"] }, { source_received_to: "invalid" }]) {
    assert.throws(() => normalizeMetricRecalculationRequest({ ...range, ...mutation }), /metric_recalculation_request_invalid/);
  }
});

const scope = { tenantId: "tenant-synthetic-kpi", appId: "app-synthetic-kpi" };
function companionRows(provider = "synthetic-export", day?: 0 | 30): CorrectionCandidate[] {
  const grouping = { network: "synthetic-network", campaign_id: "synthetic-campaign", cohort_date: "2026-08-01" };
  const fx = { policy_version: "synthetic-fx", target_currency: "USD", target_scale: 6, rounding_mode: "half_even" as const,
    rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0, as_of: "2026-08-01T00:00:00.000Z" }] };
  const definitions = day === undefined ? basisAcquisitionKpiDefinitions("selected_imported_provider", provider) : horizonAcquisitionKpiDefinitions(day);
  return definitions.map(definition => {
    const artifact = { ...definition, metric_run_id: `synthetic:${definition.metric_name}`, input_snapshot_id: "a".repeat(64),
      grouping: { dimensions: grouping }, input_received_at_watermark: "2026-08-10T00:00:00.000Z",
      value_state: "present", value_unscaled: "1", fx_policy_version: fx.policy_version };
    const evaluation = { metric_names: [definition.metric_name], grouping, privacy_state: "after",
      input_received_at_watermark: artifact.input_received_at_watermark };
    return { metric_run_id: artifact.metric_run_id, artifact, grouping_digest: sha256(grouping),
      comparison_context: captureMetricComparisonContext(artifact, definition, fx, "after", sha256),
      replay: { version: 1, source_metric_run_id: artifact.metric_run_id, metric_definition: definition, evaluation, fx_policy: fx } };
  });
}
const seed = (row: CorrectionCandidate) => ({ metric_run_id: row.metric_run_id, replay: row.replay, safe_reason: null });

it("corrects only the selected complete horizon and never borrows D0 roles for D30 or upgrades frozen D7", () => {
  const d0 = companionRows("synthetic-export", 0), d30 = companionRows("synthetic-export", 30), candidates = [...d0, ...d30];
  for (const rows of [d0, d30]) {
    const result = expandAcquisitionCompanions(scope, candidates, [seed(rows[6])]);
    assert.equal(result.length, 8); assert.ok(result.every(row => row.safe_reason === null));
    assert.deepEqual(result.map(row => row.metric_run_id).sort(), rows.map(row => row.metric_run_id).sort());
    assert.deepEqual(correctionMetricNames([rows[6].artifact!.metric_name]), rows.map(row => row.artifact!.metric_name).sort());
  }
  assert.ok(expandAcquisitionCompanions(scope, [...d0.slice(0, 4), ...d30.slice(4)], [seed(d30[6])])
    .every(row => row.safe_reason === "unsupported_definition"));
  assert.deepEqual(correctionMetricNames(["acquisition_d7_ad_roas"]), ["acquisition_d7_ad_roas"]);
});

it("corrects all eight saved basis-KPI companions without rewriting their cutoff, FX, privacy or definitions", () => {
  const rows = companionRows(), before = structuredClone(rows);
  const result = expandAcquisitionCompanions(scope, rows, [seed(rows[6])]);
  assert.equal(result.length, 8); assert.ok(result.every(row => row.safe_reason === null));
  for (const row of result) assert.deepEqual(row.replay, before.find(value => value.metric_run_id === row.metric_run_id)!.replay);
  assert.deepEqual(rows, before);
  assert.deepEqual(correctionMetricNames([rows[6].artifact!.metric_name]), rows.map(row => row.artifact!.metric_name).sort());
  assert.deepEqual(correctionMetricNames(["acquisition_d7_ad_roas", "d7_roas"]), ["acquisition_d7_ad_roas", "d7_roas"]);
  const legacy = { metric_run_id: "synthetic-legacy", replay: null, safe_reason: null };
  assert.deepEqual(expandAcquisitionCompanions(scope, [legacy], [legacy]), [legacy]);
});

it("refuses partial or ambiguous companion pages instead of crossing saved set identity or the 100-run limit", () => {
  const rows = companionRows();
  const invalid: CorrectionCandidate[][] = [rows.slice(1), [...rows, { ...rows[0], metric_run_id: "synthetic-duplicate" }]];
  for (const change of ["provider", "snapshot", "watermark", "privacy", "fx", "grouping"]) {
    const changed = companionRows();
    const row = changed[0], replay = row.replay!, artifact = row.artifact!;
    if (change === "provider") replay.metric_definition.import_provider = "synthetic-other";
    if (change === "snapshot") artifact.input_snapshot_id = "b".repeat(64);
    if (change === "watermark") artifact.input_received_at_watermark = replay.evaluation.input_received_at_watermark = "2026-08-11T00:00:00.000Z";
    if (change === "privacy") replay.evaluation.privacy_state = "before";
    if (change === "fx") replay.fx_policy = { ...replay.fx_policy, policy_version: "synthetic-other-fx" };
    if (change === "grouping") {
      replay.evaluation = { ...replay.evaluation, grouping: { ...replay.evaluation.grouping, country: "JP" } };
      artifact.grouping = { dimensions: replay.evaluation.grouping }; row.grouping_digest = sha256(replay.evaluation.grouping);
    }
    row.comparison_context = captureMetricComparisonContext(artifact as any, replay.metric_definition, replay.fx_policy,
      replay.evaluation.privacy_state, sha256);
    invalid.push(changed);
  }
  for (const candidates of invalid) {
    const result = expandAcquisitionCompanions(scope, candidates, [seed(candidates.find(row => row.metric_run_id === rows[6].metric_run_id)!)]);
    assert.ok(result.length > 0 && result.every(row => row.safe_reason === "unsupported_definition"));
  }
  assert.throws(() => expandAcquisitionCompanions(scope, Array(101).fill(rows[0]), [seed(rows[0])]), /selection_limit/);
});

it("keeps the entire companion set unavailable when replay, source availability or pending state blocks one role", () => {
  for (const [field, value, reason] of [["replay", null, "replay_unavailable"],
    ["evidence_unavailable", true, "input_unavailable"], ["pending", true, "already_pending"]] as const) {
    const rows = companionRows(); (rows[0] as Record<string, unknown>)[field] = value;
    const result = expandAcquisitionCompanions(scope, rows, [seed(rows[6])]);
    assert.equal(result.length, 8); assert.ok(result.every(row => row.safe_reason === reason));
  }
});
