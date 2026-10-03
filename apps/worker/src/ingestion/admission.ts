import { type CandidateAttempt } from "@openmasu/attribution-core";
import { validateEventPayload } from "@openmasu/contracts/validation";
import type { Any, PayloadAdmissionFailure } from "./model.js";

export function schemaInvalidArtifacts(attempt: CandidateAttempt): PayloadAdmissionFailure | undefined {
  const validation = validateEventPayload(attempt.record.event_name, attempt.record.payload);
  if (validation.valid) return undefined;
  const purpose = (attempt.server.processing_purposes ?? []).find(
    (entry: Any) => entry.processing_purpose_id === attempt.record.processing_purpose_id,
  );
  const withdrawal = (attempt.server.withdrawals ?? []).find(
    (entry: Any) => entry.processing_purpose_id === attempt.record.processing_purpose_id,
  );
  const consentReason = !purpose?.consent_required
    ? "consent_not_required"
    : !withdrawal || Number(attempt.record.processing_sequence) < Number(withdrawal.withdrawal_recognized_sequence)
      ? "consent_valid_before_withdrawal"
      : "consent_withdrawn";
  const common = {
    contract_version: "0.4.0",
    delivery_id: attempt.record.delivery_id,
    record_id: attempt.record.record_id,
    tenant_id: attempt.server.tenant_id,
    app_id: attempt.server.app_id,
    payload_disposition: "discarded",
    ...(attempt.record.processing_purpose_id ? { processing_purpose_id: attempt.record.processing_purpose_id } : {}),
    consent_evaluation_policy_version: purpose?.policy_version ?? "not-applicable",
    consent_decision_reason_code: consentReason,
    ...(withdrawal?.withdrawal_recognized_at ? { withdrawal_recognized_at: withdrawal.withdrawal_recognized_at } : {}),
    reason_code: "payload_schema_invalid",
  } as const;
  return {
    delivery: {
      ...common,
      received_at: attempt.record.received_at,
      ingestion_status: "rejected",
      duplicate_resolution: "unique",
      timeliness: attempt.record.late ? "late" : "on_time",
      clock_skew_suspected: false,
    },
    rejection: {
      ...common,
      reason_code_version: "0.4.0",
      retained: "non_identifying_metadata",
    },
    failure: {
      record_id: attempt.record.record_id,
      delivery_id: attempt.record.delivery_id,
      fields: validation.fields,
    },
  };
}

export function runtimeInput(attempts: readonly CandidateAttempt[]): Any {
  return {
    contract_version: "0.4.0",
    batches: attempts.map((attempt, index) => ({
      batch_id: attempt.batch_id || `runtime-batch-${index}`,
      server_context: attempt.server,
      records: [attempt.record],
    })),
    fx_policy: {
      policy_version: "runtime-no-fx-v0.2",
      target_currency: "USD",
      target_scale: 6,
      rounding_mode: "half_even",
      rates: [],
    },
    metric_evaluations: [],
    reconciliation_inputs: [],
    privacy_requests: [],
  };
}
