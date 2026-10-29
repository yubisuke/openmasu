import assert from "node:assert/strict";
import { it } from "node:test";
import { costJoinabilityLimits, parseCostJoinabilityQuery, projectCostJoinability,
  type AcquisitionDimensions, type JoinabilityCost } from "./cost-joinability.js";
import { renderCostJoinability } from "./dashboard/cost-joinability.js";

const acquisition: AcquisitionDimensions = { date: "2026-08-06", status: "non_organic", network: "synthetic-network",
  campaign_id: "same-name", ad_group_id: "group-a", creative_id: "creative-a", country: "JP" };
const cost: JoinabilityCost = { ...acquisition, network: "synthetic-network", tenant_id: "tenant-synthetic", app_id: "app-synthetic",
  cost_record_id: "cost-a", as_of: "2026-08-10T00:00:00.000Z" };
const selection = { date_from: "2026-08-06", date_to: "2026-08-07", watermark_at_most: "2026-08-12T00:00:00.000Z" };

it("cost joinability requires a closed bounded UTC selection, not identifying filters", () => {
  assert.deepEqual(parseCostJoinabilityQuery(new URLSearchParams(selection)), selection);
  for (const query of [new URLSearchParams({ ...selection, installation_id: "synthetic" }),
    new URLSearchParams({ ...selection, date_to: "2026-10-01" }),
    new URLSearchParams({ ...selection, date_from: "2026-02-30" }),
    new URLSearchParams({ ...selection, watermark_at_most: "2026-08-12" }),
    new URLSearchParams(new URLSearchParams(selection).toString() + "&date_from=2026-08-06")]) {
    assert.throws(() => parseCostJoinabilityQuery(query));
  }
});

it("dimension observations retain date network and parent identity without inferring bindings", () => {
  assert.ok(projectCostJoinability([acquisition], [cost]).dimensions.every(row => row.both_observed_exact_key === 1));
  const missingCreative = projectCostJoinability([{ ...acquisition, creative_id: null }], [cost])
    .dimensions.find(row => row.dimension === "creative_id")!;
  assert.equal(missingCreative.missing_acquisition_dimension, 1);
  assert.equal(missingCreative.both_observed_exact_key, 0);
  for (const changed of [{ network: "other-network" }, { date: "2026-08-07" }]) {
    const report = projectCostJoinability([acquisition], [{ ...cost, ...changed }]);
    assert.ok(report.dimensions.every(row => row.both_observed_exact_key === 0));
    assert.equal(report.dimensions.find(row => row.dimension === "campaign_id")!.state, "no_exact_key_match");
  }
  const child = projectCostJoinability([acquisition], [{ ...cost, ad_group_id: "other-group" }]);
  assert.equal(child.dimensions.find(row => row.dimension === "creative_id")!.both_observed_exact_key, 0);
  const missing = projectCostJoinability([{ ...acquisition, creative_id: null }], [cost]);
  assert.equal(missing.dimensions.find(row => row.dimension === "creative_id")!.missing_acquisition_dimension, 1);
  assert.equal(missing.dimensions.find(row => row.dimension === "creative_id")!.cost_only, 1);
  assert.ok(projectCostJoinability([], []).dimensions.every(row => row.state === "neither_observed"));
});

it("parent and selected child coverage remain distinct and latest revision cannot revive full-looking history", () => {
  const parent = { ...cost, cost_record_id: "parent", ad_group_id: null, creative_id: null };
  const selected = { ...cost, coverage_scope: "matching_detail_only" as const, as_of: "2026-08-11T00:00:00.000Z", cost_record_id: "selected" };
  const report = projectCostJoinability([acquisition], [parent, cost, selected]);
  assert.equal(report.current_cost_rows, 2);
  assert.equal(report.coverage.parent_grain, 1); assert.equal(report.coverage.coverage_not_declared, 1);
  assert.equal(report.coverage.selected_child_requires_exact_detail, 1);
  assert.equal(report.coverage.overlapping_unrestricted_grains, false, "restricted revision does not revive the previous unrestricted child");
  assert.equal(projectCostJoinability([acquisition], [parent, cost]).coverage.overlapping_unrestricted_grains, true);
  assert.equal(projectCostJoinability([], [{ ...cost, reporting_time_zone: "Asia/Tokyo" }]).coverage.reporting_time_zone_not_utc, 1);
  assert.throws(() => projectCostJoinability(Array(costJoinabilityLimits.rows + 1).fill(acquisition), []), /source_limit/);
  assert.throws(() => projectCostJoinability([], Array(costJoinabilityLimits.rows + 1).fill(cost)), /source_limit/);
});

it("cost joinability HTML is inert and labels current empty receipts separately from cutoff costs", () => {
  const report = { ...projectCostJoinability([acquisition], [cost]), selection: { ...selection, app_id: "app-synthetic", time_zone: "UTC" as const },
    acquisition_basis: "selected_first_party_click" as const, privacy: "current" as const, upstream_completeness: "unknown" as const,
    saved_metric_reasons: [{ reason: "no_attributed_cost", count: 1 }],
    current_receipts: { temporal_scope: "current_not_as_of_cutoff" as const, data: [{ cost_schedule_id: "schedule-synthetic", state: "scheduled",
      last_outcome: "empty", last_row_count: 0, last_since: "2026-08-06", last_until: "2026-08-07", last_success_at: "2026-08-13T00:00:00.000Z",
      safe_reason: null, provider: "google_ads", grain: "ad", coverage: "explicit_selection", creative_binding: "operator_explicit" }] } };
  const html = renderCostJoinability("app-<synthetic>", report);
  assert.match(html, /empty response preserves older cost/); assert.match(html, /no_attributed_cost/);
  assert.match(html, /not historical cutoff evidence/); assert.match(html, /Upstream completeness remains unknown/);
  assert.doesNotMatch(html, /<script\b|javascript:|\son[a-z]+=/i);
  assert.doesNotMatch(html, /installation_id|click_id|same-name|creative-a/);
});
