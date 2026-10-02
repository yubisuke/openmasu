-- Preserve saved v1/v2 evidence and admit the explicitly opted-in v3 profile.
-- No historical artifact is rewritten and no schedule is upgraded.
ALTER TABLE ledger.metric_calculation_evidence
  DROP CONSTRAINT metric_calculation_evidence_artifact_check;
ALTER TABLE ledger.metric_calculation_evidence
  ADD CONSTRAINT metric_calculation_evidence_artifact_check CHECK (
    artifact->>'calculation' = 'revenue_over_cost'
    AND ((artifact->>'version' = '1' AND artifact->>'numerator' = 'revenue')
      OR (artifact->>'version' = '2' AND artifact->>'numerator' = 'total_net_revenue')
      OR ((artifact->>'version' = '3' AND artifact->>'numerator' = 'total_net_revenue'
        AND artifact->>'refund_reversal_policy' = 'cancel_target_refund_at_watermark'
        AND artifact->'operands'->>'refund_reversal_unscaled' ~ '^[0-9]+$'
        AND artifact->'operands'->>'refund_reversal_event_count' ~ '^[0-9]+$') IS TRUE))
  );
