import { clickInjectionPolicyDigest, evaluateInstallRules, evaluateSourceDayWithBundle, fraudNumberParameter, fraudRuleAction } from "@openmasu/fraud-rules";
import { sha256 } from "./canonical.js";
import { boundFraudBundle, FRAUD_BUNDLE, FRAUD_BUNDLE_HASH, quarantineDeadline } from "./rule-bundles.js";
import { CONTRACT_VERSION, type Any, type Attempt, type Attribution, type EvaluationOutput, type FraudDecision } from "./evaluation-model.js";
import { compositeKey, sortByKey } from "./evaluation-utils.js";

export function fraudArtifacts(
  input: Any,
  acceptedUnique: Attempt[],
  acceptedCandidates: readonly Attempt[],
  attributionInstallAttempts: Attempt[],
  initialAttributions: Attribution[],
): Pick<EvaluationOutput, "attributions" | "fraud_decisions"> & { excludedInstallationIds: Set<string> } {
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
  return { attributions, fraud_decisions, excludedInstallationIds };
}
