import { sortCandidateAttempts, type CandidateAttempt } from "@openmasu/attribution-core";
import { type Any } from "./model.js";

export function inputAttempts(input: Any): CandidateAttempt[] {
  if (Array.isArray(input.batches)) {
    return input.batches.flatMap((batch: Any) =>
      batch.records.map((record: Any) => ({
        server: batch.server_context,
        record,
        batch_id: batch.batch_id,
      })),
    );
  }
  return (input.records ?? []).map((record: Any) => ({
    server: input.server_context,
    record,
    batch_id: "batch-default",
  }));
}

export function defaultTimestamp(input: Any): string {
  return input.server_context?.received_at ?? input.batches?.[0]?.server_context?.received_at ?? "2026-08-19T00:00:00.000Z";
}

export function policyDigestForRecord(input: Any, recordId: string): string {
  const attempt = inputAttempts(input).find(({ record }) => record.record_id === recordId);
  const digest = attempt?.server.policy_digest;
  if (typeof digest !== "string") throw new Error(`missing server policy digest for ${recordId}`);
  return digest;
}

export function refundCorrectionTargets(corrections: readonly Any[]): Map<string, string> {
  const prefix = "correction:";
  return new Map(corrections
    .filter((correction) => correction.correction_reason === "refund"
      && typeof correction.correction_id === "string"
      && correction.correction_id.startsWith(prefix)
      && typeof correction.corrects_record_id === "string")
    .map((correction) => [correction.correction_id.slice(prefix.length), correction.corrects_record_id]));
}

export function isLegacyExplicitRefundPayload(payload: Any): boolean {
  return typeof payload.installation_id !== "string"
    && typeof payload.correction_target_record_id === "string";
}

export function refundProjectionTargets(
  logicals: readonly Any[],
  input: Any,
  corrections: readonly Any[],
  acceptedLogicals: readonly Any[] = logicals,
): Map<string, string> {
  const targets = refundCorrectionTargets(corrections);
  const attempts = sortCandidateAttempts(inputAttempts(input));
  const acceptedLogicalRecords = new Set(acceptedLogicals.map((logical) => [
    logical.tenant_id, logical.app_id, logical.record_id,
  ].join("\u0000")));
  const recordCounts = new Map<string, number>();
  const firstByLogicalScope = new Map<string, CandidateAttempt>();
  for (const attempt of attempts) {
    recordCounts.set(attempt.record.record_id, (recordCounts.get(attempt.record.record_id) ?? 0) + 1);
    const key = [
      attempt.server.tenant_id, attempt.server.app_id,
      attempt.record.producer, attempt.record.event_id,
    ].join("\u0000");
    if (!firstByLogicalScope.has(key)) firstByLogicalScope.set(key, attempt);
  }
  const purchases = attempts.filter((attempt) => {
    if (attempt.record.event_name !== "purchase"
        || typeof attempt.record.payload.installation_id !== "string"
        || attempt.record.payload.financial_status !== "settled"
        || attempt.record.tenant_id !== attempt.server.tenant_id
        || attempt.record.app_id !== attempt.server.app_id
        || !acceptedLogicalRecords.has([
          attempt.server.tenant_id, attempt.server.app_id, attempt.record.record_id,
        ].join("\u0000"))
        || recordCounts.get(attempt.record.record_id) !== 1) return false;
    const key = [
      attempt.server.tenant_id, attempt.server.app_id,
      attempt.record.producer, attempt.record.event_id,
    ].join("\u0000");
    return firstByLogicalScope.get(key) === attempt;
  });
  const attemptsByRecord = new Map(attempts.map((attempt) => [
    `${attempt.server.tenant_id}\u0000${attempt.server.app_id}\u0000${attempt.record.record_id}`,
    attempt,
  ]));
  for (const logical of logicals.filter((entry) => entry.event_name === "refund")) {
    const refund = attemptsByRecord.get(
      `${logical.tenant_id}\u0000${logical.app_id}\u0000${logical.record_id}`,
    );
    if (!refund) {
      throw new Error(`missing_resolved_refund_target:${logical.record_id}`);
    }
    const payload = refund.record.payload;
    if (isLegacyExplicitRefundPayload(payload)) {
      // Legacy (v0.4.0) explicit corrections remain logical corrections only.
      // They deliberately do not enter the v0.4.8 financial fact projection.
      targets.delete(logical.record_id);
      continue;
    }
    const explicitTarget = payload.correction_target_record_id;
    if (explicitTarget === undefined && typeof payload.installation_id !== "string") {
      throw new Error(`missing_resolved_refund_target:${logical.record_id}`);
    }
    const existing = targets.get(logical.record_id);
    if (existing !== undefined && !attemptsByRecord.has(
      `${logical.tenant_id}\u0000${logical.app_id}\u0000${existing}`,
    )) {
      // The evaluator resolved this target from a ledger-backed historical
      // candidate. The deferred database constraints and refund invariant
      // validate the same-scope persisted target during insertion.
      continue;
    }
    const matches = purchases.filter((purchase) =>
      purchase.server.tenant_id === refund.server.tenant_id
      && purchase.server.app_id === refund.server.app_id
      && typeof payload.installation_id === "string"
      && purchase.record.payload.installation_id === payload.installation_id
      && !(refund.server.refund_target_ineligible_record_ids ?? [])
        .includes(purchase.record.record_id)
      && (purchase.record.payload.original_transaction_id ?? purchase.record.payload.transaction_id)
        === payload.original_transaction_id
      && purchase.record.payload.currency === payload.currency
      && purchase.record.occurred_at <= refund.record.occurred_at
      && purchase.record.received_at <= refund.record.received_at);
    if (matches.length !== 1) {
      throw new Error(`missing_resolved_refund_target:${logical.record_id}`);
    }
    if (explicitTarget !== undefined && matches[0].record.record_id !== explicitTarget) {
      throw new Error(`missing_resolved_refund_target:${logical.record_id}`);
    }
    if (existing !== undefined && existing !== matches[0].record.record_id) {
      throw new Error(`refund_target_resolution_mismatch:${logical.record_id}`);
    }
    targets.set(logical.record_id, matches[0].record.record_id);
  }
  return targets;
}
