import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type { OpenMMPEvaluationOutputV01 as EvaluationOutput } from "./generated/contract-types.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Any = Record<string, any>;
type RawRecord = EvaluationOutput["raw_records"][number];
type Delivery = EvaluationOutput["deliveries"][number];
type LogicalEvent = EvaluationOutput["logical_events"][number];
type Correction = EvaluationOutput["corrections"][number];
type PrivacyRequest = EvaluationOutput["privacy_requests"][number];
type PrivacyTombstone = EvaluationOutput["privacy_tombstones"][number];
type Attribution = EvaluationOutput["attributions"][number];
type MetricRun = EvaluationOutput["metric_runs"][number];
type FraudDecision = EvaluationOutput["fraud_decisions"][number];
type Rejection = EvaluationOutput["rejections"][number];
type Reconciliation = EvaluationOutput["reconciliation"][number];
type EvidenceRef = Attribution["evidence_refs"][number];
type LifecycleStatus = EvidenceRef["lifecycle_status"];

const CONTRACT_VERSION = "0.1.0";
const HASH = "0".repeat(64);
const DAY_MS = 86_400_000;

export function jcs(value: unknown): string {
  return canonicalize(value);
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(jcs(value), "utf8").digest("hex");
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

type Attempt = { server: Any; record: Any; batch_id: string };

function attempts(input: Any): Attempt[] {
  if (Array.isArray(input.batches)) {
    return input.batches.flatMap((batch: Any) =>
      batch.records.map((record: Any) => ({ server: batch.server_context, record, batch_id: batch.batch_id })),
    );
  }
  return input.records.map((record: Any) => ({ server: input.server_context, record, batch_id: "batch-default" }));
}

function attemptOrder(a: Attempt, b: Attempt): number {
  const aKey = [
    a.record.received_at, a.record.record_id, a.record.delivery_id,
    a.server.tenant_id, a.server.app_id, a.record.schema_version, sha256(a.record),
  ];
  const bKey = [
    b.record.received_at, b.record.record_id, b.record.delivery_id,
    b.server.tenant_id, b.server.app_id, b.record.schema_version, sha256(b.record),
  ];
  for (let index = 0; index < aKey.length; index += 1) {
    const comparison = compareText(aKey[index], bKey[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function scopeKey(attempt: Attempt): string {
  const { server, record } = attempt;
  return compositeKey([server.tenant_id, server.app_id, record.producer, record.event_id]);
}

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
    sha256(attempt.record),
  ]);
}

function decisionFor(decisions: Map<string, Any>, attempt: Attempt): Any {
  const decision = decisions.get(attemptDecisionKey(attempt));
  if (!decision) throw new Error(`missing decision: ${attempt.record.delivery_id}`);
  return decision;
}

function assertInstallationAnchors(all: Attempt[], decisions: Map<string, Any>): void {
  const anchors = new Set<string>();
  const acceptedInstalls = all.filter((entry) => entry.record.event_name === "install" &&
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
      if (!exists(request.tenant_id, request.app_id, affected.record_id)) {
        throw new Error(`cross-scope or missing privacy reference: ${request.privacy_request_id}/${affected.record_id}`);
      }
    }
  }
  for (const correction of input.correction_inputs ?? []) {
    if (!exists(correction.tenant_id, correction.app_id, correction.corrects_record_id)) {
      throw new Error(`cross-scope or missing correction reference: ${correction.correction_id}`);
    }
  }
  for (const attempt of all.filter((entry) => entry.record.event_name === "refund")) {
    if (!exists(attempt.server.tenant_id, attempt.server.app_id, attempt.record.payload.correction_target_record_id)) {
      throw new Error(`cross-scope or missing refund target: ${attempt.record.record_id}`);
    }
  }
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

function decide(attempt: Attempt, orderedAttempts: Attempt[]): Any {
  const { server, record } = attempt;
  const sameRecordId = orderedAttempts.filter((candidate) => candidate.record.record_id === record.record_id);
  const sameKey = orderedAttempts.filter((candidate) => scopeKey(candidate) === scopeKey(attempt));
  const first = sameKey[0];
  const duplicate_resolution = sameRecordId.length > 1
    ? "record_id_collision"
    : first === attempt
    ? "unique"
    : sha256(first.record.payload) === sha256(record.payload)
      ? "duplicate_delivery"
      : "event_id_conflict";
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
  } else if (record.subject_scope === "aggregate" && record.payload?.installation_id) {
    ingestion_status = "rejected";
    reason_code = "aggregate_installation_join_forbidden";
  } else if (duplicate_resolution === "event_id_conflict") {
    ingestion_status = "rejected";
    reason_code = "event_id_conflict";
  }
  const canonical_record_id = duplicate_resolution === "unique" || duplicate_resolution === "record_id_collision"
    ? record.record_id : first.record.record_id;
  return {
    record_id: record.record_id,
    canonical_record_id,
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
  all: Attempt[],
  decisions: Map<string, Any>,
  lifecycle: Map<string, LifecycleStatus>,
): Attribution {
  const { server, record: install } = attempt;
  const payload = install.payload;
  const evidence = (ref: string): EvidenceRef => ({
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    ref,
    lifecycle_status: lifecycle.get(evidenceKey(server.tenant_id, server.app_id, ref)) ?? "available",
    access_class: "protected",
  });
  const base: Omit<Attribution, "status" | "method" | "model" | "reason_code"> = {
    attribution_id: `attr:${install.record_id}`,
    tenant_id: server.tenant_id,
    app_id: server.app_id,
    subject_scope: "installation_level",
    subject_ref: payload.installation_id,
    reason_code_version: CONTRACT_VERSION,
    evidence_refs: [evidence(install.record_id)],
    effective_at: install.occurred_at,
    decided_at: server.received_at,
    input_cutoff_at: server.received_at,
    finality: "final",
    rule_bundle_id: "attribution-default",
    rule_bundle_version: CONTRACT_VERSION,
    rule_bundle_hash: HASH,
  };
  const result = (
    status: Attribution["status"],
    method: Attribution["method"],
    model: Attribution["model"],
    reason_code: string,
    extra: Partial<Attribution> = {},
  ): Attribution => ({ ...base, status, method, model, reason_code, ...extra });
  if (payload.referrer_status === "none") return result("organic", "none", "none", "no_referrer");
  if (payload.referrer_status === "unsupported") return result("unattributed", "none", "none", "install_referrer_unsupported");
  if (payload.referrer_status === "unavailable") return result("unattributed", "none", "none", "install_referrer_unavailable");
  const clicks = all.filter((candidate) =>
    candidate.server.tenant_id === server.tenant_id && candidate.server.app_id === server.app_id &&
    candidate.record.event_name === "click" && candidate.record.payload.click_id === payload.click_id &&
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

function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("denominator must be positive");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const twice = remainder * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
  return negative ? -quotient : quotient;
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
): MetricRun[] {
  const evaluations = input.metric_evaluations ?? [];
  if (!evaluations.length) return [];
  const fxPolicy = input.fx_policy;
  const metricDefinitions: Array<{
    metric_name: MetricRun["metric_name"];
    aggregation_time_zone: MetricRun["aggregation_time_zone"];
    eligible: (install: Any, revenue: Any) => boolean;
  }> = [
    { metric_name: "d0_install_to_24h_ad_revenue_usd", aggregation_time_zone: "UTC", eligible: (install: Any, revenue: Any) => time(revenue.occurred_at, "occurred_at") >= time(install.occurred_at, "occurred_at") && time(revenue.occurred_at, "occurred_at") < time(install.occurred_at, "occurred_at") + DAY_MS },
    { metric_name: "d0_utc_install_calendar_ad_revenue_usd", aggregation_time_zone: "UTC", eligible: (install: Any, revenue: Any) => dateAt(revenue.occurred_at, "UTC", "occurred_at") === dateAt(install.occurred_at, "UTC", "occurred_at") },
    { metric_name: "d0_jst_install_calendar_ad_revenue_usd", aggregation_time_zone: "Asia/Tokyo", eligible: (install: Any, revenue: Any) => dateAt(revenue.occurred_at, "Asia/Tokyo", "occurred_at") === dateAt(install.occurred_at, "Asia/Tokyo", "occurred_at") },
  ];
  const output: MetricRun[] = [];
  for (const evaluation of evaluations) {
    const included = all.filter((attempt) =>
      decisionFor(decisions, attempt).ingestion_status === "accepted" &&
      decisionFor(decisions, attempt).duplicate_resolution === "unique" &&
      compareText(attempt.record.received_at, evaluation.input_received_at_watermark) <= 0,
    );
    const snapshotRows = [...included].sort(attemptOrder).map((attempt) => [
      attempt.record.received_at,
      attempt.record.record_id,
      evaluation.privacy_state === "after" ? (lifecycle.get(attemptEvidenceKey(attempt)) ?? "available") : "available",
      attempt.server.policy_digest,
    ]);
    const visible = included.filter((attempt) => evaluation.privacy_state !== "after" || !lifecycle.has(attemptEvidenceKey(attempt)));
    const installs = visible.filter((attempt) => attempt.record.event_name === "install");
    const revenue = visible.filter((attempt) => attempt.record.event_name === "ad_revenue");
    const affectedStates = evaluation.privacy_state === "after"
      ? included.map((attempt) => lifecycle.get(attemptEvidenceKey(attempt))).filter(Boolean)
      : [];
    const reproducibility_status = affectedStates.includes("redacted")
      ? "redaction_affected"
      : affectedStates.includes("purged") ? "retention_affected" : "fully_reproducible";
    const ledger = snapshotRows.at(-1);
    const evidence_refs: MetricRun["evidence_refs"] = [...included].sort(attemptOrder).map((attempt) => ({
      tenant_id: attempt.server.tenant_id,
      app_id: attempt.server.app_id,
      ref: attempt.record.record_id,
      lifecycle_status: evaluation.privacy_state === "after" ? (lifecycle.get(attemptEvidenceKey(attempt)) ?? "available") : "available",
      access_class: "protected",
    }));
    const fxRate = fxPolicy.rates.length === 1 ? fxPolicy.rates[0] : undefined;
    for (const definition of metricDefinitions) {
      let value = 0n;
      for (const item of revenue) {
        const installation = installs.find((candidate) =>
          candidate.server.tenant_id === item.server.tenant_id && candidate.server.app_id === item.server.app_id &&
          candidate.record.payload.installation_id === item.record.payload.installation_id,
        );
        if (installation && definition.eligible(installation.record, item.record)) value += convertMoney(item.record.payload, fxPolicy);
      }
      output.push({
        metric_run_id: `${evaluation.metric_run_id_prefix}:${definition.metric_name}`,
        metric_name: definition.metric_name,
        metric_definition_version: CONTRACT_VERSION,
        input_snapshot_id: sha256(snapshotRows),
        input_received_at_watermark: evaluation.input_received_at_watermark,
        input_ledger_position: ledger ? `${ledger[0]}|${ledger[1]}` : "empty",
        computed_at: evaluation.computed_at,
        data_freshness: evaluation.data_freshness,
        aggregation_time_zone: definition.aggregation_time_zone,
        rule_bundle_id: "metric-default",
        rule_bundle_version: CONTRACT_VERSION,
        rule_bundle_hash: HASH,
        fx_rate: fxRate ? `${fxRate.rate_unscaled}e-${fxRate.rate_scale}` : "snapshot",
        fx_rate_source: fxRate?.source ?? "fixture-rate-snapshot",
        fx_rate_as_of: fxRate?.as_of ?? evaluation.computed_at,
        fx_rate_snapshot_id: sha256(fxPolicy.rates),
        fx_policy_version: fxPolicy.policy_version,
        rounding_mode: fxPolicy.rounding_mode,
        reproducibility_status,
        value_unscaled: value.toString(),
        amount_scale: fxPolicy.target_scale,
        currency: fxPolicy.target_currency,
        evidence_refs,
        ...(evaluation.supersedes_metric_run_id_prefix ? {
          supersedes_metric_run_id: `${evaluation.supersedes_metric_run_id_prefix}:${definition.metric_name}`,
        } : {}),
      });
    }
  }
  return sortByKey(output, (run) => [run.metric_run_id]);
}

function reconciliationResults(input: Any): Reconciliation[] {
  const output: Reconciliation[] = (input.reconciliation_inputs ?? []).map((item: Any): Reconciliation => {
    const normalized = (entry: Any): string => {
      if (entry.normalization === "lowercase_ascii") return entry.value.replace(/[A-Z]/g, (character: string) => character.toLowerCase());
      if (entry.normalization === "trim") return entry.value.trim();
      return entry.value;
    };
    const key = (entry: Any) => `${entry.type}:${normalized(entry)}`;
    const externalKeys = new Set((item.matching_keys ?? []).map(key));
    const matched = (item.candidates ?? []).filter((candidate: Any) =>
      candidate.tenant_id === item.tenant_id && candidate.app_id === item.app_id &&
      (candidate.matching_keys ?? []).some((candidateKey: Any) => externalKeys.has(key(candidateKey))),
    );
    let difference_reason_code: Reconciliation["difference_reason_code"] = "matched";
    if (item.privacy_effect === "redaction") difference_reason_code = "redaction_caused_recalculation";
    else if (!externalKeys.size) difference_reason_code = "join_key_missing";
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
      difference_reason_version: CONTRACT_VERSION,
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

export function evaluate(input: Any): EvaluationOutput {
  const all = attempts(input).sort(attemptOrder);
  assertScopedReferences(input, all);
  const decisionsList = all.map((attempt) => decide(attempt, all));
  const decisions = new Map(all.map((attempt, index) => [attemptDecisionKey(attempt), decisionsList[index]]));
  assertInstallationAnchors(all, decisions);
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
  const deliveries = sortByKey(all.map((attempt): Delivery => {
    const decision = decisionFor(decisions, attempt);
    return {
      contract_version: CONTRACT_VERSION,
      delivery_id: attempt.record.delivery_id,
      record_id: attempt.record.record_id,
      canonical_record_id: decision.canonical_record_id,
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
    };
  }), (delivery) => [delivery.delivery_id, delivery.record_id, delivery.tenant_id, delivery.app_id]);
  const logical_events = sortByKey(logicalEvidence.map((attempt): LogicalEvent => ({
    contract_version: CONTRACT_VERSION,
    logical_event_id: `logical:${attempt.server.tenant_id}:${attempt.server.app_id}:${attempt.record.producer}:${attempt.record.event_id}`,
    record_id: attempt.record.record_id,
    tenant_id: attempt.server.tenant_id,
    app_id: attempt.server.app_id,
    producer: attempt.record.producer,
    event_id: attempt.record.event_id,
    event_name: attempt.record.event_name,
    lifecycle: "active",
    timeliness: attempt.record.late ? "late" : "on_time",
  })), (event) => [event.logical_event_id, event.tenant_id, event.app_id]);
  const attributions = sortByKey(acceptedUnique
    .filter((attempt) => attempt.record.event_name === "install")
    .map((attempt) => makeAttribution(attempt, all, decisions, lifecycle)),
  (attribution) => [attribution.attribution_id, attribution.tenant_id, attribution.app_id]);
  const corrections: Correction[] = [...(input.correction_inputs ?? [])];
  for (const attempt of acceptedUnique.filter((entry) => entry.record.event_name === "refund")) {
    corrections.push({
      contract_version: CONTRACT_VERSION,
      tenant_id: attempt.server.tenant_id,
      app_id: attempt.server.app_id,
      correction_id: `correction:${attempt.record.record_id}`,
      corrects_record_id: attempt.record.payload.correction_target_record_id,
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
    deletion_subject_ref: request.deletion_subject_ref,
    deletion_scope: request.deletion_scope,
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
        reason_digest: sha256(request.reason_code),
        policy_digest: sha256(request.policy_version),
        provenance_digest: sha256([
          request.tenant_id, request.app_id, request.privacy_request_id, affected.record_id, request.completed_at,
        ]),
        created_at: request.completed_at,
      });
    }
  }
  const privacy_tombstones = sortByKey(privacyTombstoneValues,
    (tombstone) => [tombstone.privacy_request_id, tombstone.record_id, tombstone.tenant_id, tombstone.app_id]);
  const fraud_decisions = sortByKey(acceptedUnique
    .filter((attempt) => attempt.record.event_name === "click" && attempt.record.payload.bot_prefetch)
    .map((attempt): FraudDecision => ({
      fraud_decision_id: `fraud:${attempt.record.record_id}`,
      subject_ref: attempt.record.record_id,
      decision: "suspected",
      action: "exclude",
      reason_code: "bot_prefetch",
      reason_code_version: CONTRACT_VERSION,
      evidence: [{
        type: "link_prefetch_category",
        captured_at: attempt.record.received_at,
        digest: sha256(["bot_prefetch", attempt.record.record_id]),
        access_class: "protected",
      }],
      rule_bundle_id: "fraud-public-envelope",
      rule_bundle_version: CONTRACT_VERSION,
      rule_bundle_hash: HASH,
      evaluated_at: attempt.record.received_at,
    })), (decision) => [decision.fraud_decision_id]);
  const rejections = sortByKey(decisionsList
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
    metric_runs: metricRuns(input, all, decisions, lifecycle),
    fraud_decisions,
    rejections,
    reconciliation: reconciliationResults(input),
  };
}
