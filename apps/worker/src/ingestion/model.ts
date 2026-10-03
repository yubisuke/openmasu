import type { CandidateAttempt } from "@openmasu/attribution-core";
import type { OpenMasuEvaluationOutputV04 } from "@openmasu/contracts/types";

/** Legacy envelopes remain open; closed contract artifacts cross the writer boundary. */
export type Any = Record<string, any>;
export type RawRecord = OpenMasuEvaluationOutputV04["raw_records"][number];
export type Delivery = OpenMasuEvaluationOutputV04["deliveries"][number];
export type LogicalEvent = OpenMasuEvaluationOutputV04["logical_events"][number];
export type Correction = OpenMasuEvaluationOutputV04["corrections"][number];
export type Rejection = OpenMasuEvaluationOutputV04["rejections"][number];
export type Attribution = OpenMasuEvaluationOutputV04["attributions"][number];
export type FraudDecision = OpenMasuEvaluationOutputV04["fraud_decisions"][number];
export type Reconciliation = OpenMasuEvaluationOutputV04["reconciliation"][number];

/** A compile-time proof of payload validation, not another envelope-validation policy. */
declare const validatedPayload: unique symbol;
export type PayloadValidatedAttempt = CandidateAttempt & { readonly [validatedPayload]: true };
export type PayloadValidationFailure = {
  readonly record_id: string;
  readonly delivery_id: string;
  readonly fields: readonly string[];
};
export type PayloadAdmissionFailure = {
  readonly delivery: Delivery;
  readonly rejection: Rejection;
  readonly failure: PayloadValidationFailure;
};
export type RuntimeIngestionResult = Pick<OpenMasuEvaluationOutputV04,
  "raw_records" | "deliveries" | "logical_events" | "corrections" | "rejections" |
  "attributions" | "fraud_decisions" | "reconciliation"> & {
  validation_failures: PayloadValidationFailure[];
};
