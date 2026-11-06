-- Reuse the existing bounded correction receipts for late engagement evidence.
-- Logical facts and engagement attribution may commit separately: capture both
-- so planning between those commits cannot lose the later attribution result.
CREATE OR REPLACE FUNCTION control.capture_metric_correction_receipts() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='logical_events' THEN
    INSERT INTO control.metric_correction_receipts (tenant_id,app_id,source_kind,source_ref,definition,definition_digest)
    SELECT evidence.tenant_id,evidence.app_id,'late_events',evidence.record_id,policy.definition,policy.definition_digest
      FROM new_evidence AS evidence JOIN control.metric_correction_policies AS policy USING (tenant_id,app_id)
      WHERE evidence.event_name IN ('ad_revenue','purchase','refund','custom_event','session_start','deep_link_open','install')
      ON CONFLICT DO NOTHING;
  ELSIF TG_TABLE_NAME='cost_records' THEN
    INSERT INTO control.metric_correction_receipts (tenant_id,app_id,source_kind,source_ref,definition,definition_digest)
    SELECT DISTINCT evidence.tenant_id,evidence.app_id,'cost_revision',evidence.import_run_id::text,policy.definition,policy.definition_digest
      FROM new_evidence AS evidence JOIN control.metric_correction_policies AS policy USING (tenant_id,app_id)
      WHERE evidence.import_run_id IS NOT NULL ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO control.metric_correction_receipts (tenant_id,app_id,source_kind,source_ref,definition,definition_digest)
    SELECT evidence.tenant_id,evidence.app_id,'attribution_revision',evidence.attribution_id,policy.definition,policy.definition_digest
      FROM new_evidence AS evidence JOIN control.metric_correction_policies AS policy USING (tenant_id,app_id)
      WHERE evidence.subject_scope='engagement_level'
        OR (evidence.subject_scope='installation_level' AND evidence.artifact ? 'supersedes_attribution_id')
      ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
