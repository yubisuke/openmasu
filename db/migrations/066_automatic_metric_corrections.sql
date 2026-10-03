-- Runtime receipts and bounded continuation; no measurement contract changes.
CREATE TABLE control.metric_correction_policies (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  enabled boolean NOT NULL,
  registered_at control.canonical_timestamp NOT NULL,
  PRIMARY KEY (tenant_id,app_id),
  FOREIGN KEY (tenant_id,app_id) REFERENCES control.apps (tenant_id,app_id)
);
CREATE TABLE control.metric_correction_receipts (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('cost_revision','late_events','attribution_revision')),
  source_ref text NOT NULL,
  definition jsonb NOT NULL,
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_cutoff control.canonical_timestamp,
  targets jsonb CHECK (jsonb_typeof(targets)='array' AND jsonb_array_length(targets)<=1000),
  continuation integer NOT NULL DEFAULT 0 CHECK (continuation BETWEEN 0 AND 1000),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','retry','completed','unavailable','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  safe_reason text CHECK (safe_reason IN ('privacy_pending','input_unavailable','unsupported_definition',
    'selection_limit','calculation_unavailable','waiting_for_predecessor','retry_exhausted','no_matching_runs')),
  recalculation_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(recalculation_ids)='array'),
  PRIMARY KEY (tenant_id,app_id,source_kind,source_ref),
  FOREIGN KEY (tenant_id,app_id) REFERENCES control.metric_correction_policies (tenant_id,app_id)
);
CREATE INDEX metric_correction_due_idx ON control.metric_correction_receipts (tenant_id,state,next_attempt_at,observed_at);
ALTER TABLE control.metric_correction_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.metric_correction_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_correction_policies_tenant ON control.metric_correction_policies
  USING (tenant_id=current_setting('openmasu.tenant_id',true)) WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
ALTER TABLE control.metric_correction_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.metric_correction_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_correction_receipts_tenant ON control.metric_correction_receipts
  USING (tenant_id=current_setting('openmasu.tenant_id',true)) WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE POLICY metric_correction_receipts_discovery_owner ON control.metric_correction_receipts FOR SELECT TO openmasu_owner USING (true);
REVOKE ALL ON control.metric_correction_policies,control.metric_correction_receipts FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON control.metric_correction_policies,control.metric_correction_receipts TO openmasu_app;
GRANT SELECT ON control.metric_correction_policies TO openmasu_reader;
-- Reader gets aggregate/status columns only, never device/source refs or private manifests.
GRANT SELECT (tenant_id,app_id,source_kind,observed_at,source_cutoff,continuation,state,attempts,
  next_attempt_at,safe_reason,recalculation_ids) ON control.metric_correction_receipts TO openmasu_reader;
GRANT TRUNCATE ON control.metric_correction_policies,control.metric_correction_receipts TO openmasu_seed;

-- Capture newly admitted evidence in the SAME publication transaction. No timestamp
-- high-water cursor can miss an older/backdated transaction that commits later.
-- Statement transition tables avoid one policy query per imported row. A paused
-- policy continues capturing receipts; only planning/publication is disabled.
CREATE FUNCTION control.capture_metric_correction_receipts() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='logical_events' THEN
    INSERT INTO control.metric_correction_receipts (tenant_id,app_id,source_kind,source_ref,definition,definition_digest)
    SELECT evidence.tenant_id,evidence.app_id,'late_events',evidence.record_id,policy.definition,policy.definition_digest
      FROM new_evidence AS evidence JOIN control.metric_correction_policies AS policy USING (tenant_id,app_id)
      WHERE evidence.event_name IN ('ad_revenue','purchase','refund') ON CONFLICT DO NOTHING;
  ELSIF TG_TABLE_NAME='cost_records' THEN
    INSERT INTO control.metric_correction_receipts (tenant_id,app_id,source_kind,source_ref,definition,definition_digest)
    SELECT DISTINCT evidence.tenant_id,evidence.app_id,'cost_revision',evidence.import_run_id::text,policy.definition,policy.definition_digest
      FROM new_evidence AS evidence JOIN control.metric_correction_policies AS policy USING (tenant_id,app_id)
      WHERE evidence.import_run_id IS NOT NULL ON CONFLICT DO NOTHING;
  ELSE
    INSERT INTO control.metric_correction_receipts (tenant_id,app_id,source_kind,source_ref,definition,definition_digest)
    SELECT evidence.tenant_id,evidence.app_id,'attribution_revision',evidence.attribution_id,policy.definition,policy.definition_digest
      FROM new_evidence AS evidence JOIN control.metric_correction_policies AS policy USING (tenant_id,app_id)
      WHERE evidence.subject_scope='installation_level' AND evidence.artifact ? 'supersedes_attribution_id' ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER logical_events_metric_correction_receipt AFTER INSERT ON ledger.logical_events
  REFERENCING NEW TABLE AS new_evidence FOR EACH STATEMENT EXECUTE FUNCTION control.capture_metric_correction_receipts();
CREATE TRIGGER cost_records_metric_correction_receipt AFTER INSERT ON ledger.cost_records
  REFERENCING NEW TABLE AS new_evidence FOR EACH STATEMENT EXECUTE FUNCTION control.capture_metric_correction_receipts();
CREATE TRIGGER attribution_metric_correction_receipt AFTER INSERT ON ledger.attribution_results
  REFERENCING NEW TABLE AS new_evidence FOR EACH STATEMENT EXECUTE FUNCTION control.capture_metric_correction_receipts();

ALTER TABLE control.metric_recalculation_jobs DROP CONSTRAINT metric_recalculation_trigger_kind_check,
  ADD CHECK (trigger_kind IN ('cost_revision','late_events','privacy_deletion','attribution_revision')),
  ADD COLUMN automatic_correction boolean NOT NULL DEFAULT false,
  ADD COLUMN attribution_revision_id control.identifier;
ALTER TABLE control.metric_recalculation_jobs DROP CONSTRAINT metric_recalculation_source_check,
  ADD CONSTRAINT metric_recalculation_source_check CHECK (
    (trigger_kind='cost_revision' AND cost_import_run_id IS NOT NULL AND cost_snapshot_digest IS NOT NULL
      AND source_snapshot_digest IS NULL AND source_records IS NULL AND input_status_counts IS NULL
      AND selection_status IS NULL AND privacy_request_id IS NULL AND attribution_revision_id IS NULL)
    OR (trigger_kind='late_events' AND cost_import_run_id IS NULL AND cost_snapshot_digest IS NULL
      AND source_snapshot_digest IS NOT NULL AND source_records IS NOT NULL AND jsonb_typeof(source_records)='array'
      AND jsonb_array_length(source_records)<=100 AND input_status_counts IS NOT NULL
      AND jsonb_typeof(input_status_counts)='object' AND selection_status IS NOT NULL
      AND privacy_request_id IS NULL AND attribution_revision_id IS NULL)
    OR (trigger_kind='privacy_deletion' AND cost_import_run_id IS NULL AND cost_snapshot_digest IS NULL
      AND source_snapshot_digest IS NOT NULL AND privacy_request_id IS NOT NULL AND source_records IS NULL
      AND input_status_counts IS NULL AND selection_status IS NULL AND attribution_revision_id IS NULL)
    OR (trigger_kind='attribution_revision' AND cost_import_run_id IS NULL AND cost_snapshot_digest IS NULL
      AND source_snapshot_digest IS NOT NULL AND attribution_revision_id IS NOT NULL AND source_records IS NULL
      AND input_status_counts IS NULL AND selection_status IS NULL AND privacy_request_id IS NULL)
  );

CREATE OR REPLACE FUNCTION control.list_m4_work_tenants()
RETURNS SETOF control.identifier LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT registration.tenant_id FROM control.apple_app_registrations AS registration
  UNION SELECT batch.tenant_id FROM ledger.ingest_batches_current AS batch
    WHERE batch.status='pending' OR (batch.status='processed' AND batch.reason_code='post_processing_pending')
  UNION SELECT lookup.tenant_id FROM ephemeral.adservices_lookups AS lookup
  UNION SELECT verification.tenant_id FROM ephemeral.integrity_verifications AS verification
  UNION SELECT verification.tenant_id FROM ephemeral.google_play_product_verifications AS verification
  UNION SELECT delivery.tenant_id FROM ephemeral.google_conversion_deliveries AS delivery
    WHERE delivery.state IN ('queued','http_accepted','diagnostics_processing')
  UNION SELECT readback.tenant_id FROM ephemeral.commerce_provider_readbacks AS readback
  UNION SELECT destination.tenant_id FROM control.operator_webhook_destinations_current AS destination WHERE destination.status='active'
  UNION SELECT delivery.tenant_id FROM ephemeral.operator_webhook_deliveries AS delivery WHERE delivery.state IN ('queued','retry')
  UNION SELECT destination.tenant_id FROM control.operator_bulk_export_destinations_current AS destination WHERE destination.status='active'
  UNION SELECT batch.tenant_id FROM ephemeral.operator_bulk_export_batches AS batch WHERE batch.state IN ('queued','retry')
  UNION SELECT job.tenant_id FROM control.privacy_deletion_jobs AS job WHERE job.status='processing'
  UNION SELECT schedule.tenant_id FROM control.metric_schedules_current AS schedule WHERE schedule.status='active'
  UNION SELECT schedule.tenant_id FROM control.cost_schedules_current AS schedule WHERE schedule.status='active'
  UNION SELECT item.tenant_id FROM control.metric_recalculation_items AS item WHERE item.state IN ('queued','processing','retry')
  UNION SELECT receipt.tenant_id FROM control.metric_correction_receipts AS receipt WHERE receipt.state IN ('queued','retry')
  ORDER BY 1
$$;
