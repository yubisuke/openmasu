export type RoasOperands = {
  readonly revenue_unscaled: string;
  readonly cost_unscaled: string;
  readonly revenue_event_count: string;
  readonly cost_row_count: string;
  readonly cohort_size: string;
  readonly last_window_end: string | null;
  readonly window_elapsed: boolean | null;
};

export type TotalNetRoasOperands = RoasOperands & {
  readonly ad_revenue_unscaled: string;
  readonly purchase_revenue_unscaled: string;
  readonly refund_deduction_unscaled: string;
  readonly purchase_event_count: string;
  readonly refund_event_count: string;
  readonly refund_reversal_unscaled?: string;
  readonly refund_reversal_event_count?: string;
};

type RoasEvidenceBase = {
  readonly calculation: "revenue_over_cost";
  readonly denominator: "cost";
  readonly metric_run_id: string;
  readonly input_snapshot_id: string;
  readonly metric_definition_version: string;
  readonly definition_digest: string;
  readonly anchor_event: string;
  readonly window: { readonly type: "elapsed" | "calendar_day"; readonly day: number; readonly boundary: "half_open" };
  readonly calendar_cohort_policy?: "cumulative_revenue_on_day_activity";
  readonly aggregation_time_zone: string;
  readonly fraud_policy: "gross" | "net";
  readonly cost_basis: "cohort_acquisition_day_current_snapshot";
  readonly cost_selection_digest: string;
  readonly fx_policy_version: string;
  readonly fx_snapshot_id: string;
  readonly target_currency: string;
  readonly target_scale: number;
  readonly rates: readonly { readonly currency: string; readonly rate_unscaled: string; readonly rate_scale: number;
    readonly effective_date?: string; readonly source?: string; readonly as_of?: string }[];
  readonly fx_conversion_snapshot?: import("@openmasu/contracts/types").OpenMasuMetricRunV04["fx_conversion_snapshot"];
  readonly rounding_mode: "half_even";
  readonly ratio_scale: number;
};

export type RoasCalculationEvidence = RoasEvidenceBase & (
  { readonly version: 1; readonly numerator: "revenue"; readonly operands: RoasOperands }
  | { readonly version: 2; readonly numerator: "total_net_revenue"; readonly operands: TotalNetRoasOperands }
  | { readonly version: 3; readonly numerator: "total_net_revenue";
      readonly refund_reversal_policy: "cancel_target_refund_at_watermark";
      readonly operands: TotalNetRoasOperands & { readonly refund_reversal_unscaled: string; readonly refund_reversal_event_count: string } }
);
