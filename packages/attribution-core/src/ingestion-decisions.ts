import { clickInjectionPolicyDigest } from "@openmasu/fraud-rules";
import { sha256 } from "./canonical.js";
import { attemptDecisionKey, candidatePayloadDigest, compareCandidateAttempts, decisionFor, evidenceKey, scopeKey, semanticCandidate, type CandidateProvider } from "./candidates.js";
import { compositeKey, time, TimestampInvalidError } from "./evaluation-utils.js";
import type { Any, Attempt, ConsentDecision, Decisions, Delivery, IngestionDecision, PreIngestionDecision } from "./evaluation-model.js";

export function assertImportProviderContexts(all: Attempt[]): void {
  for (const attempt of all) {
    const context = attempt.record.payload.import_context;
    if (!attempt.record.producer.startsWith("import:") || !context) continue;
    if (attempt.record.producer !== `import:${context.provider}`) {
      throw new Error("import_context.provider must match the authenticated import producer");
    }
  }
}

export function assertRevenueAnchorSources(all: Attempt[]): void {
  for (const attempt of all) {
    if (attempt.record.event_name !== "ad_revenue" || attempt.record.payload.anchor_source === undefined) continue;
    if (!attempt.record.producer.startsWith("postback:")) {
      throw new Error("ad_revenue.anchor_source is limited to authenticated S2S postback producers");
    }
  }
}

export function assertInstallationAnchors(all: Attempt[], decisions: Decisions): void {
  const anchors = new Set<string>();
  const acceptedInstalls = all.filter((entry) => semanticCandidate(entry) &&
    entry.record.event_name === "install" &&
    decisionFor(decisions, entry).ingestion_status === "accepted" &&
    decisionFor(decisions, entry).duplicate_resolution === "unique",
  );
  for (const attempt of acceptedInstalls) {
    const { server, record } = attempt;
    const payload = record.payload;
    const key = evidenceKey(server.tenant_id, server.app_id, payload.installation_id);
    if (anchors.has(key)) throw new Error(`ambiguous installation anchor: ${payload.installation_id}`);
    anchors.add(key);
    if (payload.install_type === "reinstall" || payload.install_type === "redownload") {
      if (!payload.prior_installation_id || payload.prior_installation_id === payload.installation_id) {
        throw new Error(`invalid reinstall installation anchor: ${record.record_id}`);
      }
      const prior = evidenceKey(server.tenant_id, server.app_id, payload.prior_installation_id);
      if (!acceptedInstalls.some((candidate) =>
        evidenceKey(candidate.server.tenant_id, candidate.server.app_id, candidate.record.payload.installation_id) === prior,
      )) throw new Error(`missing prior installation anchor: ${record.record_id}`);
    } else if (payload.prior_installation_id) {
      throw new Error(`first install must not name a prior installation: ${record.record_id}`);
    }
  }
}

export function assertScopedReferences(input: Any, all: readonly Attempt[]): void {
  const exists = (tenantId: string, appId: string, recordId: string) =>
    all.some((attempt) =>
      attempt.server.tenant_id === tenantId && attempt.server.app_id === appId &&
      attempt.record.record_id === recordId,
    );
  for (const request of input.privacy_requests ?? []) {
    for (const affected of request.affected_records ?? []) {
      const target = all.find((attempt) =>
        attempt.server.tenant_id === request.tenant_id && attempt.server.app_id === request.app_id &&
        attempt.record.record_id === affected.record_id,
      );
      if (!target) {
        throw new Error(`cross-scope or missing privacy reference: ${request.privacy_request_id}/${affected.record_id}`);
      }
      if (request.requested_via === "on_device_sdk" &&
          target.record.payload.installation_id !== request.deletion_subject_ref) {
        throw new Error(`on-device privacy request targets another installation: ${request.privacy_request_id}/${affected.record_id}`);
      }
    }
  }
  for (const correction of input.correction_inputs ?? []) {
    if (!exists(correction.tenant_id, correction.app_id, correction.corrects_record_id)) {
      throw new Error(`cross-scope or missing correction reference: ${correction.correction_id}`);
    }
  }
  for (const expiration of input.retention_expirations ?? []) {
    if (!exists(expiration.tenant_id, expiration.app_id, expiration.record_id)) {
      throw new Error(`cross-scope or missing retention reference: ${expiration.record_id}`);
    }
  }
  for (const attempt of all.filter(isLegacyExplicitRefund)) {
    if (!exists(
      attempt.server.tenant_id,
      attempt.server.app_id,
      attempt.record.payload.correction_target_record_id,
    )) {
      throw new Error(`cross-scope or missing refund target: ${attempt.record.record_id}`);
    }
  }
}

function canonicalPurchaseOriginalTransactionId(attempt: Attempt): string | undefined {
  if (attempt.record.event_name !== "purchase") return undefined;
  return attempt.record.payload.original_transaction_id ?? attempt.record.payload.transaction_id;
}

function receivedNoLaterThan(candidate: Attempt, refund: Attempt): boolean {
  try {
    return time(candidate.record.received_at, "received_at") <= time(refund.record.received_at, "received_at");
  } catch (error) {
    if (error instanceof TimestampInvalidError) return false;
    throw error;
  }
}

function occurredNoLaterThan(candidate: Attempt, refund: Attempt): boolean {
  try {
    return time(candidate.record.occurred_at, "occurred_at") <= time(refund.record.occurred_at, "occurred_at");
  } catch (error) {
    if (error instanceof TimestampInvalidError) return false;
    throw error;
  }
}

function isBaseAcceptedCandidate(attempt: Attempt, candidates: readonly Attempt[]): boolean {
  if (attempt.history_state) return attempt.history_state.semantic_available;
  const { server, record } = attempt;
  try {
    time(record.received_at, "received_at");
    time(record.occurred_at, "occurred_at");
    if (record.tenant_id !== server.tenant_id || record.app_id !== server.app_id) return false;
    if (candidates.filter((other) => other.record.record_id === record.record_id).length !== 1) return false;
    if (candidates.find((other) => scopeKey(other) === scopeKey(attempt)) !== attempt) return false;
    if (!consentDecision(attempt).allowed) return false;
    if (server.timestamp_stale_policy &&
        time(record.occurred_at, "occurred_at") <
          time(server.timestamp_stale_policy.before, "timestamp_stale_policy.before")) return false;
    if (record.subject_scope === "aggregate" && record.payload?.installation_id) return false;
    return true;
  } catch (error) {
    if (error instanceof TimestampInvalidError) return false;
    return false;
  }
}

function isAnchoredCommerce(attempt: Attempt): boolean {
  return (["purchase", "refund"] as string[]).includes(attempt.record.event_name) &&
    typeof attempt.record.payload.installation_id === "string";
}

export function isLegacyExplicitRefund(attempt: Attempt): boolean {
  return attempt.record.event_name === "refund" &&
    typeof attempt.record.payload.installation_id !== "string" &&
    typeof attempt.record.payload.correction_target_record_id === "string";
}

function legacyRefundTarget(refund: Attempt, candidates: readonly Attempt[]): Attempt | undefined {
  if (!isLegacyExplicitRefund(refund)) return undefined;
  return candidates.find((candidate) =>
    candidate.server.tenant_id === refund.server.tenant_id &&
    candidate.server.app_id === refund.server.app_id &&
    candidate.record.record_id === refund.record.payload.correction_target_record_id,
  );
}

function canonicalPurchaseBusinessAttempts(attempt: Attempt, candidates: readonly Attempt[]): Attempt[] {
  if (attempt.record.event_name !== "purchase" || !isAnchoredCommerce(attempt) ||
      typeof attempt.record.payload.transaction_id !== "string") return [attempt];
  return candidates.filter((candidate) =>
    candidate.record.event_name === "purchase" &&
    isAnchoredCommerce(candidate) &&
    candidate.server.tenant_id === attempt.server.tenant_id &&
    candidate.server.app_id === attempt.server.app_id &&
    candidate.record.tenant_id === candidate.server.tenant_id &&
    candidate.record.app_id === candidate.server.app_id &&
    candidate.record.payload.transaction_id === attempt.record.payload.transaction_id &&
    isBaseAcceptedCandidate(candidate, candidates),
  );
}

function canonicalPurchaseBusinessAttempt(attempt: Attempt, candidates: readonly Attempt[]): Attempt | undefined {
  const group = canonicalPurchaseBusinessAttempts(attempt, candidates);
  return group[0];
}

function strictRefundTargetCandidates(
  refund: Attempt,
  candidates: readonly Attempt[],
): Attempt[] {
  if (refund.record.event_name !== "refund") return [];
  const payload = refund.record.payload;
  if (typeof payload.installation_id !== "string") return [];
  return candidates.filter((candidate) =>
    candidate.record.event_name === "purchase" &&
    candidate.record.payload.financial_status === "settled" &&
    candidate.server.tenant_id === refund.server.tenant_id &&
    candidate.server.app_id === refund.server.app_id &&
    candidate.record.tenant_id === candidate.server.tenant_id &&
    candidate.record.app_id === candidate.server.app_id &&
    !(refund.server.refund_target_ineligible_record_ids ?? []).includes(candidate.record.record_id) &&
    receivedNoLaterThan(candidate, refund) &&
    occurredNoLaterThan(candidate, refund) &&
    candidate.record.payload.installation_id === payload.installation_id &&
    canonicalPurchaseOriginalTransactionId(candidate) === payload.original_transaction_id &&
    candidate.record.payload.currency === payload.currency &&
    isBaseAcceptedCandidate(candidate, candidates) &&
    canonicalPurchaseBusinessAttempt(candidate, candidates) === candidate,
  );
}

function resolveRefundTargetIdentity(refund: Attempt, candidates: readonly Attempt[]): Attempt | undefined {
  const explicitTarget = refund.record.payload.correction_target_record_id;
  const matches = strictRefundTargetCandidates(refund, candidates);
  if (matches.length !== 1) return undefined;
  if (typeof explicitTarget === "string" && matches[0].record.record_id !== explicitTarget) return undefined;
  return matches[0];
}

function exactMoneyAtScale(payload: Any, scale: number): bigint {
  return BigInt(payload.amount_unscaled) * (10n ** BigInt(scale - Number(payload.amount_scale)));
}

function refundBusinessKey(refund: Attempt): string {
  return compositeKey([
    refund.server.tenant_id, refund.server.app_id,
    refund.record.event_name, refund.record.payload.transaction_id,
  ]);
}

function admittedRefunds(candidates: readonly Attempt[]): {
  targets: Map<string, Attempt>;
  winners: Map<string, Attempt>;
} {
  const targets = new Map<string, Attempt>();
  const winners = new Map<string, Attempt>();
  const settledByTarget = new Map<string, Attempt[]>();
  const ordered = candidates.filter((candidate) =>
    candidate.record.event_name === "refund" && isAnchoredCommerce(candidate) &&
    typeof candidate.record.payload.transaction_id === "string" &&
    isBaseAcceptedCandidate(candidate, candidates),
  ).slice().sort(compareCandidateAttempts);
  for (const candidate of ordered) {
    const businessKey = refundBusinessKey(candidate);
    if (winners.has(businessKey)) continue;
    const target = resolveRefundTargetIdentity(candidate, candidates);
    if (!target) continue;
    const reversalTarget = candidate.record.payload.reverses_refund_record_id;
    if (reversalTarget !== undefined) {
      const prior = [...winners.values()].find((refund) =>
        refund.record.record_id === reversalTarget && refund.server.tenant_id === candidate.server.tenant_id
        && refund.server.app_id === candidate.server.app_id);
      if (!prior || candidate.record.payload.financial_status !== "reversed"
          || prior.record.payload.financial_status !== "settled"
          || targets.get(attemptDecisionKey(prior)) !== target
          || !receivedNoLaterThan(prior, candidate) || !occurredNoLaterThan(prior, candidate)) continue;
      const scale = Math.max(Number(prior.record.payload.amount_scale), Number(candidate.record.payload.amount_scale));
      if (exactMoneyAtScale(prior.record.payload, scale) !== exactMoneyAtScale(candidate.record.payload, scale)) continue;
    }
    if (candidate.record.payload.financial_status === "settled") {
      const targetKey = attemptDecisionKey(target);
      const prior = settledByTarget.get(targetKey) ?? [];
      const scale = Math.max(
        Number(target.record.payload.amount_scale),
        Number(candidate.record.payload.amount_scale),
        ...prior.map((refund) => Number(refund.record.payload.amount_scale)),
      );
      const refunded = prior.reduce(
        (sum, refund) => sum + exactMoneyAtScale(refund.record.payload, scale), 0n,
      );
      if (refunded + exactMoneyAtScale(candidate.record.payload, scale) >
          exactMoneyAtScale(target.record.payload, scale)) continue;
      settledByTarget.set(targetKey, [...prior, candidate]);
    }
    winners.set(businessKey, candidate);
    targets.set(attemptDecisionKey(candidate), target);
  }
  return { targets, winners };
}

export function resolveRefundTarget(refund: Attempt, candidates: readonly Attempt[]): Attempt | undefined {
  if (!isAnchoredCommerce(refund)) return undefined;
  return admittedRefunds(candidates).targets.get(attemptDecisionKey(refund));
}

function isControlEvent(record: Any): boolean {
  return record.event_name === "consent_changed" || record.event_name === "privacy_control";
}

export function consentDecision(attempt: Attempt): ConsentDecision {
  const { server, record } = attempt;
  const purpose = (server.processing_purposes ?? []).find(
    (entry: Any) => entry.processing_purpose_id === record.processing_purpose_id,
  );
  const withdrawal = (server.withdrawals ?? []).find(
    (entry: Any) => entry.processing_purpose_id === record.processing_purpose_id,
  );
  const base = {
    processing_purpose_id: record.processing_purpose_id,
    consent_evaluation_policy_version: purpose?.policy_version ?? "not-applicable",
    withdrawal_recognized_at: withdrawal?.withdrawal_recognized_at,
  };
  if (!record.processing_purpose_id || !purpose?.consent_required || isControlEvent(record)) {
    return { ...base, allowed: true, consent_decision_reason_code: "consent_not_required" };
  }
  if (!withdrawal || Number(record.processing_sequence) < Number(withdrawal.withdrawal_recognized_sequence)) {
    return { ...base, allowed: true, consent_decision_reason_code: "consent_valid_before_withdrawal" };
  }
  const configuredBasis = (server.alternative_legal_bases ?? []).find(
    (entry: Any) => entry.alternative_legal_basis_id === record.alternative_legal_basis_id &&
      entry.processing_purpose_id === record.processing_purpose_id &&
      time(entry.effective_at, "effective_at") <= time(record.received_at, "received_at"),
  );
  if (configuredBasis) {
    return {
      ...base,
      allowed: true,
      consent_decision_reason_code: "documented_alternative_legal_basis",
      alternative_legal_basis_id: configuredBasis.alternative_legal_basis_id,
      alternative_legal_basis_policy_version: configuredBasis.policy_version,
    };
  }
  return { ...base, allowed: false, consent_decision_reason_code: "consent_withdrawn" };
}

export function timestampInvalidDecision(attempt: Attempt): IngestionDecision {
  const { server, record } = attempt;
  const purpose = (server.processing_purposes ?? []).find(
    (entry: Any) => entry.processing_purpose_id === record.processing_purpose_id,
  );
  const withdrawal = (server.withdrawals ?? []).find(
    (entry: Any) => entry.processing_purpose_id === record.processing_purpose_id,
  );
  const consentReason = !record.processing_purpose_id || !purpose?.consent_required || isControlEvent(record)
    ? "consent_not_required"
    : !withdrawal || Number(record.processing_sequence) < Number(withdrawal.withdrawal_recognized_sequence)
      ? "consent_valid_before_withdrawal"
      : "consent_withdrawn";
  return {
    record_id: record.record_id,
    delivery_id: record.delivery_id,
    event_name: record.event_name,
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    ingestion_status: "rejected",
    duplicate_resolution: "unique",
    timeliness: "on_time",
    clock_skew_suspected: false,
    payload_disposition: "discarded",
    processing_purpose_id: record.processing_purpose_id,
    consent_evaluation_policy_version: purpose?.policy_version ?? "not-applicable",
    consent_decision_reason_code: consentReason,
    ...(withdrawal?.withdrawal_recognized_at ? { withdrawal_recognized_at: withdrawal.withdrawal_recognized_at } : {}),
    reason_code: "timestamp_invalid",
  };
}

export function preIngestionDecision(item: Any): PreIngestionDecision {
  return {
    record_id: item.record_id,
    delivery_id: item.delivery_id,
    tenant_id: item.tenant_id,
    app_id: item.app_id,
    received_at: item.received_at,
    ingestion_status: "rejected",
    duplicate_resolution: "unique",
    timeliness: "on_time",
    clock_skew_suspected: false,
    payload_disposition: "discarded",
    reason_code: item.reason_code,
    processing_purpose_id: item.processing_purpose_id,
    consent_evaluation_policy_version: item.consent_evaluation_policy_version,
    consent_decision_reason_code: item.consent_decision_reason_code,
  };
}

export function decide(attempt: Attempt, candidates: CandidateProvider): IngestionDecision {
  const { server, record } = attempt;
  if (server.timestamp_stale_policy) {
    const expectedDigest = sha256({
      before: server.timestamp_stale_policy.before,
      authority: server.timestamp_stale_policy.authority,
      policy_version: server.timestamp_stale_policy.policy_version,
    });
    if (server.timestamp_stale_policy.policy_digest !== expectedDigest) {
      throw new Error("timestamp_stale_policy.policy_digest does not match its canonical policy fields");
    }
  }
  if (server.click_injection_policy) {
    const expectedDigest = clickInjectionPolicyDigest({
      threshold_seconds: server.click_injection_policy.threshold_seconds,
      authority: server.click_injection_policy.authority,
      policy_version: server.click_injection_policy.policy_version,
    });
    if (server.click_injection_policy.policy_digest !== expectedDigest) {
      throw new Error("click_injection_policy.policy_digest does not match its canonical policy fields");
    }
  }
  const sameRecordId = candidates.byRecordId(record.record_id);
  const sameKey = candidates.byLogicalScope(attempt);
  const first = sameKey[0];
  let duplicate_resolution: Delivery["duplicate_resolution"] = sameRecordId.length > 1
    ? "record_id_collision"
    : attemptDecisionKey(first) === attemptDecisionKey(attempt)
    ? "unique"
    : candidatePayloadDigest(first) === candidatePayloadDigest(attempt)
      ? "duplicate_delivery"
      : "event_id_conflict";
  let canonicalAttempt = first;
  if (duplicate_resolution === "unique" && record.event_name === "purchase" && isAnchoredCommerce(attempt)) {
    const business = canonicalPurchaseBusinessAttempts(attempt, candidates.all());
    const businessFirst = business[0];
    if (businessFirst && attemptDecisionKey(businessFirst) !== attemptDecisionKey(attempt)) {
      duplicate_resolution = candidatePayloadDigest(businessFirst) === candidatePayloadDigest(attempt)
        ? "duplicate_delivery"
        : "event_id_conflict";
      canonicalAttempt = businessFirst;
    }
  }
  if (duplicate_resolution === "unique" && record.event_name === "refund" && isAnchoredCommerce(attempt)) {
    const businessFirst = admittedRefunds(candidates.all()).winners.get(refundBusinessKey(attempt));
    if (businessFirst && compareCandidateAttempts(businessFirst, attempt) < 0) {
      duplicate_resolution = candidatePayloadDigest(businessFirst) === candidatePayloadDigest(attempt)
        ? "duplicate_delivery"
        : "event_id_conflict";
      canonicalAttempt = businessFirst;
    }
  }
  const consent = consentDecision(attempt);
  let ingestion_status: "accepted" | "rejected" = "accepted";
  let reason_code: Delivery["reason_code"];
  if (record.tenant_id !== server.tenant_id || record.app_id !== server.app_id) {
    ingestion_status = "rejected";
    reason_code = "client_scope_mismatch";
  } else if (duplicate_resolution === "record_id_collision") {
    ingestion_status = "rejected";
    reason_code = "record_id_collision";
  } else if (!consent.allowed) {
    ingestion_status = "rejected";
    reason_code = "consent_withdrawn";
  } else if (server.timestamp_stale_policy &&
    time(record.occurred_at, "occurred_at") < time(server.timestamp_stale_policy.before, "timestamp_stale_policy.before")) {
    ingestion_status = "rejected";
    reason_code = "timestamp_stale";
  } else if (record.subject_scope === "aggregate" && record.payload?.installation_id) {
    ingestion_status = "rejected";
    reason_code = "aggregate_installation_join_forbidden";
  } else if (duplicate_resolution === "event_id_conflict") {
    ingestion_status = "rejected";
    reason_code = "event_id_conflict";
  } else if (record.event_name === "refund" && duplicate_resolution === "unique" &&
      !(isLegacyExplicitRefund(attempt)
        ? legacyRefundTarget(attempt, candidates.all())
        : resolveRefundTarget(attempt, candidates.all()))) {
    ingestion_status = "rejected";
    reason_code = "refund_target_invalid";
  }
  const canonical_record_id = duplicate_resolution === "record_id_collision"
    ? undefined
    : duplicate_resolution === "unique" ? record.record_id : canonicalAttempt.record.record_id;
  return {
    record_id: record.record_id,
    ...(canonical_record_id ? { canonical_record_id } : {}),
    delivery_id: record.delivery_id,
    event_name: record.event_name,
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    ingestion_status,
    duplicate_resolution,
    timeliness: record.late ? "late" : "on_time",
    clock_skew_suspected: time(record.occurred_at, "occurred_at") > time(record.received_at, "received_at") + 300_000,
    payload_disposition: ingestion_status === "rejected" && reason_code !== "event_id_conflict" ? "discarded" : "protected",
    ...consent,
    ...(reason_code === "timestamp_stale" ? {
      staleness_policy_version: server.timestamp_stale_policy.policy_version,
      staleness_policy_digest: server.timestamp_stale_policy.policy_digest,
      staleness_authority: server.timestamp_stale_policy.authority,
    } : {}),
    ...(reason_code ? { reason_code } : {}),
  };
}

export function privacyIndex(input: Any): Map<string, "redacted" | "purged"> {
  const result = new Map<string, "redacted" | "purged">();
  for (const request of input.privacy_requests ?? []) {
    if (request.status !== "completed") continue;
    for (const affected of request.affected_records ?? []) {
      result.set(evidenceKey(request.tenant_id, request.app_id, affected.record_id), affected.lifecycle_status);
    }
  }
  for (const expiration of input.retention_expirations ?? []) {
    result.set(evidenceKey(expiration.tenant_id, expiration.app_id, expiration.record_id), "purged");
  }
  return result;
}
