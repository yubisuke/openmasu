export type RoasOperands = {
  readonly revenue_unscaled: string;
  readonly cost_unscaled: string;
  readonly revenue_event_count: string;
  readonly cost_row_count: string;
  readonly cohort_size: string;
  readonly last_window_end: string | null;
  readonly window_elapsed: boolean | null;
};

export type RoasCalculationEvidence = {
  readonly version: 1;
  readonly calculation: "revenue_over_cost";
  readonly numerator: "revenue";
  readonly denominator: "cost";
  readonly metric_run_id: string;
  readonly input_snapshot_id: string;
  readonly metric_definition_version: string;
  readonly definition_digest: string;
  readonly anchor_event: string;
  readonly window: { readonly type: "elapsed"; readonly day: number; readonly boundary: "half_open" };
  readonly aggregation_time_zone: string;
  readonly fraud_policy: "gross" | "net";
  readonly cost_basis: "cohort_acquisition_day_current_snapshot";
  readonly cost_selection_digest: string;
  readonly fx_policy_version: string;
  readonly fx_snapshot_id: string;
  readonly target_currency: string;
  readonly target_scale: number;
  readonly rates: readonly { readonly currency: string; readonly rate_unscaled: string; readonly rate_scale: number }[];
  readonly rounding_mode: "half_even";
  readonly ratio_scale: number;
  readonly operands: RoasOperands;
};
