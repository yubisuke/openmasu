import type { OpenMasuEvaluationOutputV04 as EvaluationOutput } from "@openmasu/contracts/types";
export type { EvaluationOutput };

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Any = Record<string, any>;
export type RawRecord = EvaluationOutput["raw_records"][number];
export type Delivery = EvaluationOutput["deliveries"][number];
export type LogicalEvent = EvaluationOutput["logical_events"][number];
export type Correction = EvaluationOutput["corrections"][number];
export type PrivacyRequest = EvaluationOutput["privacy_requests"][number];
export type PrivacyTombstone = EvaluationOutput["privacy_tombstones"][number];
export type Attribution = EvaluationOutput["attributions"][number];
export type CostRecord = EvaluationOutput["cost_records"][number];
export type MetricDefinition = EvaluationOutput["metric_definitions"][number];
export type MetricRun = EvaluationOutput["metric_runs"][number];
export type FraudDecision = EvaluationOutput["fraud_decisions"][number];
export type Rejection = EvaluationOutput["rejections"][number];
export type Reconciliation = EvaluationOutput["reconciliation"][number];
export type EvidenceRef = Attribution["evidence_refs"][number];
export type LifecycleStatus = EvidenceRef["lifecycle_status"];

export const CONTRACT_VERSION = "0.4.0" as const;
// Rule bundles and metric definitions retain their independent v0.3 identities.
export const REFERENCE_RULE_VERSION = "0.3.0" as const;

/** Generated contract fields crossing the private decision boundary. */
export type IngestionDecision = Pick<Delivery,
  "record_id" | "delivery_id" | "tenant_id" | "app_id" | "ingestion_status" | "duplicate_resolution" |
  "timeliness" | "clock_skew_suspected" | "consent_evaluation_policy_version" | "consent_decision_reason_code"> &
  Partial<Pick<Delivery,
    "canonical_record_id" | "received_at" | "reason_code" | "processing_purpose_id" |
    "withdrawal_recognized_at" | "alternative_legal_basis_id" | "alternative_legal_basis_policy_version" |
    "staleness_policy_version" | "staleness_policy_digest" | "staleness_authority">> &
  { event_name?: RawRecord["event_name"]; allowed?: boolean; payload_disposition: Rejection["payload_disposition"] };
/** Canonical history is not a newly emitted delivery and deliberately has no invented metadata. */
export type CandidateDecision = Pick<Delivery, "ingestion_status" | "duplicate_resolution"> & Partial<IngestionDecision>;
export type PreIngestionDecision = IngestionDecision & Pick<Delivery, "received_at">;
export type RejectedDecision = IngestionDecision & Required<Pick<IngestionDecision, "reason_code">>;
export type Decisions = Map<string, IngestionDecision>;
export type ConsentDecision = Pick<Delivery, "consent_evaluation_policy_version" | "consent_decision_reason_code"> &
  Partial<Pick<Delivery, "processing_purpose_id" | "withdrawal_recognized_at" |
    "alternative_legal_basis_id" | "alternative_legal_basis_policy_version">> & { allowed: boolean };

export type CandidateHistoryState = {
  readonly payload_sha256: string;
  readonly semantic_available: boolean;
  readonly ledger_position: string;
  readonly fraud_exclusion_id?: string;
};

export type CandidateAttempt = {
  server: Any;
  record: Any;
  batch_id: string;
  /**
   * Runtime-only proof for an already accepted canonical ledger record. The
   * contract evaluator never sets this field. It lets the runtime retain
   * idempotency after protected payload removal without pretending that a
   * tombstone still contains semantic evidence.
   */
  history_state?: CandidateHistoryState;
};
export type Attempt = CandidateAttempt;
