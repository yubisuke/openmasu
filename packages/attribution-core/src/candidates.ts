import { sha256 } from "./canonical.js";
import { compareText, compositeKey } from "./evaluation-utils.js";
import type { Any, Attempt, CandidateAttempt, CandidateDecision, Decisions } from "./evaluation-model.js";

export function candidatePayloadDigest(attempt: Attempt): string {
  return attempt.history_state?.payload_sha256 ?? sha256(attempt.record.payload);
}

export function semanticCandidate(attempt: Attempt): boolean {
  return attempt.history_state?.semantic_available !== false;
}

export function attempts(input: Any): Attempt[] {
  if (Array.isArray(input.batches)) {
    return input.batches.flatMap((batch: Any) =>
      batch.records.map((record: Any) => ({ server: batch.server_context, record, batch_id: batch.batch_id })),
    );
  }
  return (input.records ?? []).map((record: Any) => ({ server: input.server_context, record, batch_id: "batch-default" }));
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

export function scopeKey(attempt: Attempt): string {
  const { server, record } = attempt;
  return compositeKey([server.tenant_id, server.app_id, record.producer, record.event_id]);
}

export function clickKey(tenantId: string, appId: string, clickId: string): string {
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

export function evidenceKey(tenantId: string, appId: string, recordId: string): string {
  return compositeKey([tenantId, appId, recordId]);
}

export function attemptEvidenceKey(attempt: Attempt): string {
  return evidenceKey(attempt.server.tenant_id, attempt.server.app_id, attempt.record.record_id);
}

// record_id is a server-generated global identity. Keep delivery context in
// the evaluator key so malformed collisions cannot overwrite each other.
export function attemptDecisionKey(attempt: Attempt): string {
  return compositeKey([
    attempt.batch_id, attempt.server.tenant_id, attempt.server.app_id,
    attempt.record.delivery_id, attempt.record.record_id, attempt.record.schema_version,
    attempt.history_state ? candidatePayloadDigest(attempt) : sha256(attempt.record),
  ]);
}

export function decisionFor(decisions: Decisions, attempt: Attempt): CandidateDecision {
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
