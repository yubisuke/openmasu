-- Explicit bounded requests; original runs, definitions and cost history stay immutable.
CREATE TABLE control.metric_recalculation_jobs (
  recalculation_id control.identifier PRIMARY KEY,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  request_digest text NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  cost_import_run_id uuid NOT NULL,
  cost_snapshot_digest text NOT NULL CHECK (cost_snapshot_digest ~ '^[a-f0-9]{64}$'),
  date_from date NOT NULL,
  date_to date NOT NULL CHECK (date_to>=date_from AND date_to-date_from<31),
  watermark control.canonical_timestamp NOT NULL,
  created_at control.canonical_timestamp NOT NULL,
  UNIQUE (tenant_id,app_id,recalculation_id),
  UNIQUE (tenant_id,app_id,request_digest),
  FOREIGN KEY (tenant_id,app_id) REFERENCES control.apps (tenant_id,app_id)
);
CREATE TABLE control.metric_recalculation_items (
  recalculation_id control.identifier NOT NULL,
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  source_metric_run_id control.identifier NOT NULL,
  replay_digest text CHECK (replay_digest ~ '^[a-f0-9]{64}$'),
  replacement_metric_run_id control.identifier,
  state text NOT NULL CHECK (state IN ('queued','processing','retry','failed','completed','skipped','unavailable')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  safe_reason text CHECK (safe_reason IN ('replay_unavailable','definition_changed','already_superseded','privacy_pending','calculation_unavailable','retry_exhausted')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (recalculation_id,source_metric_run_id),
  CHECK ((lease_token IS NULL)=(lease_expires_at IS NULL)),
  FOREIGN KEY (tenant_id,app_id,recalculation_id)
    REFERENCES control.metric_recalculation_jobs (tenant_id,app_id,recalculation_id)
);
CREATE INDEX metric_recalculation_due_idx ON control.metric_recalculation_items (tenant_id,state,next_attempt_at);
CREATE INDEX metric_recalculation_source_idx ON control.metric_recalculation_items (tenant_id,app_id,source_metric_run_id);
ALTER TABLE control.metric_recalculation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.metric_recalculation_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_recalculation_jobs_tenant ON control.metric_recalculation_jobs
  USING (tenant_id=current_setting('openmasu.tenant_id',true)) WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
ALTER TABLE control.metric_recalculation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.metric_recalculation_items FORCE ROW LEVEL SECURITY;
CREATE POLICY metric_recalculation_items_tenant ON control.metric_recalculation_items
  USING (tenant_id=current_setting('openmasu.tenant_id',true)) WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE TRIGGER metric_recalculation_jobs_append_only BEFORE UPDATE OR DELETE ON control.metric_recalculation_jobs
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
REVOKE ALL ON control.metric_recalculation_jobs,control.metric_recalculation_items FROM PUBLIC;
GRANT SELECT,INSERT ON control.metric_recalculation_jobs TO openmasu_app;
GRANT SELECT,INSERT,UPDATE ON control.metric_recalculation_items TO openmasu_app;
GRANT SELECT ON control.metric_recalculation_jobs,control.metric_recalculation_items TO openmasu_reader;
GRANT TRUNCATE ON control.metric_recalculation_jobs,control.metric_recalculation_items TO openmasu_seed;
CREATE POLICY metric_recalculation_items_discovery_owner ON control.metric_recalculation_items
  FOR SELECT TO openmasu_owner USING (true);
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
  ORDER BY 1
$$;
