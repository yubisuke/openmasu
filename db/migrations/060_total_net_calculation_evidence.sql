-- Retain immutable v1 ad-revenue evidence while admitting v2 D30 total-net
-- aggregates. No historical run is backfilled or rewritten.
ALTER TABLE ledger.metric_calculation_evidence
  DROP CONSTRAINT metric_calculation_evidence_artifact_check;
ALTER TABLE ledger.metric_calculation_evidence
  ADD CONSTRAINT metric_calculation_evidence_artifact_check CHECK (
    artifact->>'calculation' = 'revenue_over_cost'
    AND ((artifact->>'version' = '1' AND artifact->>'numerator' = 'revenue')
      OR (artifact->>'version' = '2' AND artifact->>'numerator' = 'total_net_revenue'))
  );
