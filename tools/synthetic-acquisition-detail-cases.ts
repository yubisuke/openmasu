import { REFUND_REVERSAL_METRIC_DEFINITIONS, DISJOINT_COST_METRIC_DEFINITIONS, SELECTED_ACQUISITION_METRIC_DEFINITIONS } from "@openmasu/contracts/definitions";
import { sha256 } from "@openmasu/attribution-core/canonical";

type Any = Record<string, any>;
export type AcquisitionDetailCase = { name: string; input: Any; expected: string[] };
// In metric_run_id order: installs, ad LTV, purchase net, total-net ROAS, ad ROAS.
const a = ["1", "20000000", "6000000", "2600000", "2000000"];
const b = ["1", "40000000", "12000000", "2600000", "2000000"];
const campaign = ["2", "30000000", "18000000", "2600000", "2000000"];
const empty = ["0", "empty_cohort", "0", "0", "0"];

export function refreshSyntheticCostDigest(cost: Any): void {
  cost.dimension_digest = sha256(Object.fromEntries(["network", "campaign_id", "ad_group_id", "creative_id", "country"]
    .filter(key => cost[key] !== undefined).map(key => [key, cost[key]])));
}

/** Shared inputs only; the three engines still calculate independently. */
export function syntheticAcquisitionDetailCases(baseline: Any): AcquisitionDetailCase[] {
  const cases: AcquisitionDetailCase[] = [];
  const add = (name: string, expected: string[], change: (input: Any) => void = () => {}) => {
    const input = structuredClone(baseline); change(input); cases.push({ name, input, expected });
  };
  const normal = [...a, ...b, ...campaign];
  add("selected-detail-keeps-independent-money-and-install-totals", normal);
  add("two-creatives-in-one-ad-group-never-collapse-cost-revisions", normal, value => {
    value.records.find((r: Any) => r.record_id === "click-63-b").payload.ad_group_id = "synthetic-group-a";
    value.cost_records[1].ad_group_id = "synthetic-group-a";
    refreshSyntheticCostDigest(value.cost_records[1]);
    value.metric_evaluations[1].grouping.ad_group_id = "synthetic-group-a";
  });
  add("missing-detail-is-unknown-not-inferred-from-an-unselected-click", [...empty, ...b, ...campaign], value => {
    const click = value.records.find((r: Any) => r.record_id === "click-63-a");
    const other = structuredClone(click);
    Object.assign(other, { record_id: "unselected-63", event_id: "unselected-63", delivery_id: "delivery:unselected-63" });
    other.payload.click_id = "unselected_0000000000063";
    value.records.push(other);
    delete click.payload.ad_group_id; delete click.payload.creative_id;
  });
  add("parent-only-cost-is-never-allocated-to-detail", [...a.slice(0,3), "no_attributed_cost", "no_attributed_cost",
    ...b.slice(0,3), "no_attributed_cost", "no_attributed_cost", ...campaign], value => {
    const parent = structuredClone(value.cost_records[0]);
    Object.assign(parent, { cost_record_id: "parent-63", amount_unscaled: "30000000" });
    delete parent.ad_group_id; delete parent.creative_id; refreshSyntheticCostDigest(parent);
    value.cost_records = [parent];
  });
  add("overlapping-parent-and-children-have-no-campaign-roas", [...a, ...b, ...campaign.slice(0,3),
    "overlapping_cost_grains", "overlapping_cost_grains"], value => {
    const parent = structuredClone(value.cost_records[0]);
    Object.assign(parent, { cost_record_id: "parent-63", amount_unscaled: "30000000" });
    delete parent.ad_group_id; delete parent.creative_id; refreshSyntheticCostDigest(parent);
    value.cost_records.push(parent);
  });
  add("another-creative-cost-does-not-fill-a-missing-detail-denominator", [...a.slice(0,3), "no_attributed_cost", "no_attributed_cost",
    ...b, ...campaign.slice(0,3), "3900000", "3000000"], value => { value.cost_records.shift(); });
  add("cost-restatement-changes-only-the-later-watermark", [...normal, ...a.slice(0,3), "1300000", "1000000"], value => {
    const cost = structuredClone(value.cost_records[0]);
    Object.assign(cost, { cost_record_id: "cost-63-restated", amount_unscaled: "20000000", as_of: "2026-08-13T00:00:00.000Z" });
    value.cost_records.push(cost);
    const evaluation = structuredClone(value.metric_evaluations[0]);
    Object.assign(evaluation, { metric_run_id_prefix: "detail63-later", input_received_at_watermark: cost.as_of, computed_at: cost.as_of });
    value.metric_evaluations.push(evaluation);
  });
  add("exact-refund-cancellation-stays-in-its-selected-creative", ["1", "20000000", "10000000", "3000000", "2000000",
    ...b, "2", "30000000", "22000000", "2733333", "2000000"], value => {
    const refund = structuredClone(value.records.find((r: Any) => r.record_id === "refund-63-a"));
    Object.assign(refund, { record_id: "reversal-63", event_id: "reversal-63", delivery_id: "delivery:reversal-63", occurred_at: "2026-08-07T00:00:00.000Z" });
    Object.assign(refund.payload, { transaction_id: "reversal-transaction-63", financial_status: "reversed", reverses_refund_record_id: "refund-63-a" });
    value.records.push(refund);
  });
  add("privacy-removed-selected-click-does-not-retain-detail-membership", [...empty, ...b,
    "1", "40000000", "12000000", "1733333", "1333333"], value => {
    value.privacy_requests = [{ contract_version: "0.4.0", tenant_id: "tenant-a", app_id: "app-a",
      privacy_request_id: "privacy-detail-63", deletion_subject_digest: "6".repeat(64), deletion_scope: "installation",
      requested_via: "tenant_admin_api", requester_auth_ref: "admin:synthetic-detail",
      requested_at: "2026-08-12T00:00:00.000Z", completed_at: "2026-08-12T00:01:00.000Z", status: "completed",
      reason_code: "privacy_deletion", policy_version: "privacy-v0.4", affected_records: [{ record_id: "click-63-a", lifecycle_status: "redacted" }] }];
    for (const evaluation of value.metric_evaluations) evaluation.privacy_state = "after";
  });
  add("legacy-profile-ignores-new-creative-cost-rows", [...campaign.slice(0,3), "no_attributed_cost", "no_attributed_cost"], value => {
    value.metric_evaluations = [value.metric_evaluations[2]];
    value.metric_definitions = value.metric_definitions.map((definition: Any) =>
      [...REFUND_REVERSAL_METRIC_DEFINITIONS, ...DISJOINT_COST_METRIC_DEFINITIONS, ...SELECTED_ACQUISITION_METRIC_DEFINITIONS]
        .find(candidate => candidate.metric_name === definition.metric_name));
  });
  add("duplicate-deliveries-do-not-inflate-detail", normal, value => {
    value.records.push(...value.records.map((record: Any) => ({ ...structuredClone(record),
      record_id: `${record.record_id}-retry`, delivery_id: `${record.delivery_id}-retry` })));
  });
  return cases;
}
