import { ACQUISITION_KPI_METRIC_DEFINITIONS, ACQUISITION_KPI_ROLES, acquisitionKpiRole } from "@openmasu/contracts/definitions";
import { sha256 } from "@openmasu/attribution-core/canonical";
type Any = Record<string, any>;

/** Input construction only. Arithmetic below is a separately hand-calculated oracle. */
export function syntheticAcquisitionKpiFixture(baseline: Any): Any {
  const input = structuredClone(baseline), records: Any[] = [];
  const click = baseline.records.find((r: Any) => r.event_name === "click");
  const install = baseline.records.find((r: Any) => r.event_name === "install");
  const ad = baseline.records.find((r: Any) => r.event_name === "ad_revenue");
  const record = (prototype: Any, id: string, occurred_at: string, payload: Any): Any => ({ ...structuredClone(prototype),
    record_id: id, delivery_id: `delivery:${id}`, event_id: `event:${id}`, occurred_at, payload,
    processing_sequence: records.length + 1 });
  for (const [group, count, hour, revenue, purchase, refund] of [
    ["a", 3, 0, "6", "8", "2"], ["b", 2, 3, "4", "3", "1"], ["organic", 1, 5, "1", "2", "0"],
  ] as const) {
    const paid = group !== "organic", clickId = `click-kpi70${group}_0000000000000000`;
    if (paid) records.push(record(click, `kpi70-click-${group}`, "2026-08-05T00:00:00.000Z", {
      ...click.payload, click_id: clickId, tracking_link_id: `kpi70-link-${group}`, campaign_id: `kpi70-${group}`,
    }));
    for (let index = 0; index < count; index++) {
      const id = `kpi70-install-${group}-${index}`, occurred = `2026-08-06T0${hour + index}:00:00.000Z`;
      const payload = { ...install.payload, installation_id: `installation:${id}`, referrer_status: paid ? "available" : "none",
        install_begin_at_server: occurred, protected_referrer_evidence_ref: `protected:referrer:${id}` };
      if (paid) payload.click_id = clickId; else delete payload.click_id;
      records.push(record(install, id, occurred, payload));
    }
    const installationId = `installation:kpi70-install-${group}-0`;
    records.push(record(ad, `kpi70-ad-${group}`, "2026-08-06T12:00:00.000Z", {
      ...ad.payload, installation_id: installationId, amount_unscaled: revenue, amount_scale: 0, currency: "USD",
    }));
    const buy = record(install, `kpi70-purchase-${group}`, "2026-08-06T13:00:00.000Z", {
      event_name: "purchase", installation_id: installationId, transaction_id: `kpi70-purchase-${group}`,
      amount_unscaled: purchase, amount_scale: 0, currency: "USD", financial_status: "settled",
    }); buy.event_name = "purchase"; records.push(buy);
    if (refund !== "0") {
      const correction = record(install, `kpi70-refund-${group}`, "2026-08-07T12:00:00.000Z", {
        event_name: "refund", installation_id: installationId, transaction_id: `kpi70-refund-${group}`,
        original_transaction_id: buy.payload.transaction_id, correction_target_record_id: buy.record_id,
        amount_unscaled: refund, amount_scale: 0, currency: "USD", financial_status: "settled",
      }); correction.event_name = "refund"; records.push(correction);
    }
  }
  input.records = records;
  input.privacy_requests = []; input.reconciliation_inputs = [];
  input.metric_definitions = structuredClone(ACQUISITION_KPI_METRIC_DEFINITIONS);
  input.fx_policy = { policy_version: "0.4.22", rate_selection: "utc_event_date_and_cost_date", target_currency: "USD",
    target_scale: 6, rounding_mode: "half_even", rates: ["2026-08-06", "2026-08-07"].map(effective_date => ({
      currency: "USD", rate_unscaled: "1", rate_scale: 0, effective_date,
      as_of: "2026-08-12T00:00:00.000Z", source: "synthetic-identity-snapshot-70",
    })) };
  input.cost_records = [["a", "10"], ["b", "4"], ["cost-only", "2"]].map(([group, amount]) => {
    const dimensions = { campaign_id: `kpi70-${group}`, network: "synthetic-network", country: "US" };
    return { contract_version: "0.4.0", cost_record_id: `kpi70-cost-${group}`, tenant_id: "tenant-a", app_id: "app-a",
      ...dimensions, date: "2026-08-06", amount_unscaled: amount, amount_scale: 0, currency: "USD",
      source: "imported_reported", as_of: "2026-08-12T00:00:00.000Z", dimension_digest: sha256(dimensions),
      report_snapshot_digest: sha256({ synthetic_group: group, amount }) };
  });
  input.metric_evaluations = ["a", "b", "organic", "cost-only"].map(group => ({
    metric_run_id_prefix: `kpi70-${group}`, metric_names: ACQUISITION_KPI_METRIC_DEFINITIONS.map(d => d.metric_name),
    input_received_at_watermark: "2026-08-16T00:00:00.000Z", computed_at: "2026-08-16T00:00:00.000Z",
    data_freshness: "complete", privacy_state: "before", grouping: { country: "US", cohort_date: "2026-08-06",
      attribution_status: group === "organic" ? "organic" : "non_organic",
      ...(group === "organic" ? {} : { campaign_id: `kpi70-${group}`, network: "synthetic-network" }) },
  }));
  return input;
}

// Roles: installs, cost, CPI, ad revenue, purchase net, total net, ad ROAS, total ROAS.
export const acquisitionKpiFixtureValues: Record<string, readonly string[]> = {
  "kpi70-a": ["3", "10000000", "3333333", "6000000", "6000000", "12000000", "600000", "1200000"],
  "kpi70-b": ["2", "4000000", "2000000", "4000000", "2000000", "6000000", "1000000", "1500000"],
  "kpi70-organic": ["1", "no_attributed_cost", "no_attributed_cost", "1000000", "2000000", "3000000", "no_attributed_cost", "no_attributed_cost"],
  "kpi70-cost-only": ["0", "2000000", "empty_cohort", "0", "0", "0", "0", "0"],
};

export function acquisitionKpiExpected(input: Any, values = acquisitionKpiFixtureValues) {
  return input.metric_evaluations.flatMap((e: Any) => e.metric_names.map((name: string) => ({
    id: `${e.metric_run_id_prefix}:${name}`, value: values[e.metric_run_id_prefix][ACQUISITION_KPI_ROLES.indexOf(acquisitionKpiRole(name)!)],
  }))).sort((a: Any, b: Any) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((r: Any) => r.value);
}

export function syntheticAcquisitionKpiCases(source: Any) {
  const single = () => { const input = structuredClone(source); input.metric_evaluations = [input.metric_evaluations[0]]; return input; };
  const empty = single(); empty.metric_evaluations[0].grouping.campaign_id = "kpi70-empty";
  const missing = single(); missing.cost_records = [];
  const zero = single(); zero.cost_records[0].amount_unscaled = "0";
  const overlap = single(), parent = structuredClone(overlap.cost_records[0]);
  delete parent.country; parent.cost_record_id = "kpi70-overlap";
  parent.dimension_digest = sha256({ campaign_id: parent.campaign_id, network: parent.network });
  // Query the parent grain so both the parent and its country child participate.
  delete overlap.metric_evaluations[0].grouping.country; overlap.cost_records.push(parent);
  const absentFx = single(); absentFx.cost_records[0].currency = "JPY";
  const costOnlyMissingRevenueFx = single(); costOnlyMissingRevenueFx.records.find((r: Any) => r.record_id === "kpi70-ad-a").payload.currency = "JPY";
  costOnlyMissingRevenueFx.metric_evaluations[0].metric_names = ["acquisition_d7_cost", "acquisition_d7_cpi", "acquisition_d7_installs"];
  const make = (name: string, input: Any, values: readonly string[]) => ({ name, input,
    expected: acquisitionKpiExpected(input, { "kpi70-a": values }) });
  return [
    { name: "kpi_two_campaigns_organic_and_cost_only_exact_saved_set", input: structuredClone(source), expected: acquisitionKpiExpected(source) },
    make("kpi_empty_cohort_never_invents_zero_CPI", empty, ["0", "no_attributed_cost", "empty_cohort", "0", "0", "0", "no_attributed_cost", "no_attributed_cost"]),
    make("kpi_missing_cost_keeps_revenue_but_not_zero_CPI", missing, ["3", "no_attributed_cost", "no_attributed_cost", "6000000", "6000000", "12000000", "no_attributed_cost", "no_attributed_cost"]),
    make("kpi_explicit_zero_cost_is_not_missing_cost", zero, ["3", "0", "0", "6000000", "6000000", "12000000", "no_attributed_cost", "no_attributed_cost"]),
    make("kpi_overlapping_cost_grains_refuse_cost_CPI_and_ROAS", overlap, ["3", "overlapping_cost_grains", "overlapping_cost_grains", "6000000", "6000000", "12000000", "overlapping_cost_grains", "overlapping_cost_grains"]),
    make("kpi_missing_cost_FX_is_undefined_not_partial", absentFx, ["3", "missing_fx_rate", "missing_fx_rate", "6000000", "6000000", "12000000", "missing_fx_rate", "missing_fx_rate"]),
    make("kpi_cost_and_installs_do_not_consume_ad_revenue_FX", costOnlyMissingRevenueFx, acquisitionKpiFixtureValues["kpi70-a"]),
  ];
}
