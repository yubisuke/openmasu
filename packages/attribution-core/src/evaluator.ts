import { attempts, sortCandidateAttempts, attemptDecisionKey, decisionFor, semanticCandidate, createFixtureCandidateProvider, type CandidateProviderFactory } from "./candidates.js";
import { assertImportProviderContexts, assertRevenueAnchorSources, assertScopedReferences, assertInstallationAnchors, decide, timestampInvalidDecision, preIngestionDecision, privacyIndex } from "./ingestion-decisions.js";
import { sortByKey, TimestampInvalidError } from "./evaluation-utils.js";
import { initialAttributionArtifacts } from "./attribution.js";
import { fraudArtifacts } from "./fraud-artifacts.js";
import { ingestionArtifacts, privacyArtifacts, rejectionArtifacts } from "./evidence-artifacts.js";
import { costRecords, metricDefinitions, metricRuns } from "./metric-runs.js";
import { reconciliationResults } from "./reconciliation.js";
import type { Any, EvaluationOutput } from "./evaluation-model.js";

export { jcs, sha256 } from "./canonical.js";
export { selectDisjointCosts, type ScopedCost } from "./cost-selection.js";
export { TimestampInvalidError, roundHalfEven } from "./evaluation-utils.js";
export type { Json, CandidateHistoryState, CandidateAttempt } from "./evaluation-model.js";
export {
  compareCandidateAttempts, sortCandidateAttempts, FixtureArrayCandidateProvider, IndexedCandidateProvider,
  createFixtureCandidateProvider, createIndexedCandidateProvider,
  type CandidateProvider, type CandidateProviderFactory,
} from "./candidates.js";

/** Pure orchestration; clocks, policy revisions and candidate history come from the caller. */
export function evaluate(
  input: Any,
  candidateProviderFactory: CandidateProviderFactory = createFixtureCandidateProvider,
): EvaluationOutput {
  const all = sortCandidateAttempts(attempts(input));
  const candidates = candidateProviderFactory(all);
  assertImportProviderContexts(all);
  assertRevenueAnchorSources(all);
  // Runtime providers may supply bounded ledger-backed targets that are not
  // current deliveries. Reference validation must see that scoped history,
  // while emitted records and decisions remain limited to the input attempts.
  assertScopedReferences(input, candidates.all());
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

  const ingestion = ingestionArtifacts(all, decisions, preIngestionDecisions, acceptedUnique, lifecycle);
  const initial = initialAttributionArtifacts(acceptedUnique, acceptedCandidates, candidates, decisions, lifecycle);
  const privacy = privacyArtifacts(input, acceptedUnique, acceptedCandidates);
  const { attributions, fraud_decisions, excludedInstallationIds } = fraudArtifacts(
    input, acceptedUnique, acceptedCandidates, initial.attributionInstallAttempts, initial.initialAttributions,
  );
  const rejections = rejectionArtifacts(decisionsList, preIngestionDecisions);
  return {
    ...ingestion,
    corrections: sortByKey(privacy.corrections, (correction) => [
      correction.correction_id, correction.tenant_id, correction.app_id,
    ]),
    privacy_requests: privacy.privacy_requests,
    privacy_tombstones: privacy.privacy_tombstones,
    attributions,
    cost_records: costRecords(input),
    metric_definitions: metricDefinitions(input),
    metric_runs: metricRuns(input, all, decisions, lifecycle, attributions, excludedInstallationIds),
    fraud_decisions,
    rejections,
    reconciliation: reconciliationResults(input, acceptedUnique),
  };
}
