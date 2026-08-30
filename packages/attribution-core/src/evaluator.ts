import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import {
  DEFAULT_FRAUD_BUNDLE,
  clickInjectionPolicyDigest,
  evaluateInstallRules,
  evaluateSourceDayWithBundle,
  fraudBundleHash,
  fraudNumberParameter,
  fraudRuleAction,
  sha256Jcs,
  type FraudBundle,
} from "@openmasu/fraud-rules";
import {
  REFERENCE_AD_REVENUE_METRIC_DEFINITIONS,
  nonFraudBundleHash,
  type OpenMasuEvaluationOutputV04 as EvaluationOutput,
} from "@openmasu/contracts";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Any = Record<string, any>;
type RawRecord = EvaluationOutput["raw_records"][number];
type Delivery = EvaluationOutput["deliveries"][number];
type LogicalEvent = EvaluationOutput["logical_events"][number];
type Correction = EvaluationOutput["corrections"][number];
type PrivacyRequest = EvaluationOutput["privacy_requests"][number];
type PrivacyTombstone = EvaluationOutput["privacy_tombstones"][number];
type Attribution = EvaluationOutput["attributions"][number];
type CostRecord = EvaluationOutput["cost_records"][number];
type MetricDefinition = EvaluationOutput["metric_definitions"][number];
type MetricRun = EvaluationOutput["metric_runs"][number];
type FraudDecision = EvaluationOutput["fraud_decisions"][number];
type Rejection = EvaluationOutput["rejections"][number];
type Reconciliation = EvaluationOutput["reconciliation"][number];
type EvidenceRef = Attribution["evidence_refs"][number];
type LifecycleStatus = EvidenceRef["lifecycle_status"];

const CONTRACT_VERSION = "0.4.0" as const;
// Rule bundles and metric definitions retain their independent v0.3 identities.
const REFERENCE_RULE_VERSION = "0.3.0" as const;
const FRAUD_BUNDLE: FraudBundle = DEFAULT_FRAUD_BUNDLE;
const FRAUD_BUNDLE_HASH = fraudBundleHash(FRAUD_BUNDLE);
const DAY_MS = 86_400_000;

function boundNonFraudBundle(server: Any, id: "attribution-default" | "apple-postback-default"): {
  rule_bundle_id: string; rule_bundle_version: string; rule_bundle_hash: string;
} {
  const expectedVersion = REFERENCE_RULE_VERSION;
  const expectedHash = nonFraudBundleHash(id);
  const bound = server.non_fraud_rule_bundles?.[id];
  if (!bound) return { rule_bundle_id: id, rule_bundle_version: expectedVersion, rule_bundle_hash: expectedHash };
  if (bound.rule_bundle_id !== id || bound.rule_bundle_version !== expectedVersion
    || bound.rule_bundle_hash !== expectedHash || bound.definition_digest !== expectedHash) {
    throw new Error("non_fraud_rule_bundle_binding_mismatch");
  }
  return { rule_bundle_id: id, rule_bundle_version: expectedVersion, rule_bundle_hash: expectedHash };
}

export function jcs(value: unknown): string {
  return canonicalize(value);
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(jcs(value), "utf8").digest("hex");
}

type BoundFraudBundle = { readonly definition: FraudBundle; readonly hash: string };

function boundFraudBundle(server: Any): BoundFraudBundle | undefined {
  if (server.fraud_enabled === false) return undefined;
  const bound = server.fraud_rule_bundle;
  if (!bound) return { definition: FRAUD_BUNDLE, hash: FRAUD_BUNDLE_HASH };
  const definition = bound.definition as FraudBundle;
  const hash = fraudBundleHash(definition);
  if (bound.rule_bundle_id !== definition.id || bound.rule_bundle_version !== definition.version) {
    throw new Error("fraud_rule_bundle_identity_mismatch");
  }
  if (bound.definition_digest !== sha256Jcs(definition)) throw new Error("fraud_rule_bundle_definition_digest_mismatch");
  if (bound.rule_bundle_hash !== hash) throw new Error("fraud_rule_bundle_hash_mismatch");
  return { definition, hash };
}

function quarantineDeadline(action: string, evaluatedAt: string, bundle: FraudBundle): Record<string, string> {
  if (action !== "quarantine") return {};
  const hours = fraudNumberParameter(bundle, "quarantine_hours", 72);
  return { resolution_deadline_at: new Date(time(evaluatedAt, "evaluated_at") + hours * 3_600_000).toISOString() };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compositeKey(parts: readonly unknown[]): string {
  return JSON.stringify(parts);
}

function sortByKey<T>(values: T[], key: (value: T) => readonly string[]): T[] {
  return [...values].sort((a, b) => {
    const aKey = [...key(a), sha256(a)];
    const bKey = [...key(b), sha256(b)];
    for (let index = 0; index < aKey.length; index += 1) {
      const comparison = compareText(aKey[index], bKey[index]);
      if (comparison !== 0) return comparison;
    }
    return 0;
  });
}

export class TimestampInvalidError extends Error {
  readonly exitCode = 1;

  constructor(field: string, value: unknown) {
    super(`timestamp_invalid: ${field}=${String(value)}`);
    this.name = "TimestampInvalidError";
  }
}

function time(value: string | undefined, field: string): number {
  if (!value) throw new TimestampInvalidError(field, value);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TimestampInvalidError(field, value);
  }
  return parsed.getTime();
}

function dateAt(value: string, zone: "UTC" | "Asia/Tokyo", field: string): string {
  const offset = zone === "Asia/Tokyo" ? 9 * 3_600_000 : 0;
  return new Date(time(value, field) + offset).toISOString().slice(0, 10);
}

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
type Attempt = CandidateAttempt;

function candidatePayloadDigest(attempt: Attempt): string {
  return attempt.history_state?.payload_sha256 ?? sha256(attempt.record.payload);
}

function semanticCandidate(attempt: Attempt): boolean {
  return attempt.history_state?.semantic_available !== false;
}

function attempts(input: Any): Attempt[] {
  if (Array.isArray(input.batches)) {
    return input.batches.flatMap((batch: Any) =>
      batch.records.map((record: Any) => ({ server: batch.server_context, record, batch_id: batch.batch_id })),
    );
  }
  return (input.records ?? []).map((record: Any) => ({ server: input.server_context, record, batch_id: "batch-default" }));
}

function assertImportProviderContexts(all: Attempt[]): void {
  for (const attempt of all) {
    const context = attempt.record.payload.import_context;
    if (!attempt.record.producer.startsWith("import:") || !context) continue;
    if (attempt.record.producer !== `import:${context.provider}`) {
      throw new Error("import_context.provider must match the authenticated import producer");
    }
  }
}

function assertRevenueAnchorSources(all: Attempt[]): void {
  for (const attempt of all) {
    if (attempt.record.event_name !== "ad_revenue" || attempt.record.payload.anchor_source === undefined) continue;
    if (!attempt.record.producer.startsWith("postback:")) {
      throw new Error("ad_revenue.anchor_source is limited to authenticated S2S postback producers");
    }
  }
}

export function compareCandidateAttempts(a: CandidateAttempt, b: CandidateAttempt): number {
  const aKey = candidateAttemptSortKey(a);
  const bKey = candidateAttemptSortKey(b);
  return compareCandidateAttemptSortKeys(aKey, bKey);
}

function candidateAttemptSortKey(attempt: CandidateAttempt): string[] {
  return [
    attempt.history_state ? "0" : "1",
    attempt.record.received_at, attempt.record.record_id, attempt.record.delivery_id,
    attempt.server.tenant_id, attempt.server.app_id, attempt.record.schema_version,
    attempt.history_state ? candidatePayloadDigest(attempt) : sha256(attempt.record),
  ];
}

function compareCandidateAttemptSortKeys(aKey: readonly string[], bKey: readonly string[]): number {
  for (let index = 0; index < aKey.length; index += 1) {
    const comparison = compareText(aKey[index], bKey[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

export function sortCandidateAttempts(values: readonly CandidateAttempt[]): CandidateAttempt[] {
  return values
    .map((attempt) => ({ attempt, key: candidateAttemptSortKey(attempt) }))
    .sort((a, b) => compareCandidateAttemptSortKeys(a.key, b.key))
    .map(({ attempt }) => attempt);
}

function scopeKey(attempt: Attempt): string {
  const { server, record } = attempt;
  return compositeKey([server.tenant_id, server.app_id, record.producer, record.event_id]);
}

function clickKey(tenantId: string, appId: string, clickId: string): string {
  return compositeKey([tenantId, appId, clickId]);
}

export interface CandidateProvider {
  all(): readonly CandidateAttempt[];
  byRecordId(recordId: string): readonly CandidateAttempt[];
  byLogicalScope(attempt: CandidateAttempt): readonly CandidateAttempt[];
  clickCandidates(tenantId: string, appId: string, clickId: string): readonly CandidateAttempt[];
}

export type CandidateProviderFactory = (attempts: readonly CandidateAttempt[]) => CandidateProvider;

export class FixtureArrayCandidateProvider implements CandidateProvider {
  constructor(private readonly ordered: readonly CandidateAttempt[]) {}

  all(): readonly CandidateAttempt[] {
    return this.ordered;
  }

  byRecordId(recordId: string): readonly CandidateAttempt[] {
    return this.ordered.filter((candidate) => candidate.record.record_id === recordId);
  }

  byLogicalScope(attempt: CandidateAttempt): readonly CandidateAttempt[] {
    return this.ordered.filter((candidate) => scopeKey(candidate) === scopeKey(attempt));
  }

  clickCandidates(tenantId: string, appId: string, candidateClickId: string): readonly CandidateAttempt[] {
    return this.ordered.filter((candidate) =>
      candidate.server.tenant_id === tenantId && candidate.server.app_id === appId &&
      candidate.record.event_name === "click" && candidate.record.payload.click_id === candidateClickId,
    );
  }
}

export class IndexedCandidateProvider implements CandidateProvider {
  private readonly records = new Map<string, CandidateAttempt[]>();
  private readonly logicalScopes = new Map<string, CandidateAttempt[]>();
  private readonly clicks = new Map<string, CandidateAttempt[]>();

  constructor(private readonly ordered: readonly CandidateAttempt[]) {
    for (const attempt of ordered) {
      this.add(this.records, attempt.record.record_id, attempt);
      this.add(this.logicalScopes, scopeKey(attempt), attempt);
      if (attempt.record.event_name === "click") {
        this.add(
          this.clicks,
          clickKey(attempt.server.tenant_id, attempt.server.app_id, attempt.record.payload.click_id),
          attempt,
        );
      }
    }
  }

  private add(index: Map<string, CandidateAttempt[]>, key: string, attempt: CandidateAttempt): void {
    const values = index.get(key) ?? [];
    values.push(attempt);
    index.set(key, values);
  }

  all(): readonly CandidateAttempt[] {
    return this.ordered;
  }

  byRecordId(recordId: string): readonly CandidateAttempt[] {
    return this.records.get(recordId) ?? [];
  }

  byLogicalScope(attempt: CandidateAttempt): readonly CandidateAttempt[] {
    return this.logicalScopes.get(scopeKey(attempt)) ?? [];
  }

  clickCandidates(tenantId: string, appId: string, candidateClickId: string): readonly CandidateAttempt[] {
    return this.clicks.get(clickKey(tenantId, appId, candidateClickId)) ?? [];
  }
}

export const createFixtureCandidateProvider: CandidateProviderFactory =
  (values) => new FixtureArrayCandidateProvider(values);
export const createIndexedCandidateProvider: CandidateProviderFactory =
  (values) => new IndexedCandidateProvider(values);

function evidenceKey(tenantId: string, appId: string, recordId: string): string {
  return compositeKey([tenantId, appId, recordId]);
}

function attemptEvidenceKey(attempt: Attempt): string {
  return evidenceKey(attempt.server.tenant_id, attempt.server.app_id, attempt.record.record_id);
}

// record_id is a server-generated global identity. Keep delivery context in
// the evaluator key so malformed collisions cannot overwrite each other.
function attemptDecisionKey(attempt: Attempt): string {
  return compositeKey([
    attempt.batch_id, attempt.server.tenant_id, attempt.server.app_id,
    attempt.record.delivery_id, attempt.record.record_id, attempt.record.schema_version,
    attempt.history_state ? candidatePayloadDigest(attempt) : sha256(attempt.record),
  ]);
}

function decisionFor(decisions: Map<string, Any>, attempt: Attempt): Any {
  const decision = decisions.get(attemptDecisionKey(attempt));
  if (!decision && attempt.history_state) {
    return {
      canonical_record_id: attempt.record.record_id,
      ingestion_status: "accepted",
      duplicate_resolution: "unique",
    };
  }
  if (!decision) throw new Error(`missing decision: ${attempt.record.delivery_id}`);
  return decision;
}

function assertInstallationAnchors(all: Attempt[], decisions: Map<string, Any>): void {
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

function assertScopedReferences(input: Any, all: Attempt[]): void {
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

function isLegacyExplicitRefund(attempt: Attempt): boolean {
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

function resolveRefundTarget(refund: Attempt, candidates: readonly Attempt[]): Attempt | undefined {
  if (!isAnchoredCommerce(refund)) return undefined;
  return admittedRefunds(candidates).targets.get(attemptDecisionKey(refund));
}

function isControlEvent(record: Any): boolean {
  return record.event_name === "consent_changed" || record.event_name === "privacy_control";
}

function consentDecision(attempt: Attempt): Any {
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

function timestampInvalidDecision(attempt: Attempt): Any {
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

function preIngestionDecision(item: Any): Any {
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

function decide(attempt: Attempt, candidates: CandidateProvider): Any {
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
  let duplicate_resolution = sameRecordId.length > 1
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
  let reason_code: string | undefined;
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

function privacyIndex(input: Any): Map<string, "redacted" | "purged"> {
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

function makeAttribution(
  attempt: Attempt,
  candidates: CandidateProvider,
  decisions: Map<string, Any>,
  lifecycle: Map<string, LifecycleStatus>,
): Attribution {
  const { server, record: install } = attempt;
  const payload = install.payload;
  const attributionBundle = boundNonFraudBundle(server, "attribution-default");
  const evidence = (ref: string): EvidenceRef => ({
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    ref,
    lifecycle_status: lifecycle.get(evidenceKey(server.tenant_id, server.app_id, ref)) ?? "available",
    access_class: "protected",
  });
  const base = {
    attribution_id: `attr:${install.record_id}`,
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    subject_scope: "installation_level" as const,
    subject_ref: payload.installation_id,
    reason_code_version: CONTRACT_VERSION,
    evidence_refs: [evidence(install.record_id)],
    effective_at: install.occurred_at,
    decided_at: server.received_at,
    input_cutoff_at: server.received_at,
    finality: "final" as const,
    ...attributionBundle,
  } satisfies Omit<Attribution, "status" | "method" | "model" | "reason_code">;
  const result = (
    status: Attribution["status"],
    method: Attribution["method"],
    model: Attribution["model"],
    reason_code: Attribution["reason_code"],
    extra: Partial<Attribution> = {},
  ): Attribution => {
    const attribution: Attribution = { ...base, status, method, model, reason_code, ...extra };
    if (!attribution.evidence_refs.some((entry) => entry.lifecycle_status !== "available")) return attribution;
    return {
      ...attribution,
      attribution_id: `${base.attribution_id}:recalculated`,
      finality: "superseded",
      supersedes_attribution_id: base.attribution_id,
    };
  };
  const importedProducer = install.producer.startsWith("import:");
  const imported = importedProducer ? payload.import_context : undefined;
  if (importedProducer) {
    if (!imported) return result("unattributed", "imported", "provider_reported", "provider_unattributed");
    const referencedClicks = imported.provider_click_ref
      ? candidates.all().filter((candidate) =>
        candidate.server.tenant_id === server.tenant_id && candidate.server.app_id === server.app_id &&
        candidate.record.event_name === "click" && candidate.record.producer === "redirector" &&
        candidate.record.payload.remote_click_ref === imported.provider_click_ref &&
        decisionFor(decisions, candidate).ingestion_status === "accepted" &&
        decisionFor(decisions, candidate).duplicate_resolution === "unique",
      )
      : [];
    const importedEvidence = referencedClicks.length === 1
      ? { evidence_refs: [evidence(referencedClicks[0].record.record_id), evidence(install.record_id)] }
      : {};
    if (imported.provider_attributed) {
      if (imported.provider_attribution_strategy === "modeled") {
        return result("non_organic", "imported", "provider_reported", "provider_modeled_conversion", importedEvidence);
      }
      if (!imported.provider_confirmed_at) {
        return result("non_organic", "imported", "provider_reported", "provider_time_authority_unavailable", importedEvidence);
      }
      return result("non_organic", "imported", "provider_reported", "provider_attributed", importedEvidence);
    }
    if (imported.provider_attribution_strategy === "organic") {
      return result("organic", "imported", "provider_reported", "provider_organic");
    }
    return result("unattributed", "imported", "provider_reported", "provider_unattributed");
  }
  if (payload.meta_referrer_status === "decrypted") {
    return result(
      "non_organic",
      "meta_install_referrer",
      payload.meta_referrer_context.attribution_model,
      "meta_referrer_decrypted",
    );
  }
  if (["decrypt_failed", "auth_failed"].includes(payload.meta_referrer_status)) {
    return result(
      "unattributed",
      "meta_install_referrer",
      payload.meta_referrer_context?.attribution_model ?? "last_click",
      "meta_referrer_decrypt_failed",
    );
  }
  if (payload.adservices_context?.status === "attributed") {
    return result("non_organic", "apple_adservices", "last_click", "adservices_attributed");
  }
  if (payload.adservices_context?.status === "token_expired") {
    return result("unattributed", "apple_adservices", "last_click", "adservices_token_expired");
  }
  if (payload.adservices_context?.status === "not_attributed") {
    return result("unattributed", "apple_adservices", "last_click", "adservices_not_attributed");
  }
  if (payload.adservices_context?.status === "lookup_unavailable") {
    return result("unattributed", "apple_adservices", "last_click", "adservices_lookup_unavailable");
  }
  if (payload.referrer_status === "none") return result("organic", "none", "none", "no_referrer");
  if (payload.referrer_status === "third_party") {
    return payload.third_party_referrer_classification === "play_organic_marker"
      ? result("organic", "none", "none", "no_first_party_referrer")
      : result("unattributed", "none", "none", "foreign_referrer_unresolved");
  }
  if (payload.referrer_status === "unsupported") return result("unattributed", "none", "none", "install_referrer_unsupported");
  if (payload.referrer_status === "unavailable") return result("unattributed", "none", "none", "install_referrer_unavailable");
  if (payload.referrer_status === "not_applicable") return result("unattributed", "none", "none", "platform_referrer_not_available");
  const clicks = candidates.clickCandidates(server.tenant_id, server.app_id, payload.click_id).filter((candidate) =>
    decisionFor(decisions, candidate).ingestion_status === "accepted" &&
    decisionFor(decisions, candidate).duplicate_resolution === "unique",
  );
  if (!clicks.length) return result("unattributed", "none", "none", "unknown_click_id");
  if (clicks.length > 1) return result("unattributed", "none", "none", "ambiguous_click_id");
  const [click] = clicks;
  if (click.record.payload.bot_prefetch) {
    return result("unattributed", "none", "none", "bot_prefetch", {
      evidence_refs: [evidence(click.record.record_id), evidence(install.record_id)],
    });
  }
  const clickStatus = click.record.payload.redirector_time_status ?? "available";
  const installStatus = payload.install_begin_at_server_status ?? (payload.install_begin_at_server ? "available" : "missing");
  if (clickStatus === "invalid" || installStatus === "invalid") return result("unattributed", "none", "none", "authoritative_time_invalid");
  if (clickStatus !== "available" || installStatus !== "available" || !click.record.payload.redirector_click_at || !payload.install_begin_at_server) {
    return result("unattributed", "none", "none", "authoritative_time_missing");
  }
  const delta = time(payload.install_begin_at_server, "install_begin_at_server") -
    time(click.record.payload.redirector_click_at, "redirector_click_at");
  if (delta < 0 || delta >= 7 * DAY_MS) return result("unattributed", "none", "none", "window_expired");
  return result("non_organic", "install_referrer", "last_click", "valid_install_referrer", {
    evidence_refs: [evidence(click.record.record_id), evidence(install.record_id)],
  });
}

function makeAggregatePostbackAttribution(
  attempt: Attempt,
  lifecycle: Map<string, LifecycleStatus>,
): Attribution {
  const { server, record } = attempt;
  const payload = record.payload;
  const postbackBundle = boundNonFraudBundle(server, "apple-postback-default");
  const isSkan = record.event_name === "skan_postback";
  const method: Attribution["method"] = isSkan ? "skadnetwork" : "adattributionkit";
  const evidence: EvidenceRef = {
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    ref: record.record_id,
    lifecycle_status: lifecycle.get(evidenceKey(server.tenant_id, server.app_id, record.record_id)) ?? "available",
    access_class: "protected",
  };
  let status: Attribution["status"] = "non_organic";
  let reason_code: Attribution["reason_code"] = "skan_postback_verified";
  if (!payload.signature_verified) {
    status = "unattributed";
    reason_code = "skan_signature_invalid";
  } else if (!payload.did_win) {
    status = "unattributed";
    reason_code = "postback_not_winner";
  } else if (payload.source_identifier === undefined) {
    status = "unattributed";
    reason_code = "crowd_anonymity_suppressed";
  } else if (payload.conversion_value === undefined && payload.coarse_conversion_value === undefined) {
    status = "unattributed";
    reason_code = "conversion_value_null";
  }
  return {
    attribution_id: `attr:${record.record_id}`,
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    subject_scope: "aggregate",
    subject_ref: `aggregate:${method}:${record.record_id}`,
    status,
    method,
    model: "aggregate",
    reason_code,
    reason_code_version: CONTRACT_VERSION,
    evidence_refs: [evidence],
    effective_at: record.occurred_at,
    decided_at: server.received_at,
    input_cutoff_at: server.received_at,
    finality: "final",
    ...postbackBundle,
  };
}

function makeDeepLinkAttribution(
  attempt: Attempt,
  lifecycle: Map<string, LifecycleStatus>,
): Attribution {
  const { server, record } = attempt;
  const resolution = server.deep_link_resolution ?? { status: "unknown" };
  const attributionBundle = boundNonFraudBundle(server, "attribution-default");
  const reusedInstallClick = record.payload.open_source === "android_deferred_referrer"
    && resolution.install_attribution_click_id === record.payload.click_id;
  const status: Attribution["status"] = resolution.status === "active" && !reusedInstallClick
    ? "non_organic" : "unattributed";
  const reason_code: Attribution["reason_code"] = reusedInstallClick
    ? "deep_link_install_click_reused"
    : resolution.status === "active" ? "deep_link_open_attributed"
      : resolution.status === "inactive" ? "deep_link_link_inactive"
        : "deep_link_unknown_link";
  return {
    attribution_id: `attr:engagement:${record.record_id}`,
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    subject_scope: "engagement_level",
    subject_ref: `engagement:${record.record_id}`,
    status,
    method: "deep_link",
    model: "last_click",
    reason_code,
    reason_code_version: CONTRACT_VERSION,
    evidence_refs: [{
      tenant_id: server.tenant_id,
      app_id: server.app_id,
      ref: record.record_id,
      lifecycle_status: lifecycle.get(evidenceKey(server.tenant_id, server.app_id, record.record_id)) ?? "available",
      access_class: "protected",
    }],
    effective_at: record.occurred_at,
    decided_at: server.received_at,
    input_cutoff_at: server.received_at,
    finality: "final",
    ...attributionBundle,
  };
}

export function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("denominator must be positive");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const twice = remainder * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
  return negative ? -quotient : quotient;
}

function baseMetricDefinitions(): MetricDefinition[] {
  return REFERENCE_AD_REVENUE_METRIC_DEFINITIONS.map((definition) => structuredClone(definition));
}

function metricDefinitions(input: Any): MetricDefinition[] {
  const definitions = [...baseMetricDefinitions(), ...(input.metric_definitions ?? [])];
  const names = new Set<string>();
  for (const definition of definitions) {
    if (names.has(definition.metric_name)) throw new Error(`duplicate metric definition: ${definition.metric_name}`);
    validateMetricDefinitionSeries(definition);
    names.add(definition.metric_name);
  }
  return sortByKey(definitions, (definition) => [definition.metric_name, definition.metric_definition_version]);
}

function validateMetricDefinitionSeries(definition: Any): void {
  const purchaseNetDays = new Map<string, number>([
    ["cohort_purchase_net_revenue_d0_usd", 0],
    ["cohort_purchase_net_revenue_d1_usd", 1],
    ["cohort_purchase_net_revenue_d3_usd", 3],
    ["cohort_purchase_net_revenue_d7_usd", 7],
    ["cohort_purchase_net_revenue_d30_usd", 30],
    ["cohort_purchase_net_revenue_d90_usd", 90],
  ]);
  const totalNetSeries = new Map<string, { day: number; calculation: string; valueType: string }>([
    ["cohort_total_net_revenue_d30_usd", { day: 30, calculation: "revenue_sum", valueType: "money" }],
    ["cohort_total_net_revenue_d90_usd", { day: 90, calculation: "revenue_sum", valueType: "money" }],
    ["d30_total_net_roas", { day: 30, calculation: "revenue_over_cost", valueType: "ratio" }],
    ["d90_total_net_roas", { day: 90, calculation: "revenue_over_cost", valueType: "ratio" }],
    ["cohort_total_net_ltv_d30_usd", { day: 30, calculation: "revenue_over_cohort", valueType: "money" }],
    ["cohort_total_net_ltv_d90_usd", { day: 90, calculation: "revenue_over_cohort", valueType: "money" }],
  ]);
  const aggregateNames = new Set([
    "skan_attributed_installs", "skan_conversion_value_distribution", "aak_attributed_installs",
    "aak_attributed_reengagements",
  ]);
  const aggregateEvents = new Set(["skan_postback", "adattributionkit_postback"]);
  const eventNames = definition.event_names ?? [];
  const grouping = definition.grouping_dimensions ?? [];
  const fail = () => { throw new Error(`metric_definition_series_mismatch:${definition.metric_name}`); };
  if (definition.definition?.numerator === "purchase_net_revenue" || purchaseNetDays.has(definition.metric_name)) {
    const expectedDay = purchaseNetDays.get(definition.metric_name);
    const expectedVersion = expectedDay === 30 || expectedDay === 90 ? "0.4.9" : "0.4.8";
    const expectedHash = expectedVersion === "0.4.9"
      ? nonFraudBundleHash("metric-purchase-net-v0.4.9") : nonFraudBundleHash("metric-purchase-net");
    if (expectedDay === undefined || definition.metric_definition_version !== expectedVersion ||
        definition.anchor_event !== "install" || definition.aggregation_time_zone !== "UTC" ||
        definition.value_type !== "money" || definition.currency !== "USD" || definition.amount_scale !== 6 ||
        definition.rule_bundle_id !== "metric-purchase-net" ||
        definition.rule_bundle_version !== expectedVersion || definition.rule_bundle_hash !== expectedHash ||
        definition.definition?.calculation !== "revenue_sum" ||
        definition.definition?.numerator !== "purchase_net_revenue" ||
        definition.definition?.window?.type !== "elapsed" || definition.definition?.window?.day !== expectedDay) fail();
    return;
  }
  if (definition.definition?.numerator === "total_net_revenue" || totalNetSeries.has(definition.metric_name)) {
    const expected = totalNetSeries.get(definition.metric_name);
    if (!expected || definition.metric_definition_version !== "0.4.9" ||
        definition.anchor_event !== "install" || definition.aggregation_time_zone !== "UTC" ||
        definition.value_type !== expected.valueType ||
        (expected.valueType === "money" && (definition.currency !== "USD" || definition.amount_scale !== 6)) ||
        (expected.valueType === "ratio" && definition.ratio_scale !== 6) ||
        definition.rule_bundle_id !== "metric-total-net" ||
        definition.rule_bundle_version !== "0.4.9"
        || definition.rule_bundle_hash !== nonFraudBundleHash("metric-total-net") ||
        definition.definition?.calculation !== expected.calculation ||
        definition.definition?.numerator !== "total_net_revenue" ||
        definition.definition?.window?.type !== "elapsed" || definition.definition?.window?.day !== expected.day ||
        (expected.calculation === "revenue_over_cost" &&
          (definition.definition?.denominator !== "cost" ||
            definition.definition?.cost_basis !== "cohort_acquisition_day_current_snapshot")) ||
        (expected.calculation === "revenue_over_cohort" && definition.definition?.denominator !== "cohort_size")) fail();
    return;
  }
  if (aggregateNames.has(definition.metric_name)) {
    const expectedEvent = definition.metric_name.startsWith("aak_attributed_")
      ? "adattributionkit_postback" : "skan_postback";
    const expectedGrouping = definition.metric_name === "skan_conversion_value_distribution"
      ? ["metric_date", "apple_conversion_bucket"] : ["metric_date"];
    if (definition.definition?.calculation !== "event_count" || definition.definition?.numerator !== "events" ||
        definition.aggregation_time_zone !== "UTC" || eventNames.length !== 1 || eventNames[0] !== expectedEvent ||
        grouping.length !== expectedGrouping.length || expectedGrouping.some((value) => !grouping.includes(value))) fail();
    return;
  }
  if (["daily_deep_link_opens", "daily_deep_link_opens_by_status"].includes(definition.metric_name)) {
    const expectedGrouping = definition.metric_name === "daily_deep_link_opens_by_status"
      ? ["metric_date", "campaign_id", "attribution_status"]
      : ["metric_date", "campaign_id"];
    if (definition.definition?.calculation !== "event_count" || definition.definition?.numerator !== "events" ||
        eventNames.length !== 1 || eventNames[0] !== "deep_link_open" ||
        grouping.length !== expectedGrouping.length || expectedGrouping.some((value) => !grouping.includes(value))) fail();
    return;
  }
  if (eventNames.some((value: string) => aggregateEvents.has(value)) || grouping.includes("apple_conversion_bucket")) fail();
}

function costRecords(input: Any): CostRecord[] {
  const records: CostRecord[] = (input.cost_records ?? []).map((record: Any) => {
    const dimensions = Object.fromEntries(
      ["network", "campaign_id", "ad_group_id", "country"]
        .filter((field) => record[field] !== undefined)
        .map((field) => [field, record[field]]),
    );
    if (record.dimension_digest !== sha256(dimensions)) {
      throw new Error(`cost dimension_digest mismatch: ${record.cost_record_id}`);
    }
    return { ...record, contract_version: CONTRACT_VERSION };
  });
  return sortByKey(records, (record) => [record.cost_record_id, record.tenant_id, record.app_id, record.as_of]);
}

function convertMoney(payload: Any, fxPolicy: Any): bigint {
  const rate = (fxPolicy.rates ?? []).find((candidate: Any) => candidate.currency === payload.currency);
  if (!rate) throw new Error(`missing FX rate for ${payload.currency}`);
  const numerator = BigInt(payload.amount_unscaled) * BigInt(rate.rate_unscaled) * (10n ** BigInt(fxPolicy.target_scale));
  const denominator = 10n ** BigInt(Number(payload.amount_scale) + Number(rate.rate_scale));
  return roundHalfEven(numerator, denominator);
}

function metricRuns(
  input: Any,
  all: Attempt[],
  decisions: Map<string, Any>,
  lifecycle: Map<string, LifecycleStatus>,
  attributions: Attribution[],
  excludedInstallationIds: ReadonlySet<string> = new Set(),
): MetricRun[] {
  const evaluations = input.metric_evaluations ?? [];
  if (!evaluations.length) return [];
  const fxPolicy = input.fx_policy;
  const definitions = metricDefinitions(input);
  const definitionsByName = new Map(definitions.map((definition) => [definition.metric_name, definition]));
  const cost_records = costRecords(input);
  const attributionStatuses = new Map(attributions
    .filter((attribution) => ["installation_level", "engagement_level"].includes(attribution.subject_scope))
    .map((attribution) => [
      compositeKey([attribution.tenant_id, attribution.app_id, attribution.subject_ref]),
      attribution.status,
    ]));
  const output: MetricRun[] = [];
  for (const evaluation of evaluations) {
    const included = all.filter((attempt) =>
      decisionFor(decisions, attempt).ingestion_status === "accepted" &&
      decisionFor(decisions, attempt).duplicate_resolution === "unique" &&
      compareText(attempt.record.received_at, evaluation.input_received_at_watermark) <= 0,
    );
    const recordSnapshotRows = sortCandidateAttempts(included).map((attempt) => [
      attempt.record.received_at,
      attempt.record.record_id,
      evaluation.privacy_state === "after" ? (lifecycle.get(attemptEvidenceKey(attempt)) ?? "available") : "available",
      attempt.server.policy_digest,
    ]);
    const visible = included.filter((attempt) => evaluation.privacy_state !== "after" || !lifecycle.has(attemptEvidenceKey(attempt)));
    const installs = visible.filter((attempt) => attempt.record.event_name === "install" &&
      matchesGrouping(attempt, evaluation.grouping, attributionStatuses));
    const revenue = visible.filter((attempt) => attempt.record.event_name === "ad_revenue" &&
      attempt.record.payload.subject_scope === "installation_level");
    const purchases = visible.filter((attempt) =>
      attempt.record.event_name === "purchase" && attempt.record.payload.financial_status === "settled");
    const refunds = visible.filter((attempt) =>
      attempt.record.event_name === "refund" && attempt.record.payload.financial_status === "settled");
    const activities = visible;
    const affectedStates = evaluation.privacy_state === "after"
      ? included.map((attempt) => lifecycle.get(attemptEvidenceKey(attempt))).filter(Boolean)
      : [];
    const reproducibility_status = affectedStates.includes("redacted")
      ? "redaction_affected"
      : affectedStates.includes("purged") ? "retention_affected" : "fully_reproducible";
    const ledger = recordSnapshotRows.at(-1);
    const recordEvidence: MetricRun["evidence_refs"] = sortCandidateAttempts(included).map((attempt) => ({
      tenant_id: attempt.server.tenant_id,
      app_id: attempt.server.app_id,
      ref: attempt.record.record_id,
      lifecycle_status: evaluation.privacy_state === "after" ? (lifecycle.get(attemptEvidenceKey(attempt)) ?? "available") : "available",
      access_class: "protected",
    }));
    const cohortScopes = new Set(installs.map((install) => compositeKey([install.server.tenant_id, install.server.app_id])));
    const groupedCosts = cost_records.filter((cost) => {
      const grouping = evaluation.grouping;
      if (grouping?.attribution_status !== undefined && grouping.attribution_status !== "non_organic") return false;
      if (compareText(cost.as_of, evaluation.input_received_at_watermark) > 0) return false;
      if (cohortScopes.size && !cohortScopes.has(compositeKey([cost.tenant_id, cost.app_id]))) return false;
      if (!grouping) return true;
      return ["campaign_id", "network", "country"].every((field) => grouping[field] === undefined || cost[field] === grouping[field]) &&
        (grouping.cohort_date === undefined || cost.date === grouping.cohort_date);
    });
    const currentCosts = [...new Map(groupedCosts
      .sort((a, b) => compareText(a.as_of, b.as_of) || compareText(a.cost_record_id, b.cost_record_id))
      .map((cost) => [compositeKey([cost.tenant_id, cost.app_id, cost.dimension_digest]), cost])).values()];
    const costSnapshotRows = sortByKey(currentCosts, (cost) => [cost.as_of, cost.cost_record_id]).map((cost) => [
      "cost", cost.as_of, cost.cost_record_id, cost.report_snapshot_digest, cost.dimension_digest,
    ]);
    const snapshotRows = [...recordSnapshotRows, ...costSnapshotRows];
    const costEvidence: MetricRun["evidence_refs"] = currentCosts.map((cost) => ({
      tenant_id: cost.tenant_id,
      app_id: cost.app_id,
      ref: cost.cost_record_id,
      lifecycle_status: "available",
      access_class: "protected",
    }));
    const evidence_refs = sortByKey([...recordEvidence, ...costEvidence], (evidence) => [evidence.ref, evidence.tenant_id, evidence.app_id]);
    if (fxPolicy.rates.length !== 1) throw new Error("v0.2 metric runs require exactly one structured FX rate");
    const fxRate = fxPolicy.rates[0];
    const selectedNames = evaluation.metric_names ?? [
      "d0_install_to_24h_ad_revenue_usd",
      "d0_utc_install_calendar_ad_revenue_usd",
      "d0_jst_install_calendar_ad_revenue_usd",
    ];
    for (const metricName of selectedNames) {
      const definition = definitionsByName.get(metricName);
      if (!definition) throw new Error(`unknown metric definition: ${metricName}`);
      if (evaluation.grouping && definition.grouping_dimensions) {
        const groupingDimensions = new Set<string>(definition.grouping_dimensions);
        const unsupported = Object.keys(evaluation.grouping)
          .filter((dimension) => !groupingDimensions.has(dimension));
        if (unsupported.length) throw new Error(`unsupported grouping for ${metricName}: ${unsupported.join(",")}`);
      }
      const eligibleInstalls = definition.fraud_policy === "net"
        ? installs.filter((candidate) => !excludedInstallationIds.has(candidate.record.payload.installation_id))
        : installs;
      const revenueValue = revenue.reduce((sum, item) => {
        const installation = eligibleInstalls.find((candidate) =>
          candidate.server.tenant_id === item.server.tenant_id && candidate.server.app_id === item.server.app_id &&
          candidate.record.payload.installation_id === item.record.payload.installation_id,
        );
        return installation && eligibleRevenue(definition, installation.record, item.record)
          ? sum + convertMoney(item.record.payload, fxPolicy)
          : sum;
      }, 0n);
      const includesPurchaseNet = ["purchase_net_revenue", "total_net_revenue"].includes(
        definition.definition.numerator,
      );
      const purchaseNetRevenueValue = includesPurchaseNet
        ? purchases.reduce((sum, item) => {
        const installation = eligibleInstalls.find((candidate) =>
          candidate.server.tenant_id === item.server.tenant_id && candidate.server.app_id === item.server.app_id &&
          candidate.record.payload.installation_id === item.record.payload.installation_id,
        );
        return installation && eligibleRevenue(definition, installation.record, item.record)
          ? sum + convertMoney(item.record.payload, fxPolicy)
          : sum;
      }, 0n) - refunds.reduce((sum, item) => {
        const target = resolveRefundTarget(item, visible);
        if (!target || target.record.payload.financial_status !== "settled") return sum;
        const installation = eligibleInstalls.find((candidate) =>
          candidate.server.tenant_id === target.server.tenant_id && candidate.server.app_id === target.server.app_id &&
          candidate.record.payload.installation_id === target.record.payload.installation_id,
        );
        return installation && eligibleRevenue(definition, installation.record, item.record)
          ? sum + convertMoney(item.record.payload, fxPolicy)
          : sum;
      }, 0n)
        : 0n;
      const selectedRevenueValue = definition.definition.numerator === "purchase_net_revenue"
        ? purchaseNetRevenueValue
        : definition.definition.numerator === "total_net_revenue"
          ? revenueValue + purchaseNetRevenueValue
          : revenueValue;
      const cohortSize = BigInt(new Set(eligibleInstalls.map((install) => install.record.payload.installation_id)).size);
      let value: bigint | undefined;
      let undefined_reason: "no_attributed_cost" | "no_activity_events" | "empty_cohort" | undefined;
      if (definition.definition.calculation === "revenue_sum") {
        value = selectedRevenueValue;
      } else if (definition.definition.calculation === "revenue_over_cost") {
        const cost = currentCosts.reduce((sum, item) => {
          if (item.currency !== fxPolicy.target_currency) throw new Error(`cost currency mismatch: ${item.cost_record_id}`);
          return sum + scaleMoney(item, fxPolicy.target_scale);
        }, 0n);
        if (cost === 0n) {
          undefined_reason = "no_attributed_cost";
        } else {
          value = roundHalfEven(selectedRevenueValue * (10n ** BigInt(definition.ratio_scale ?? 6)), cost);
        }
      } else if (definition.definition.calculation === "active_installations_over_cohort") {
        if (cohortSize === 0n) {
          undefined_reason = "empty_cohort";
        } else {
          const activityEvents = new Set(definition.activity_events ?? ["session_start"]);
          const active = new Set<string>();
          for (const session of activities.filter((item) => activityEvents.has(item.record.event_name))) {
            const installation = installs.find((candidate) =>
              candidate.server.tenant_id === session.server.tenant_id && candidate.server.app_id === session.server.app_id &&
              candidate.record.payload.installation_id === session.record.payload.installation_id,
            );
            if (!installation) continue;
            const dayIndex = Math.floor((time(session.record.occurred_at, "occurred_at") - time(installation.record.occurred_at, "occurred_at")) / DAY_MS);
            if (dayIndex === definition.definition.window.day) active.add(installation.record.payload.installation_id);
          }
          value = roundHalfEven(BigInt(active.size) * (10n ** BigInt(definition.ratio_scale ?? 6)), cohortSize);
        }
      } else if (definition.definition.calculation === "revenue_over_cohort") {
        if (cohortSize === 0n) {
          undefined_reason = "empty_cohort";
        } else {
          value = roundHalfEven(selectedRevenueValue, cohortSize);
        }
      } else if (definition.definition.calculation === "cohort_size") {
        value = cohortSize;
      } else if (definition.definition.calculation === "event_count") {
        const eventNames = new Set<string>(definition.event_names ?? []);
        const eventName = [...eventNames][0];
        const metricDate = evaluation.grouping?.metric_date;
        if (metricDate === undefined) throw new Error(`event_count requires metric_date grouping: ${metricName}`);
        if (eventNames.size !== 1 || !["click", "install", "deep_link_open", "skan_postback", "adattributionkit_postback"].includes(eventName)) {
          throw new Error(`event_count requires exactly one supported event name: ${metricName}`);
        }
        const aggregatePostback = eventName === "skan_postback" || eventName === "adattributionkit_postback";
        if (aggregatePostback) {
          if (definition.aggregation_time_zone !== "UTC") {
            throw new Error(`aggregate event_count requires UTC aggregation: ${metricName}`);
          }
          if (evaluation.grouping?.attribution_status !== undefined) {
            throw new Error(`aggregate event_count forbids attribution_status: ${metricName}`);
          }
          const expectedEventName = metricName.startsWith("aak_attributed_")
            ? "adattributionkit_postback"
            : "skan_postback";
          if (!["skan_attributed_installs", "skan_conversion_value_distribution", "aak_attributed_installs", "aak_attributed_reengagements"].includes(metricName) || eventName !== expectedEventName) {
            throw new Error(`aggregate event_count metric and event mismatch: ${metricName}`);
          }
          const conversionBucket = evaluation.grouping?.apple_conversion_bucket;
          if (metricName === "skan_conversion_value_distribution" && conversionBucket === undefined) {
            throw new Error(`SKAN conversion distribution requires apple_conversion_bucket: ${metricName}`);
          }
          if (metricName !== "skan_conversion_value_distribution" && conversionBucket !== undefined) {
            throw new Error(`apple_conversion_bucket is reserved for SKAN conversion distribution: ${metricName}`);
          }
          value = BigInt(visible.filter((attempt) => {
            if (attempt.record.event_name !== eventName ||
                dateAt(attempt.record.received_at, "UTC", "received_at") !== metricDate) return false;
            if (metricName === "aak_attributed_installs" &&
                !["download", "redownload"].includes(attempt.record.payload.conversion_type)) return false;
            if (metricName === "aak_attributed_reengagements" &&
                attempt.record.payload.conversion_type !== "re-engagement") return false;
            const attribution = attributions.find((candidate) =>
              candidate.tenant_id === attempt.server.tenant_id &&
              candidate.app_id === attempt.server.app_id &&
              candidate.subject_scope === "aggregate" &&
              candidate.status === "non_organic" &&
              candidate.evidence_refs.some((reference) => reference.ref === attempt.record.record_id));
            if (!attribution) return false;
            if (conversionBucket === undefined) return true;
            const payload = attempt.record.payload;
            const actualBucket = payload.conversion_value !== undefined
              ? `fine:${payload.conversion_value}`
              : payload.coarse_conversion_value !== undefined
                ? `coarse:${payload.coarse_conversion_value}`
                : undefined;
            return actualBucket === conversionBucket;
          }).length);
        } else {
          if (evaluation.grouping?.apple_conversion_bucket !== undefined) {
            throw new Error(`apple_conversion_bucket requires aggregate SKAN events: ${metricName}`);
          }
          if (evaluation.grouping?.attribution_status !== undefined && !["install", "deep_link_open"].includes(eventName)) {
            throw new Error(`attribution_status event_count requires install or deep_link_open events: ${metricName}`);
          }
          value = BigInt(visible.filter((attempt) =>
            eventNames.has(attempt.record.event_name) &&
            (definition.fraud_policy !== "net" || attempt.record.event_name !== "install" ||
              !excludedInstallationIds.has(attempt.record.payload.installation_id)) &&
            matchesGrouping(attempt, evaluation.grouping, attributionStatuses) &&
            dateAt(attempt.record.occurred_at, definition.aggregation_time_zone, "occurred_at") === metricDate,
          ).length);
        }
      } else {
        throw new Error(`unsupported metric calculation: ${definition.definition.calculation}`);
      }
      if (definition.definition.calculation !== "event_count" && evaluation.grouping?.metric_date !== undefined) {
        throw new Error(`metric_date grouping is reserved for event_count: ${metricName}`);
      }
      const grouping = evaluation.grouping ? {
        dimensions: evaluation.grouping,
        dimension_digest: sha256(evaluation.grouping),
      } : undefined;
      const moneyFields = definition.value_type === "money" && value !== undefined ? {
        fx_rate_unscaled: fxRate.rate_unscaled,
        fx_rate_scale: fxRate.rate_scale,
        fx_rate_source: fxRate.source,
        fx_rate_as_of: fxRate.as_of,
        fx_rate_snapshot_id: sha256(fxPolicy.rates),
        fx_policy_version: fxPolicy.policy_version,
        amount_scale: definition.amount_scale,
        currency: definition.currency,
      } : {};
      output.push({
        metric_run_id: `${evaluation.metric_run_id_prefix}:${metricName}`,
        metric_name: metricName,
        metric_definition_version: definition.metric_definition_version,
        input_snapshot_id: sha256(snapshotRows),
        input_received_at_watermark: evaluation.input_received_at_watermark,
        input_ledger_position: ledger ? `${ledger[0]}|${ledger[1]}` : "empty",
        computed_at: evaluation.computed_at,
        data_freshness: evaluation.data_freshness,
        aggregation_time_zone: definition.aggregation_time_zone,
        rule_bundle_id: definition.rule_bundle_id,
        rule_bundle_version: definition.rule_bundle_version,
        rule_bundle_hash: definition.rule_bundle_hash,
        rounding_mode: fxPolicy.rounding_mode,
        reproducibility_status,
        value_type: definition.value_type,
        ...(definition.fraud_policy ? { fraud_policy: definition.fraud_policy } : {}),
        ...(value === undefined
          ? { value_state: "undefined" as const, undefined_reason }
          : { value_unscaled: value.toString() }),
        ...moneyFields,
        ...(definition.value_type === "ratio" ? { ratio_scale: definition.ratio_scale } : {}),
        ...(grouping ? { grouping } : {}),
        evidence_refs,
        ...(evaluation.supersedes_metric_run_id_prefix ? {
          supersedes_metric_run_id: `${evaluation.supersedes_metric_run_id_prefix}:${metricName}`,
        } : {}),
      });
    }
  }
  return sortByKey(output, (run) => [run.metric_run_id]);
}

function importedReconciliationInputs(accepted: Attempt[]): Any[] {
  return accepted
    .filter((attempt) => attempt.record.event_name === "install" && attempt.record.producer.startsWith("import:"))
    .map((attempt) => {
      const context = attempt.record.payload.import_context ?? {};
      const providerKey = (type: "provider_install_id" | "provider_click_id", value: string): Any => ({
        type,
        value: sha256({ provider: context.provider, type, value }),
        scope: "tenant_app",
        normalization: "identity",
        cardinality: "one_to_one",
        protected: true,
        value_encoding: "sha256",
        access_class: "protected",
      });
      const matching_keys: Any[] = [];
      if (context.provider_install_ref) {
        matching_keys.push(providerKey("provider_install_id", context.provider_install_ref));
      }
      if (context.provider_click_ref) {
        matching_keys.push(providerKey("provider_click_id", context.provider_click_ref));
      }
      return {
        reconciliation_id: `reconciliation:import:${attempt.record.record_id}`,
        tenant_id: attempt.server.tenant_id,
        app_id: attempt.server.app_id,
        input_snapshot_id: `snapshot:internal:${attempt.record.record_id}`,
        external_snapshot_id: `snapshot:provider:${attempt.record.record_id}`,
        matching_keys,
        provider_modeled_without_candidate:
          context.provider_attribution_strategy === "modeled" && matching_keys.length === 0,
        candidates: matching_keys.length ? [{
          candidate_id: attempt.record.record_id,
          tenant_id: attempt.server.tenant_id,
          app_id: attempt.server.app_id,
          matching_keys,
          window_status: "not_applicable",
          freshness: "current",
          excluded: false,
        }] : [],
        freshness: "current",
      };
    });
}

function scaleMoney(payload: Any, targetScale: number): bigint {
  const difference = targetScale - Number(payload.amount_scale);
  if (difference >= 0) return BigInt(payload.amount_unscaled) * (10n ** BigInt(difference));
  return roundHalfEven(BigInt(payload.amount_unscaled), 10n ** BigInt(-difference));
}

function matchesGrouping(
  attempt: Attempt,
  grouping: Any,
  attributionStatuses: Map<string, Attribution["status"]>,
): boolean {
  if (!grouping) return true;
  const payload = attempt.record.payload;
  const campaign = payload.campaign_id ?? attempt.server.deep_link_resolution?.campaign_id ?? payload.import_context?.provider_campaign_ref;
  const network = payload.network ?? payload.ad_network ?? payload.import_context?.provider_network;
  const country = payload.country ?? payload.import_context?.provider_country;
  if (grouping.campaign_id !== undefined && campaign !== grouping.campaign_id) return false;
  if (grouping.network !== undefined && network !== grouping.network) return false;
  if (grouping.country !== undefined && country !== grouping.country) return false;
  if (grouping.cohort_date !== undefined && attempt.record.event_name === "install" &&
      dateAt(attempt.record.occurred_at, "UTC", "occurred_at") !== grouping.cohort_date) return false;
  if (grouping.attribution_status !== undefined && ["install", "deep_link_open"].includes(attempt.record.event_name)) {
    const subjectRef = attempt.record.event_name === "install"
      ? attempt.record.payload.installation_id
      : `engagement:${attempt.record.record_id}`;
    const status = attributionStatuses.get(compositeKey([
      attempt.server.tenant_id,
      attempt.server.app_id,
      subjectRef,
    ]));
    if (status !== grouping.attribution_status) return false;
  }
  return true;
}

function eligibleRevenue(definition: MetricDefinition, install: Any, revenue: Any): boolean {
  const dayIndex = definition.definition.window.day;
  if (definition.definition.window.type === "calendar_day") {
    return dateAt(revenue.occurred_at, definition.aggregation_time_zone, "occurred_at") ===
      dateAt(new Date(time(install.occurred_at, "occurred_at") + dayIndex * DAY_MS).toISOString(), definition.aggregation_time_zone, "occurred_at");
  }
  const elapsed = time(revenue.occurred_at, "occurred_at") - time(install.occurred_at, "occurred_at");
  return elapsed >= 0 && elapsed < (dayIndex + 1) * DAY_MS;
}

function reconciliationResults(input: Any, accepted: Attempt[]): Reconciliation[] {
  const reconciliationInputs = [...(input.reconciliation_inputs ?? []), ...importedReconciliationInputs(accepted)];
  const identities = reconciliationInputs.map((item: Any) => compositeKey([item.tenant_id, item.app_id, item.reconciliation_id]));
  if (new Set(identities).size !== identities.length) throw new Error("duplicate reconciliation identity");
  const output: Reconciliation[] = reconciliationInputs.map((item: Any): Reconciliation => {
    const normalized = (entry: Any): string => {
      if (entry.normalization === "lowercase_ascii") return entry.value.replace(/[A-Z]/g, (character: string) => character.toLowerCase());
      if (entry.normalization === "trim") return entry.value.trim();
      return entry.value;
    };
    const key = (entry: Any) => `${entry.type}:${entry.value_encoding ? `${entry.value_encoding}:` : ""}${normalized(entry)}`;
    const externalKeys = new Set((item.matching_keys ?? []).map(key));
    const matched = (item.candidates ?? []).filter((candidate: Any) =>
      candidate.tenant_id === item.tenant_id && candidate.app_id === item.app_id &&
      (candidate.matching_keys ?? []).some((candidateKey: Any) => externalKeys.has(key(candidateKey))),
    );
    let difference_reason_code: Reconciliation["difference_reason_code"] = "matched";
    if (item.privacy_effect === "redaction") difference_reason_code = "redaction_caused_recalculation";
    else if (item.provider_modeled_without_candidate && !matched.length) difference_reason_code = "provider_modeled_conversion";
    else if (!externalKeys.size) difference_reason_code = "join_key_missing";
    else if (!matched.length && (item.matching_keys ?? []).some((entry: Any) =>
      ["provider_click_id", "provider_install_id"].includes(entry.type))) difference_reason_code = "candidate_missing";
    else if (!matched.length) difference_reason_code = "external_row_unmatched";
    else if (matched.length > 1 && item.matching_keys.some((entry: Any) => entry.cardinality === "one_to_one")) difference_reason_code = "join_key_ambiguous";
    else if (matched[0].excluded) difference_reason_code = "candidate_excluded";
    else if (matched[0].window_status === "out_of_window") difference_reason_code = "window_mismatch";
    else if (matched[0].freshness === "stale") difference_reason_code = "freshness_mismatch";
    const sortedKeys = [...(item.matching_keys ?? [])].sort((a, b) => compareText(key(a), key(b)));
    return {
      reconciliation_id: item.reconciliation_id,
      tenant_id: item.tenant_id,
      app_id: item.app_id,
      input_snapshot_id: item.input_snapshot_id,
      external_snapshot_id: item.external_snapshot_id,
      difference_reason_code,
      difference_reason_version: difference_reason_code === "provider_modeled_conversion" ? "0.4.0" : CONTRACT_VERSION,
      matching_keys: sortedKeys,
      candidates: matched.map((candidate: Any) => candidate.candidate_id).sort(compareText),
      exclusions: matched.filter((candidate: Any) => candidate.excluded).map((candidate: Any) => candidate.exclusion_reason).sort(compareText),
      windows: matched.map((candidate: Any) => `${candidate.candidate_id}:${candidate.window_status}`).sort(compareText),
      joins: matched.map((candidate: Any) => `${sortedKeys.map(key).join(",")}=>${candidate.candidate_id}`).sort(compareText),
      freshness: matched[0]?.freshness ?? item.freshness,
    };
  });
  return sortByKey(output, (result) => [result.reconciliation_id, result.tenant_id, result.app_id]);
}

export function evaluate(
  input: Any,
  candidateProviderFactory: CandidateProviderFactory = createFixtureCandidateProvider,
): EvaluationOutput {
  const all = sortCandidateAttempts(attempts(input));
  const candidates = candidateProviderFactory(all);
  assertImportProviderContexts(all);
  assertRevenueAnchorSources(all);
  assertScopedReferences(input, all);
  const decisionsList = all.map((attempt) => {
    try {
      return decide(attempt, candidates);
    } catch (error) {
      if (error instanceof TimestampInvalidError) return timestampInvalidDecision(attempt);
      throw error;
    }
  });
  const decisions = new Map(all.map((attempt, index) => [attemptDecisionKey(attempt), decisionsList[index]]));
  const preIngestionDecisions = (input.pre_ingestion_rejections ?? []).map(preIngestionDecision);
  const acceptedCandidates = candidates.all().filter((attempt) =>
    semanticCandidate(attempt)
    && decisionFor(decisions, attempt).ingestion_status === "accepted"
    && decisionFor(decisions, attempt).duplicate_resolution === "unique");
  assertInstallationAnchors([...acceptedCandidates], decisions);
  const lifecycle = privacyIndex(input);
  const acceptedUnique = all.filter((attempt) => {
    const decision = decisionFor(decisions, attempt);
    return decision.ingestion_status === "accepted" && decision.duplicate_resolution === "unique";
  });
  const conflictEvidence = all.filter((attempt) => decisionFor(decisions, attempt).reason_code === "event_id_conflict");
  const rawEvidence = [...acceptedUnique, ...conflictEvidence].filter((attempt) => !lifecycle.has(attemptEvidenceKey(attempt)));
  const logicalEvidence = acceptedUnique.filter((attempt) => !lifecycle.has(attemptEvidenceKey(attempt)));
  const raw_records = sortByKey(rawEvidence.map((attempt) => makeRawRecord(attempt, "available")),
    (record) => [record.record_id, record.tenant_id, record.app_id, record.delivery_id]);
  const deliveries = sortByKey([...all.map((attempt): Delivery => {
    const decision = decisionFor(decisions, attempt);
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
  }), ...preIngestionDecisions.map((decision: Any): Delivery => ({
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
  const currentClickIds = new Set(acceptedUnique
    .filter((attempt) => attempt.record.event_name === "click")
    .map((attempt) => attempt.record.payload.click_id)
    .filter((clickId): clickId is string => typeof clickId === "string" && clickId.length > 0));
  const impactedHistoricalInstalls = acceptedCandidates.filter((attempt) =>
    attempt.history_state !== undefined
    && attempt.record.event_name === "install"
    && typeof attempt.record.payload.click_id === "string"
    && currentClickIds.has(attempt.record.payload.click_id));
  const attributionInstallAttempts = [
    ...acceptedUnique.filter((attempt) => attempt.record.event_name === "install"),
    ...impactedHistoricalInstalls,
  ];
  const initialAttributions = sortByKey([
    ...attributionInstallAttempts
      .map((attempt) => makeAttribution(attempt, candidates, decisions, lifecycle)),
    ...acceptedUnique
      .filter((attempt) => ["skan_postback", "adattributionkit_postback"].includes(attempt.record.event_name))
      .map((attempt) => makeAggregatePostbackAttribution(attempt, lifecycle)),
    ...acceptedUnique
      .filter((attempt) => attempt.record.event_name === "deep_link_open")
      .map((attempt) => makeDeepLinkAttribution(attempt, lifecycle)),
  ],
  (attribution) => [attribution.attribution_id, attribution.tenant_id, attribution.app_id]);
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
  const transportFraud = acceptedUnique.flatMap((attempt): FraudDecision[] => {
    if (attempt.record.event_name !== "click"
      || (!attempt.record.payload.bot_prefetch && !attempt.record.payload.replay_suspected)) return [];
    const bound = boundFraudBundle(attempt.server);
    if (!bound) return [];
    const reason_code: FraudDecision["reason_code"] = attempt.record.payload.replay_suspected
      ? "replay_suspected" : "bot_prefetch";
    const ruleId = reason_code === "replay_suspected" ? "transport-replay-v1" : "transport-bot-prefetch-v1";
    const action = fraudRuleAction(bound.definition, ruleId, "exclude");
    return [{
      fraud_decision_id: `fraud:${attempt.record.record_id}`,
      subject_ref: attempt.record.record_id,
      decision: "suspected",
      action,
      reason_code,
      reason_code_version: CONTRACT_VERSION,
      evidence: [{
        type: reason_code === "replay_suspected" ? "replay_category" : "link_prefetch_category",
        captured_at: attempt.record.received_at,
        digest: sha256([reason_code, attempt.record.record_id]),
        access_class: "protected",
      }],
      rule_bundle_id: bound.definition.id,
      rule_bundle_version: bound.definition.version,
      rule_bundle_hash: bound.hash,
      rule_id: ruleId,
      evaluated_at: attempt.record.received_at,
      ...quarantineDeadline(action, attempt.record.received_at, bound.definition),
    }];
  });
  const installFraud = acceptedUnique.flatMap((attempt): FraudDecision[] => {
    if (attempt.record.event_name !== "install") return [];
    const bound = boundFraudBundle(attempt.server);
    if (!bound) return [];
    const payload = attempt.record.payload;
    const matchingClicks = payload.click_id ? acceptedCandidates.filter((candidate) =>
      candidate.server.tenant_id === attempt.server.tenant_id && candidate.server.app_id === attempt.server.app_id
      && candidate.record.event_name === "click" && candidate.record.payload.click_id === payload.click_id
      && candidate.record.payload.redirector_time_status !== "invalid" && candidate.record.payload.redirector_click_at,
    ) : [];
    const click = matchingClicks.length === 1 ? matchingClicks[0] : undefined;
    const thresholdSeconds = fraudNumberParameter(bound.definition, "ctit_lower_bound_seconds", 10);
    const configured = attempt.server.click_injection_policy ?? {
      threshold_seconds: thresholdSeconds,
      authority: "server",
      policy_version: `${bound.definition.id}:${bound.definition.version}`,
      policy_digest: clickInjectionPolicyDigest({
        threshold_seconds: thresholdSeconds,
        authority: "server",
        policy_version: `${bound.definition.id}:${bound.definition.version}`,
      }),
    };
    const hits = evaluateInstallRules({
      installBeginAtServer: payload.install_begin_at_server,
      referrerClickAtServer: payload.referrer_click_at_server,
      referrerClickAtServerStatus: payload.referrer_click_at_server_status,
      ...(click ? { redirectorClickAt: click.record.payload.redirector_click_at } : {}),
      policy: configured,
      bundle: bound.definition,
    });
    return hits.map((hit): FraudDecision => ({
      fraud_decision_id: hit.ruleId === "ctit-lower-bound-v1"
        ? `fraud:${attempt.record.record_id}:click-injection`
        : `fraud:${attempt.record.record_id}:${hit.ruleId}`,
      subject_ref: attempt.record.record_id,
      decision: hit.decision,
      action: hit.action,
      reason_code: hit.reasonCode,
      reason_code_version: CONTRACT_VERSION,
      evidence: [{
        type: hit.evidenceType,
        captured_at: attempt.record.received_at,
        digest: sha256([hit.ruleId, click?.record.record_id ?? "no-redirector-click", attempt.record.record_id]),
        access_class: "protected",
      }],
      rule_bundle_id: bound.definition.id,
      rule_bundle_version: bound.definition.version,
      rule_bundle_hash: bound.hash,
      rule_id: hit.ruleId,
      evaluated_at: attempt.record.received_at,
      ...quarantineDeadline(hit.action, attempt.record.received_at, bound.definition),
    }));
  });
  const sourceDayFraud = (input.source_day_aggregates ?? []).flatMap((aggregate: Any): FraudDecision[] => {
    const scopeAttempt = acceptedUnique.find((attempt) =>
      attempt.server.tenant_id === aggregate.tenant_id && attempt.server.app_id === aggregate.app_id);
    const bound = scopeAttempt ? boundFraudBundle(scopeAttempt.server) : { definition: FRAUD_BUNDLE, hash: FRAUD_BUNDLE_HASH };
    if (!bound) return [];
    const hit = evaluateSourceDayWithBundle({
      clicks: aggregate.clicks,
      installs: aggregate.installs,
      medianCvr: aggregate.medianCvr,
      ctitP50Ms: aggregate.ctitP50Ms,
      ctitP95Ms: aggregate.ctitP95Ms,
    }, bound.definition);
    if (!hit) return [];
    const sourceRef = `source:${aggregate.tenant_id}:${aggregate.app_id}:${aggregate.metric_date}:${aggregate.campaign_id}:${aggregate.network}:${aggregate.site_id}`;
    return [{
      fraud_decision_id: `fraud:${aggregate.input_snapshot_id}`,
      subject_scope: "source",
      subject_ref: sourceRef,
      decision: hit.decision,
      action: hit.action,
      reason_code: hit.reasonCode,
      reason_code_version: CONTRACT_VERSION,
      evidence: [{
        type: hit.evidenceType,
        captured_at: aggregate.computed_at,
        digest: aggregate.input_snapshot_id,
        access_class: "protected",
      }],
      rule_bundle_id: bound.definition.id,
      rule_bundle_version: bound.definition.version,
      rule_bundle_hash: bound.hash,
      rule_id: hit.ruleId,
      evaluated_at: aggregate.computed_at,
      ...quarantineDeadline(hit.action, aggregate.computed_at, bound.definition),
    }];
  });
  const fraud_decisions = sortByKey([...transportFraud, ...installFraud, ...sourceDayFraud],
    (decision) => [decision.fraud_decision_id]);
  const provisionalClockAttributions: Attribution[] = [];
  const sourceDays = new Map<string, Any[]>();
  for (const aggregate of input.source_day_aggregates ?? []) {
    const key = compositeKey([aggregate.tenant_id, aggregate.app_id, aggregate.metric_date]);
    sourceDays.set(key, [...(sourceDays.get(key) ?? []), aggregate]);
  }
  for (const aggregates of sourceDays.values()) {
    const aggregate = aggregates[0];
    const scopeAttempt = acceptedUnique.find((attempt) =>
      attempt.server.tenant_id === aggregate.tenant_id && attempt.server.app_id === aggregate.app_id);
    const bound = scopeAttempt ? boundFraudBundle(scopeAttempt.server) : { definition: FRAUD_BUNDLE, hash: FRAUD_BUNDLE_HASH };
    const installCount = aggregates.reduce((sum, item) => sum + Number(item.installs ?? 0), 0);
    if (!bound || installCount === 0) continue;
    const negativeCount = aggregates.reduce((sum, item) => sum + Number(item.ctitNegativeCount ?? 0), 0);
    const negativeRate = negativeCount / installCount;
    const threshold = fraudNumberParameter(bound.definition, "ctit_negative_rate_threshold", 0.05);
    if (negativeRate <= threshold) continue;
    const dailySnapshotId = sha256(aggregates.map((item) => String(item.input_snapshot_id)).sort());
    const computedAt = aggregates.map((item) => String(item.computed_at)).sort().at(-1)!;
    for (const install of acceptedUnique.filter((attempt) =>
      attempt.server.tenant_id === aggregate.tenant_id && attempt.server.app_id === aggregate.app_id
      && attempt.record.event_name === "install" && attempt.record.payload.click_id)) {
      const click = acceptedUnique.find((attempt) =>
        attempt.server.tenant_id === aggregate.tenant_id && attempt.server.app_id === aggregate.app_id
        && attempt.record.event_name === "click"
        && attempt.record.payload.click_id === install.record.payload.click_id
        && String(attempt.record.payload.redirector_click_at ?? "").slice(0, 10) === aggregate.metric_date);
      if (!click) continue;
      const prior = initialAttributions.find((item) => item.subject_ref === install.record.payload.installation_id);
      if (!prior || prior.reason_code !== "valid_install_referrer") continue;
      provisionalClockAttributions.push({
        ...prior,
        attribution_id: `${prior.attribution_id}:ctit-clock-provisional:${dailySnapshotId.slice(0, 12)}`,
        decided_at: computedAt,
        input_cutoff_at: computedAt,
        finality: "provisional",
        supersedes_attribution_id: prior.attribution_id,
      });
    }
  }
  const excludedClickIds = new Map<string, FraudDecision>();
  for (const click of acceptedCandidates.filter((attempt) =>
    attempt.record.event_name === "click" && attempt.history_state?.fraud_exclusion_id)) {
    if (!click.server.fraud_actions_enabled || !click.record.payload.click_id) continue;
    excludedClickIds.set(click.record.payload.click_id, {
      fraud_decision_id: click.history_state!.fraud_exclusion_id!,
    } as FraudDecision);
  }
  for (const decision of fraud_decisions.filter((item) => item.action === "exclude" && item.subject_scope !== "source")) {
    const click = acceptedCandidates.find((attempt) => attempt.record.record_id === decision.subject_ref && attempt.record.event_name === "click");
    if (click?.server.fraud_actions_enabled && click.record.payload.click_id) excludedClickIds.set(click.record.payload.click_id, decision);
  }
  const excludedInstallationIds = new Set<string>();
  const fraudAttributions: Attribution[] = [];
  for (const install of attributionInstallAttempts) {
    const decision = excludedClickIds.get(install.record.payload.click_id);
    if (!decision) continue;
    excludedInstallationIds.add(install.record.payload.installation_id);
    const prior = initialAttributions.find((item) => item.subject_ref === install.record.payload.installation_id);
    if (!prior) continue;
    fraudAttributions.push({
      ...prior,
      attribution_id: `${prior.attribution_id}:fraud`,
      status: "unattributed",
      method: "none",
      model: "none",
      reason_code: "fraud_excluded",
      finality: "final",
      fraud_decision_ref: decision.fraud_decision_id,
      supersedes_attribution_id: prior.attribution_id,
    });
  }
  const attributions = sortByKey([...initialAttributions, ...provisionalClockAttributions, ...fraudAttributions],
    (attribution) => [attribution.attribution_id, attribution.tenant_id, attribution.app_id]);
  const rejections = sortByKey([...decisionsList, ...preIngestionDecisions]
    .filter((decision) => decision.ingestion_status === "rejected")
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
  return {
    raw_records,
    deliveries,
    logical_events,
    corrections: sortByKey(corrections, (correction) => [
      correction.correction_id, correction.tenant_id, correction.app_id,
    ]),
    privacy_requests,
    privacy_tombstones,
    attributions,
    cost_records: costRecords(input),
    metric_definitions: metricDefinitions(input),
    metric_runs: metricRuns(input, all, decisions, lifecycle, attributions, excludedInstallationIds),
    fraud_decisions,
    rejections,
    reconciliation: reconciliationResults(input, acceptedUnique),
  };
}
