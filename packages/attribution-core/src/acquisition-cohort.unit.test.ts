import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { M1B_METRIC_DEFINITIONS, SELECTED_ACQUISITION_METRIC_DEFINITIONS, validateEventPayload } from "@openmasu/contracts";
import { evaluate, sha256 } from "./evaluator.js";

type Any = Record<string, any>;

export function nativeCampaignInput(): Any {
  const input = JSON.parse(readFileSync(new URL(
    "../../../fixtures/v0.4/01-valid-install-referrer/input.json", import.meta.url,
  ), "utf8")) as Any;
  input.reconciliation_inputs = [];
  const [click, install] = input.records;
  click.payload.network = "synthetic-network";
  install.payload.country = "US";
  const revenue = structuredClone(install);
  Object.assign(revenue, {
    record_id: "revenue-native-acquisition", delivery_id: "delivery:revenue-native-acquisition",
    event_id: "event:revenue-native-acquisition", event_name: "ad_revenue",
    occurred_at: "2026-08-06T01:00:00.000Z",
    payload: { subject_scope: "installation_level", installation_id: install.payload.installation_id,
      ad_network: "synthetic-ad-network", revenue_source: "client_estimated",
      amount_unscaled: "20000000", amount_scale: 6, currency: "USD" },
  });
  input.records.push(revenue);
  input.metric_definitions = structuredClone(SELECTED_ACQUISITION_METRIC_DEFINITIONS.filter((definition) =>
    ["cohort_install_count", "cohort_ltv_d0_usd", "d0_roas"].includes(definition.metric_name)));
  const grouping = { campaign_id: "campaign-a", network: "synthetic-network", cohort_date: "2026-08-06" };
  input.cost_records = [{
    contract_version: "0.4.0", cost_record_id: "cost-native-acquisition", tenant_id: "tenant-a", app_id: "app-a",
    network: grouping.network, campaign_id: grouping.campaign_id, date: grouping.cohort_date,
    amount_unscaled: "10000000", amount_scale: 6, currency: "USD", source: "imported_reported",
    as_of: "2026-08-12T00:00:00.000Z", report_snapshot_digest: "1".repeat(64),
    dimension_digest: sha256({ campaign_id: grouping.campaign_id, network: grouping.network }),
  }];
  input.metric_evaluations = [{
    metric_run_id_prefix: "native-acquisition", input_received_at_watermark: "2026-08-12T00:00:00.000Z",
    computed_at: "2026-08-12T00:00:00.000Z", data_freshness: "complete", privacy_state: "before",
    metric_names: input.metric_definitions.map((definition: Any) => definition.metric_name), grouping,
  }];
  return input;
}

describe("native acquisition cohort connection", () => {
  it("preserves legacy recorded-dimension definitions and reproduces the native campaign gap", () => {
    const input = nativeCampaignInput();
    input.metric_definitions = structuredClone(M1B_METRIC_DEFINITIONS.filter((definition) =>
      input.metric_evaluations[0].metric_names.includes(definition.metric_name)));
    const output = evaluate(input);
    assert.equal(output.attributions[0].reason_code, "valid_install_referrer");
    assert.equal(output.metric_runs.find((run) => run.metric_name === "cohort_install_count")!.value_unscaled, "0");
  });
  it("counts the selected click campaign from a schema-conforming SDK install", () => {
    const input = nativeCampaignInput();
    for (const record of input.records) {
      const validation = validateEventPayload(record.event_name, record.payload);
      assert.equal(validation.valid, true, `${record.event_name}: ${JSON.stringify(validation.fields)}`);
    }
    const output = evaluate(input);
    assert.equal(output.attributions[0].reason_code, "valid_install_referrer");
    const values = Object.fromEntries(output.metric_runs.map((run) => [run.metric_name, run.value_unscaled]));
    assert.deepEqual(values, { cohort_install_count: "1", cohort_ltv_d0_usd: "20000000", d0_roas: "2000000" });
  });

  for (const [name, mutate] of [
    ["unknown click", (input: Any) => { input.records[1].payload.click_id = "unknown_000000000000000000"; }],
    ["expired click", (input: Any) => { input.records[0].payload.redirector_click_at = "2026-07-01T00:00:00.000Z"; }],
    ["non-authoritative click", (input: Any) => { input.records[0].payload.redirector_time_status = "missing"; delete input.records[0].payload.redirector_click_at; }],
    ["other campaign", (input: Any) => { input.records[0].payload.campaign_id = "campaign-other"; }],
    ["ambiguous click", (input: Any) => {
      input.records.push({ ...structuredClone(input.records[0]), record_id: "ambiguous-click", event_id: "ambiguous-event", delivery_id: "ambiguous-delivery" });
    }],
    ["preferred platform attribution", (input: Any) => {
      input.records[1].payload.meta_referrer_status = "decrypted";
      input.records[1].payload.meta_referrer_context = { attribution_model: "last_click", campaign_id: "meta-synthetic-other" };
    }],
  ] as const) {
    it(`does not use an ${name} as selected acquisition evidence`, () => {
      const input = nativeCampaignInput();
      mutate(input);
      for (const record of input.records) {
        const validation = validateEventPayload(record.event_name, record.payload);
        assert.equal(validation.valid, true, `${name}: ${JSON.stringify(validation.fields)}`);
      }
      const run = evaluate(input).metric_runs.find((run) => run.metric_name === "cohort_install_count")!;
      assert.equal(run.value_unscaled, "0");
    });
  }

  for (const field of ["tenant_id", "app_id"] as const) {
    it(`does not cross the ${field} boundary through a matching click_id`, () => {
      const input = nativeCampaignInput();
      const [click, ...rest] = input.records;
      const foreign = { ...input.server_context, [field]: `${input.server_context[field]}-other` };
      input.batches = [
        { server_context: foreign, records: [{ ...click, [field]: foreign[field] }] },
        { server_context: input.server_context, records: rest },
      ];
      delete input.records;
      const run = evaluate(input).metric_runs.find((run) => run.metric_name === "cohort_install_count")!;
      assert.equal(run.value_unscaled, "0");
    });
  }

  it("does not leak late click evidence or its backdated attribution into an earlier snapshot", () => {
    const input = nativeCampaignInput();
    const [click, ...rest] = input.records;
    const late = "2026-08-13T00:00:00.000Z";
    input.batches = [
      { server_context: input.server_context, records: rest },
      { server_context: { ...input.server_context, received_at: late }, records: [{ ...click, received_at: late }] },
    ];
    delete input.records;
    const earlier = evaluate(input).metric_runs;
    assert.equal(earlier.find((run) => run.metric_name === "cohort_install_count")!.value_unscaled, "0");
    const withoutLate = structuredClone(input);
    withoutLate.batches.pop();
    // Different attribution evidence is not visible before the click arrived.
    assert.deepEqual(earlier.map((run) => run.value_unscaled), evaluate(withoutLate).metric_runs.map((run) => run.value_unscaled));
    input.metric_evaluations[0].input_received_at_watermark = late;
    input.metric_evaluations[0].computed_at = late;
    assert.equal(evaluate(input).metric_runs.find((run) => run.metric_name === "cohort_install_count")!.value_unscaled, "1");
  });

  it("deduplicates SDK revenue deliveries before campaign aggregation", () => {
    const input = nativeCampaignInput();
    const expected = evaluate(input).metric_runs;
    input.records.push({ ...structuredClone(input.records[2]), record_id: "revenue-native-retry", delivery_id: "delivery:revenue-native-retry" });
    assert.deepEqual(evaluate(input).metric_runs, expected);
  });

  it("rejects selected-source meaning under a legacy or mismatched rule identity", () => {
    const input = nativeCampaignInput();
    input.metric_definitions[0].rule_bundle_hash = "0".repeat(64);
    assert.throws(() => evaluate(input), /metric_definition_series_mismatch/);
  });

  it("does not resurrect a redacted selected click during privacy recomputation", () => {
    const input = nativeCampaignInput();
    const original = evaluate(input).metric_runs;
    const privacy = JSON.parse(readFileSync(new URL("../../../fixtures/v0.4/17-redaction-recalculation/input.json", import.meta.url), "utf8"));
    input.privacy_requests = [{ ...privacy.privacy_requests[0],
      affected_records: [{ record_id: "click-1", lifecycle_status: "redacted" }] }];
    input.metric_evaluations[0].privacy_state = "after";
    const after = evaluate(input).metric_runs;
    assert.equal(after.find((run) => run.metric_name === "cohort_install_count")!.value_unscaled, "0");
    assert.equal(after[0].reproducibility_status, "redaction_affected");
    assert.notEqual(after[0].input_snapshot_id, original[0].input_snapshot_id);
  });
});
