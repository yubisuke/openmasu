import { sha256 } from "./canonical.js";
import { attemptEvidenceKey, decisionFor } from "./candidates.js";
import { consentDecision, isLegacyExplicitRefund, resolveRefundTarget } from "./ingestion-decisions.js";
import { sortByKey } from "./evaluation-utils.js";
import { CONTRACT_VERSION, type Any, type Attempt, type Correction, type Decisions, type Delivery, type EvaluationOutput, type IngestionDecision, type LifecycleStatus, type LogicalEvent, type PreIngestionDecision, type PrivacyRequest, type PrivacyTombstone, type RawRecord, type RejectedDecision, type Rejection } from "./evaluation-model.js";

function makeRawRecord(attempt: Attempt, lifecycle: "available" | "redacted" | "purged"): RawRecord {
  const { server, record } = attempt;
  const consent = consentDecision(attempt);
  return {
    contract_version: CONTRACT_VERSION,
    record_id: record.record_id,
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    producer: record.producer,
    producer_version: record.producer_version,
    ...(record.producer_variant ? { producer_variant: record.producer_variant } : {}),
    ...(record.wrapper_version ? { wrapper_version: record.wrapper_version } : {}),
    event_id: record.event_id,
    delivery_id: record.delivery_id,
    event_name: record.event_name,
    schema_version: record.schema_version,
    payload_sha256: sha256(record.payload),
    occurred_at: record.occurred_at,
    occurred_at_source: record.occurred_at_source,
    received_at: record.received_at,
    payload_lifecycle_status: lifecycle,
    raw_payload_ref: lifecycle === "available" ? `protected:${record.record_id}` : `tombstone:${record.record_id}`,
    ...(record.integrity_verdict ? { integrity_verdict: record.integrity_verdict } : {}),
    processing_purpose_id: consent.processing_purpose_id,
    consent_evaluation_policy_version: consent.consent_evaluation_policy_version,
    consent_decision_reason_code: consent.consent_decision_reason_code,
    ...(consent.withdrawal_recognized_at ? { withdrawal_recognized_at: consent.withdrawal_recognized_at } : {}),
    ...(consent.alternative_legal_basis_id ? {
      alternative_legal_basis_id: consent.alternative_legal_basis_id,
      alternative_legal_basis_policy_version: consent.alternative_legal_basis_policy_version,
    } : {}),
  };
}

export function ingestionArtifacts(
  all: Attempt[],
  decisions: Decisions,
  preIngestionDecisions: PreIngestionDecision[],
  acceptedUnique: Attempt[],
  lifecycle: Map<string, LifecycleStatus>,
): Pick<EvaluationOutput, "raw_records" | "deliveries" | "logical_events"> {
  const conflictEvidence = all.filter((attempt) => decisionFor(decisions, attempt).reason_code === "event_id_conflict");
  const rawEvidence = [...acceptedUnique, ...conflictEvidence].filter((attempt) => !lifecycle.has(attemptEvidenceKey(attempt)));
  const logicalEvidence = acceptedUnique.filter((attempt) => !lifecycle.has(attemptEvidenceKey(attempt)));
  const raw_records = sortByKey(rawEvidence.map((attempt) => makeRawRecord(attempt, "available")),
    (record) => [record.record_id, record.tenant_id, record.app_id, record.delivery_id]);
  const deliveries = sortByKey([...all.map((attempt): Delivery => {
    // all contains current attempts; history candidates never emit a new delivery.
    const decision = decisionFor(decisions, attempt) as IngestionDecision;
    return {
      contract_version: CONTRACT_VERSION,
      delivery_id: attempt.record.delivery_id,
      record_id: attempt.record.record_id,
      ...(decision.canonical_record_id ? { canonical_record_id: decision.canonical_record_id } : {}),
      tenant_id: attempt.server.tenant_id,
      app_id: attempt.server.app_id,
      received_at: attempt.record.received_at,
      ingestion_status: decision.ingestion_status,
      duplicate_resolution: decision.duplicate_resolution,
      timeliness: decision.timeliness,
      clock_skew_suspected: decision.clock_skew_suspected,
      payload_disposition: decision.payload_disposition,
      processing_purpose_id: decision.processing_purpose_id,
      consent_evaluation_policy_version: decision.consent_evaluation_policy_version,
      consent_decision_reason_code: decision.consent_decision_reason_code,
      ...(decision.withdrawal_recognized_at ? { withdrawal_recognized_at: decision.withdrawal_recognized_at } : {}),
      ...(decision.alternative_legal_basis_id ? {
        alternative_legal_basis_id: decision.alternative_legal_basis_id,
        alternative_legal_basis_policy_version: decision.alternative_legal_basis_policy_version,
      } : {}),
      ...(decision.reason_code ? { reason_code: decision.reason_code } : {}),
      ...(decision.reason_code === "timestamp_stale" ? {
        staleness_policy_version: decision.staleness_policy_version,
        staleness_policy_digest: decision.staleness_policy_digest,
        staleness_authority: decision.staleness_authority,
      } : {}),
    };
  }), ...preIngestionDecisions.map((decision): Delivery => ({
    contract_version: CONTRACT_VERSION,
    delivery_id: decision.delivery_id,
    record_id: decision.record_id,
    tenant_id: decision.tenant_id,
    app_id: decision.app_id,
    received_at: decision.received_at,
    ingestion_status: decision.ingestion_status,
    duplicate_resolution: decision.duplicate_resolution,
    timeliness: decision.timeliness,
    clock_skew_suspected: decision.clock_skew_suspected,
    payload_disposition: decision.payload_disposition,
    ...(decision.processing_purpose_id ? { processing_purpose_id: decision.processing_purpose_id } : {}),
    consent_evaluation_policy_version: decision.consent_evaluation_policy_version,
    consent_decision_reason_code: decision.consent_decision_reason_code,
    reason_code: decision.reason_code,
  }))], (delivery) => [delivery.delivery_id, delivery.record_id, delivery.tenant_id, delivery.app_id]);
  const logical_events = sortByKey(logicalEvidence.map((attempt): LogicalEvent => ({
    contract_version: CONTRACT_VERSION,
    logical_event_id: `logical:${attempt.server.tenant_id}:${attempt.server.app_id}:${attempt.record.producer}:${attempt.record.event_id}`,
    record_id: attempt.record.record_id,
    tenant_id: attempt.server.tenant_id,
    app_id: attempt.server.app_id,
    producer: attempt.record.producer,
    event_id: attempt.record.event_id,
    event_name: attempt.record.event_name,
    record_lifecycle: "active",
    timeliness: attempt.record.late ? "late" : "on_time",
  })), (event) => [event.logical_event_id, event.tenant_id, event.app_id]);
  return { raw_records, deliveries, logical_events };
}

export function privacyArtifacts(
  input: Any,
  acceptedUnique: Attempt[],
  acceptedCandidates: readonly Attempt[],
): Pick<EvaluationOutput, "corrections" | "privacy_requests" | "privacy_tombstones"> {
  const corrections: Correction[] = [...(input.correction_inputs ?? [])];
  for (const attempt of acceptedUnique.filter((entry) => entry.record.event_name === "refund")) {
    const legacy = isLegacyExplicitRefund(attempt);
    if (!legacy && attempt.record.payload.financial_status !== "settled") continue;
    const correctsRecordId = legacy
      ? attempt.record.payload.correction_target_record_id
      : resolveRefundTarget(attempt, acceptedCandidates)?.record.record_id;
    if (typeof correctsRecordId !== "string") continue;
    corrections.push({
      contract_version: CONTRACT_VERSION,
      tenant_id: attempt.server.tenant_id,
      app_id: attempt.server.app_id,
      correction_id: `correction:${attempt.record.record_id}`,
      corrects_record_id: correctsRecordId,
      correction_type: "correction",
      correction_reason: "refund",
      effective_at: attempt.record.occurred_at,
    });
  }
  for (const request of input.privacy_requests ?? []) {
    if (request.status !== "completed") continue;
    for (const affected of request.affected_records ?? []) {
      corrections.push({
        contract_version: CONTRACT_VERSION,
        tenant_id: request.tenant_id,
        app_id: request.app_id,
        correction_id: `correction:${request.privacy_request_id}:${affected.record_id}`,
        corrects_record_id: affected.record_id,
        correction_type: "redaction",
        correction_reason: request.reason_code,
        effective_at: request.completed_at,
      });
    }
  }
  const privacyRequestValues: PrivacyRequest[] = (input.privacy_requests ?? []).map((request: Any) => ({
    contract_version: CONTRACT_VERSION,
    tenant_id: request.tenant_id,
    app_id: request.app_id,
    privacy_request_id: request.privacy_request_id,
    ...(request.deletion_subject_ref ? { deletion_subject_ref: request.deletion_subject_ref } : {}),
    ...(request.deletion_subject_digest ? { deletion_subject_digest: request.deletion_subject_digest } : {}),
    deletion_scope: request.deletion_scope,
    requested_via: request.requested_via,
    requester_auth_ref: request.requester_auth_ref,
    requested_at: request.requested_at,
    status: request.status,
    reason_code: request.reason_code,
    policy_version: request.policy_version,
    affected_records: request.affected_records,
    ...(request.completed_at ? { completed_at: request.completed_at } : {}),
  }));
  const privacy_requests = sortByKey(privacyRequestValues,
    (request) => [request.privacy_request_id, request.tenant_id, request.app_id]);
  const privacyTombstoneValues: PrivacyTombstone[] = [];
  for (const request of input.privacy_requests ?? []) {
    if (request.status !== "completed") continue;
    for (const affected of request.affected_records ?? []) {
      privacyTombstoneValues.push({
        contract_version: CONTRACT_VERSION,
        tenant_id: request.tenant_id,
        app_id: request.app_id,
        privacy_request_id: request.privacy_request_id,
        record_id: affected.record_id,
        lifecycle_status: affected.lifecycle_status,
        reason_code: request.reason_code,
        policy_version: request.policy_version,
        provenance_digest: sha256([
          request.tenant_id, request.app_id, request.privacy_request_id, affected.record_id, request.completed_at,
        ]),
        created_at: request.completed_at,
      });
    }
  }
  const privacy_tombstones = sortByKey(privacyTombstoneValues,
    (tombstone) => [tombstone.privacy_request_id, tombstone.record_id, tombstone.tenant_id, tombstone.app_id]);
  return {
    corrections,
    privacy_requests,
    privacy_tombstones,
  };
}

export function rejectionArtifacts(
  decisionsList: IngestionDecision[],
  preIngestionDecisions: IngestionDecision[],
): Rejection[] {
  const rejections = sortByKey([...decisionsList, ...preIngestionDecisions]
    .filter((decision): decision is RejectedDecision => decision.ingestion_status === "rejected")
    .map((decision): Rejection => ({
      contract_version: CONTRACT_VERSION,
      delivery_id: decision.delivery_id,
      record_id: decision.record_id,
      tenant_id: decision.tenant_id,
      app_id: decision.app_id,
      reason_code: decision.reason_code,
      reason_code_version: CONTRACT_VERSION,
      payload_disposition: decision.payload_disposition,
      retained: decision.reason_code === "event_id_conflict" ? "protected_conflict_evidence" : "non_identifying_metadata",
      processing_purpose_id: decision.processing_purpose_id,
      consent_evaluation_policy_version: decision.consent_evaluation_policy_version,
      consent_decision_reason_code: decision.consent_decision_reason_code,
      ...(decision.withdrawal_recognized_at ? { withdrawal_recognized_at: decision.withdrawal_recognized_at } : {}),
      ...(decision.reason_code === "timestamp_stale" ? {
        staleness_policy_version: decision.staleness_policy_version,
        staleness_policy_digest: decision.staleness_policy_digest,
        staleness_authority: decision.staleness_authority,
      } : {}),
    })), (rejection) => [rejection.delivery_id, rejection.record_id, rejection.tenant_id, rejection.app_id]);
  return rejections;
}
