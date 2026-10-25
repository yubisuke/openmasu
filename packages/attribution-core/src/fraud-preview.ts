import { fraudBundleHash, sha256Jcs, type FraudBundle } from "@openmasu/fraud-rules";
import { sha256 } from "./canonical.js";
import { sortCandidateAttempts } from "./candidates.js";
import { fraudArtifacts } from "./fraud-artifacts.js";
import { metricRuns } from "./metric-runs.js";
import type { Any, Attribution, CandidateAttempt } from "./evaluation-model.js";

/**
 * Counterfactual projection of already-admitted, currently available evidence.
 * This is NOT an admission path: callers must select accepted logical records,
 * enforce scope/privacy/retention and reject incomplete input before calling.
 * Both branches reuse the ordinary evaluator's fraud and metric projections.
 */
export function previewAcceptedFraudEvidence(input: {
  readonly attempts: readonly CandidateAttempt[];
  readonly initialAttributions: readonly Attribution[];
  readonly metricInput: Any;
  readonly definition: FraudBundle;
}) {
  const definition = structuredClone(input.definition), hash = fraudBundleHash(definition);
  const scopes = new Set(input.attempts.map(attempt => `${attempt.server.tenant_id}\0${attempt.server.app_id}`));
  if (scopes.size > 1) throw new Error("fraud_preview_scope_mismatch");
  if (new Set(input.attempts.map(attempt => attempt.record.record_id)).size !== input.attempts.length) {
    throw new Error("fraud_preview_duplicate_evidence");
  }
  const attempts = sortCandidateAttempts(input.attempts.map(attempt => {
    const server: Any = { ...attempt.server, fraud_enabled: true, fraud_actions_enabled: true,
      fraud_rule_bundle: { rule_bundle_id: definition.id,rule_bundle_version: definition.version,
        rule_bundle_hash: hash,definition_digest: sha256Jcs(definition),definition } };
    // The candidate bundle, not a previous delivery's threshold, owns this what-if.
    delete server.click_injection_policy;
    return { ...attempt,server,history_state: { payload_sha256: attempt.history_state?.payload_sha256 ?? sha256(attempt.record.payload),
      semantic_available: true,ledger_position: "preview" } };
  }));
  const fraud = fraudArtifacts(input.metricInput,attempts,attempts,
    attempts.filter(attempt=>attempt.record.event_name === "install"),structuredClone([...input.initialAttributions]),{definition,hash});
  return { fraud_decisions:fraud.fraud_decisions,attributions:fraud.attributions,
    metric_runs:metricRuns(input.metricInput,attempts,new Map(),new Map(),fraud.attributions,fraud.excludedInstallationIds) };
}
