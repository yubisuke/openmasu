import { PAYER_METRIC_DEFINITIONS, PAYER_COHORT_PROFILES, payerCohortMetricDefinitions,
  DATED_FX_POLICY_VERSION, DATED_FX_RATE_SELECTION } from "@openmasu/contracts/definitions";

type Any = Record<string, any>;
export type SyntheticPayerCase = { name: string; input: Any; expected: readonly string[] };

/** Four-value vectors are hand arithmetic, not obtained from either evaluator. */
export function syntheticPayerCohortCases(nativeSource: Any, platformSource: Any): SyntheticPayerCase[] {
  const cases: SyntheticPayerCase[] = [];
  const records = (input: Any): Any[] => input.batches.flatMap((batch: Any) => batch.records);
  const select = (input: Any, profile: typeof PAYER_COHORT_PROFILES[number]) => {
    input.metric_definitions = payerCohortMetricDefinitions(profile);
    input.metric_evaluations[0].metric_names = input.metric_definitions.map((row: Any) => row.metric_name);
    return input;
  };
  const native = syntheticPayerInput(nativeSource);
  native.metric_evaluations[0].grouping = { cohort_date: "2026-08-06" };
  native.metric_evaluations[0].computed_at = native.metric_evaluations[0].input_received_at_watermark = "2026-08-13T00:00:00.000Z";
  // Two payers in three installations: USD 10 - 4 plus USD 20; the USD 20 payer is excluded.
  for (const suffix of ["nonpayer", "excluded"]) {
    const installBatch = structuredClone(native.batches.find((batch: Any) => batch.records[0].event_name === "install"));
    const install = installBatch.records[0];
    for (const key of ["record_id", "event_id", "delivery_id"]) install[key] += `:${suffix}`;
    install.payload.installation_id += `:${suffix}`;
    installBatch.batch_id += `:${suffix}`;
    if (suffix === "excluded") {
      const clickBatch = structuredClone(native.batches.find((batch: Any) => batch.records[0].event_name === "click"));
      const click = clickBatch.records[0];
      for (const key of ["record_id", "event_id", "delivery_id"]) click[key] += ":excluded";
      click.payload.click_id = "synthetic_payer_excluded_click"; click.payload.bot_prefetch = true;
      clickBatch.batch_id += ":excluded"; native.batches.push(clickBatch);
      install.payload.click_id = click.payload.click_id;
      const purchaseBatch = structuredClone(native.batches.find((batch: Any) => batch.records[0].event_name === "purchase"));
      const purchase = purchaseBatch.records[0];
      for (const key of ["record_id", "event_id", "delivery_id"]) purchase[key] += ":excluded";
      Object.assign(purchase.payload, { installation_id: install.payload.installation_id,
        transaction_id: "synthetic-excluded-purchase", amount_unscaled: "20000000" });
      delete purchase.payload.original_transaction_id;
      purchaseBatch.batch_id += ":excluded"; native.batches.push(purchaseBatch);
    }
    native.batches.push(installBatch);
  }
  for (const batch of native.batches) batch.server_context.fraud_actions_enabled = true;
  cases.push({ name: "payer_native_gross_control_counts_excluded_historical_payer", input: structuredClone(native),
    expected: ["2", "2", "666667", "13000000"] });
  select(native, "native_fraud_net");
  cases.push({ name: "payer_native_fraud_net_excludes_same_installation_from_every_operand", input: native,
    expected: ["1", "1", "500000", "6000000"] });

  for (const profile of ["platform_gross", "platform_fraud_net"] as const) {
    const platform = structuredClone(platformSource);
    platform.cost_records = [];
    const template = native.batches.find((batch: Any) => batch.records[0].event_name === "purchase");
    for (const [kind, amount] of [["purchase", "10000000"], ["refund", "4000000"]]) {
      const batch = structuredClone(template), record = batch.records[0], id = `synthetic-platform-payer-${kind}`;
      batch.batch_id = id; batch.server_context.received_at = "2026-09-29T12:00:01.000Z";
      record.record_id = id; record.event_id = `event:${id}`; record.delivery_id = `delivery:${id}`;
      record.event_name = kind; record.occurred_at = `2026-09-29T${kind === "purchase" ? "10" : "11"}:00:00.000Z`;
      record.received_at = batch.server_context.received_at;
      record.payload = { event_name: kind, installation_id: "installation:meta-66", transaction_id: `transaction:${id}`,
        amount_unscaled: amount, amount_scale: 6, currency: "USD", financial_status: "settled",
        ...(kind === "refund" ? { original_transaction_id: "transaction:synthetic-platform-payer-purchase",
          correction_target_record_id: "synthetic-platform-payer-purchase" } : {}) };
      platform.batches.push(batch);
    }
    platform.metric_evaluations = [{ ...platform.metric_evaluations[0], metric_run_id_prefix: "payer-platform",
      input_received_at_watermark: "2026-10-07T00:00:00.000Z", computed_at: "2026-10-07T00:00:00.000Z" }];
    select(platform, profile);
    const add = (name: string, expected: readonly string[], mutate: (input: Any) => void = () => {}) => {
      const input = structuredClone(platform); mutate(input); cases.push({ name: `${profile}_${name}`, input, expected });
    };
    add("selected_source_only", ["1", "1", "1000000", "6000000"]);
    add("full_refund_retains_payer", ["1", "1", "1000000", "0"], input => {
      records(input).find(row => row.event_name === "refund")!.payload.amount_unscaled = "10000000";
    });
    add("no_verified_purchase", ["0", "0", "0", "no_paying_installations"], input => {
      for (const batch of input.batches) if (["purchase", "refund"].includes(batch.records[0].event_name))
        batch.server_context.policy_digest = "synthetic-unverified";
    });
    add("missing_FX_keeps_counts", ["1", "1", "1000000", "missing_fx_rate"], input => {
      input.fx_policy = { policy_version: DATED_FX_POLICY_VERSION, rate_selection: DATED_FX_RATE_SELECTION,
        target_currency: "USD", target_scale: 6, rounding_mode: "half_even", rates: [{ currency: "EUR",
          effective_date: "2026-09-29", rate_unscaled: "1", rate_scale: 0, source: "synthetic-only",
          as_of: "2026-09-29T00:00:00.000Z" }] };
    });
    add("different_platform_has_no_payers", ["0", "0", "0", "no_paying_installations"], input => {
      input.metric_evaluations[0].grouping = { cohort_date: "2026-09-28", campaign_id: "2066", network: "apple_adservices" };
    });
    add("native_basis_never_claims_platform_campaign", ["0", "0", "empty_cohort", "no_paying_installations"], input => select(input, "native_fraud_net"));
    add("current_privacy_removes_payer_population", ["0", "0", "empty_cohort", "no_paying_installations"], input => {
      input.privacy_requests = [{ contract_version: "0.4.0", tenant_id: "tenant-a", app_id: "app-a",
        privacy_request_id: "privacy-payer-cohort", deletion_subject_digest: "7".repeat(64), deletion_scope: "installation",
        requested_via: "tenant_admin_api", requester_auth_ref: "synthetic-admin", requested_at: "2026-10-08T00:00:00.000Z",
        completed_at: "2026-10-08T00:01:00.000Z", status: "completed", reason_code: "privacy_deletion", policy_version: "privacy-v1",
        affected_records: [{ record_id: "meta-66", lifecycle_status: "redacted" }] }];
    });
  }
  return cases;
}

/** Trusted synthetic server contexts, not credentials or assertions obtained from a store. */
export function syntheticPayerInput(source: Any): Any {
  const input = structuredClone(source);
  const original = input.batches ?? [{ server_context: input.server_context, records: input.records }];
  input.batches = original.flatMap((batch: Any, index: number) => batch.records.map((record: Any, n: number) => {
    const server = structuredClone(batch.server_context);
    if (["purchase", "refund"].includes(record.event_name)) {
      record.producer = "adapter:synthetic-verified-store";
      server.policy_digest = "verified-commerce-v1";
    }
    return { batch_id: `synthetic-payer:${index}:${n}`, server_context: server, records: [record] };
  }));
  delete input.records; delete input.server_context;
  input.metric_definitions = structuredClone([...PAYER_METRIC_DEFINITIONS]);
  input.metric_evaluations = [{ metric_run_id_prefix: "payer-case", input_received_at_watermark: "2026-08-10T00:00:00.000Z",
    computed_at: "2026-08-10T00:01:00.000Z", data_freshness: "complete", privacy_state: "after",
    metric_names: PAYER_METRIC_DEFINITIONS.map(row => row.metric_name), grouping: { cohort_date: "2026-08-01" } }];
  return input;
}

export function syntheticPayerCases(source: Any, reversalSource: Any): SyntheticPayerCase[] {
  const basic = syntheticPayerInput(source), cases: SyntheticPayerCase[] = [];
  const add = (name: string, expected: readonly string[], change: (input: Any) => void = () => {}) => {
    const input = structuredClone(basic); change(input); cases.push({ name, input, expected });
  };
  const records = (input: Any) => input.batches.flatMap((batch: Any) => batch.records) as Any[];
  const cloneRecord = (input: Any, id: string, suffix: string, change: (record: Any) => void) => {
    const batch = structuredClone(input.batches.find((value: Any) => value.records[0].record_id === id));
    const record = batch.records[0];
    record.record_id += suffix; record.delivery_id += suffix; record.event_id += suffix;
    batch.batch_id += suffix; change(record); input.batches.push(batch);
  };
  add("payer_settled_only_net_money_excludes_independent_ad_revenue", ["1", "1", "1000000", "6000000"]);
  add("payer_multiple_transactions_one_installation", ["2", "1", "1000000", "11000000"], input => {
    cloneRecord(input, "purchase-55-d0", ":second", record => {
      record.payload.transaction_id = "synthetic-payer-second"; record.payload.original_transaction_id = "synthetic-payer-second";
      record.payload.amount_unscaled = "4000000";
    });
  });
  add("payer_two_payers_three_installations_and_half_even_rate", ["2", "2", "666667", "8000000"], input => {
    for (const suffix of [":b", ":c"]) cloneRecord(input, "install-55", suffix, record => { record.payload.installation_id += suffix; });
    cloneRecord(input, "purchase-55-d0", ":b", record => {
      record.payload.installation_id += ":b"; record.payload.transaction_id = "synthetic-payer-b";
      record.payload.original_transaction_id = "synthetic-payer-b";
    });
  });
  add("payer_full_refund_keeps_historical_payer_and_zero_net_arppu", ["1", "1", "1000000", "0"], input => {
    records(input).find(record => record.record_id === "refund-55-d0")!.payload.amount_unscaled = "8000000";
  });
  const partials = (input: Any) => cloneRecord(input, "refund-55-d0", ":second", record => {
    record.payload.transaction_id = "synthetic-payer-second-refund"; record.payload.amount_unscaled = "1600000";
    record.occurred_at = "2026-08-03T01:00:00.000Z"; record.received_at = "2026-08-03T01:00:01.000Z";
  });
  add("payer_multiple_partial_refunds_deduct_each_once", ["1", "1", "1000000", "4000000"], partials);
  add("payer_cancellation_restores_only_its_exact_partial_refund", ["1", "1", "1000000", "6000000"], input => {
    partials(input);
    cloneRecord(input, "refund-55-d0:second", ":cancel", record => {
      Object.assign(record.payload, { transaction_id: "synthetic-payer-cancel-second-refund", financial_status: "reversed",
        correction_target_record_id: "purchase-55-d0", reverses_refund_record_id: "refund-55-d0:second" });
      record.occurred_at = "2026-08-04T01:00:00.000Z"; record.received_at = "2026-08-04T01:00:01.000Z";
    });
  });
  add("payer_missing_dated_FX_keeps_counts_but_not_partial_money", ["1", "1", "1000000", "missing_fx_rate"], input => {
    input.fx_policy = { policy_version: DATED_FX_POLICY_VERSION, rate_selection: DATED_FX_RATE_SELECTION,
      target_currency: "USD", target_scale: 6, rounding_mode: "half_even", rates: [{ currency: "USD",
        effective_date: "2026-08-01", rate_unscaled: "1", rate_scale: 0, source: "synthetic-only",
        as_of: "2026-08-01T00:00:00.000Z" }] };
  });
  add("payer_client_claim_or_extensions_do_not_establish_store_authority", ["0", "0", "0", "no_paying_installations"], input => {
    for (const batch of input.batches) if (["purchase", "refund"].includes(batch.records[0].event_name)) {
      batch.records[0].producer = "sdk-android";
      batch.records[0].payload.extensions = { store_verification_provider: "google_play", store_verification_state: "verified" };
    }
  });
  add("payer_correct_producer_wrong_server_policy_is_unverified", ["0", "0", "0", "no_paying_installations"], input => {
    for (const batch of input.batches) batch.server_context.policy_digest = "synthetic-unverified";
  });
  add("payer_unbound_or_empty_cohort_is_not_zero_rate_or_arppu", ["0", "0", "empty_cohort", "no_paying_installations"], input => {
    input.metric_evaluations[0].grouping.cohort_date = "2026-07-31";
  });
  add("payer_settled_unbound_purchase_is_not_joined_by_campaign_or_amount", ["0", "0", "0", "no_paying_installations"], input => {
    input.batches = input.batches.filter((batch: Any) => batch.records[0].event_name !== "refund");
    records(input).find(record => record.record_id === "purchase-55-d0")!.payload.installation_id = "installation:synthetic-unbound";
  });
  add("payer_D7_upper_purchase_and_refund_window_is_exclusive", ["0", "0", "0", "no_paying_installations"], input => {
    Object.assign(records(input).find(record => record.record_id === "purchase-55-d0")!,
      { occurred_at: "2026-08-09T00:00:00.000Z", received_at: "2026-08-09T00:00:01.000Z" });
    Object.assign(records(input).find(record => record.record_id === "refund-55-d0")!,
      { occurred_at: "2026-08-09T01:00:00.000Z", received_at: "2026-08-09T01:00:01.000Z" });
  });
  add("payer_receipt_cutoff_before_purchase", ["0", "0", "0", "no_paying_installations"], input => {
    input.metric_evaluations[0].input_received_at_watermark = "2026-08-01T03:00:00.000Z";
  });
  add("payer_receipt_cutoff_includes_exact_purchase_receipt", ["1", "1", "1000000", "10000000"], input => {
    input.metric_evaluations[0].input_received_at_watermark = "2026-08-01T10:00:01.000Z";
  });
  add("payer_receipt_redelivery_is_not_another_transaction", ["1", "1", "1000000", "6000000"], input => {
    const batch = structuredClone(input.batches.find((value: Any) => value.records[0].record_id === "purchase-55-d0"));
    batch.batch_id += ":retry"; batch.records[0].record_id += ":retry"; batch.records[0].delivery_id += ":retry";
    batch.records[0].received_at = "2026-08-01T10:00:02.000Z"; batch.server_context.received_at = batch.records[0].received_at;
    input.batches.push(batch);
  });
  const reversed = syntheticPayerInput(reversalSource);
  reversed.metric_evaluations[0].grouping = { cohort_date: "2026-08-06", campaign_id: "campaign-a", network: "synthetic-network" };
  for (const [name, watermark, value] of [["payer_partial_refund_deduction", "2026-08-13T00:00:00.000Z", "6000000"],
    ["payer_exact_refund_cancellation_restores_net", "2026-08-14T00:00:00.000Z", "10000000"]]) {
    const input = structuredClone(reversed); input.metric_evaluations[0].input_received_at_watermark = watermark;
    cases.push({ name, input, expected: ["1", "1", "1000000", value] });
  }
  return cases;
}
