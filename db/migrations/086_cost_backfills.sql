-- Only fixed, non-secret acquisition limits are exposed to read-only previews.
CREATE FUNCTION control.cost_backfill_configuration(definition jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_build_object('provider',definition->'provider','api_version',definition->'api_version',
    'currency',definition->'currency','lag_days',definition->'lag_days','limits',definition->'limits')
$$;
ALTER TABLE control.cost_schedules ADD COLUMN backfill_configuration jsonb
  GENERATED ALWAYS AS (control.cost_backfill_configuration(definition)) STORED;
GRANT SELECT(backfill_configuration) ON control.cost_schedules TO openmasu_reader;

CREATE TABLE control.cost_backfills (
  receipt text PRIMARY KEY CHECK (receipt ~ '^[a-f0-9]{64}$'),
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  cost_schedule_id control.identifier NOT NULL,
  definition_digest text NOT NULL CHECK (definition_digest ~ '^[a-f0-9]{64}$'),
  as_of control.canonical_timestamp NOT NULL,
  parent_receipt text,
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='object' AND octet_length(plan::text)<=65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id,app_id,cost_schedule_id,receipt),
  FOREIGN KEY (tenant_id,app_id,cost_schedule_id) REFERENCES control.cost_schedules(tenant_id,app_id,cost_schedule_id),
  FOREIGN KEY (tenant_id,app_id,cost_schedule_id,parent_receipt) REFERENCES control.cost_backfills(tenant_id,app_id,cost_schedule_id,receipt)
);
CREATE TABLE control.cost_backfill_days (
  tenant_id control.identifier NOT NULL,
  app_id control.identifier NOT NULL,
  cost_schedule_id control.identifier NOT NULL,
  receipt text NOT NULL,
  target_date date NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','processing','retry','complete','empty','failed','stopped','skipped')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  safe_reason text CHECK (safe_reason IN ('source_unavailable','source_rejected','source_invalid','acquisition_timeout',
    'retry_exhausted','reauth_required','schedule_stopped','configuration_changed','covered_by_refresh')),
  row_count integer CHECK (row_count BETWEEN 0 AND 100000),
  import_run_id uuid,
  snapshot_digest text CHECK (snapshot_digest ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (receipt,target_date),
  UNIQUE (tenant_id,app_id,cost_schedule_id,receipt,target_date),
  FOREIGN KEY (tenant_id,app_id,cost_schedule_id,receipt) REFERENCES control.cost_backfills(tenant_id,app_id,cost_schedule_id,receipt)
);
ALTER TABLE control.cost_schedule_checkpoints ADD COLUMN backfill_receipt text;
ALTER TABLE control.cost_schedule_checkpoints ADD COLUMN backfill_day date;
ALTER TABLE control.cost_schedule_checkpoints ADD CONSTRAINT cost_backfill_claim_pair
  CHECK ((backfill_receipt IS NULL)=(backfill_day IS NULL));
ALTER TABLE control.cost_schedule_checkpoints ADD CONSTRAINT cost_backfill_claim_scope
  FOREIGN KEY (tenant_id,app_id,cost_schedule_id,backfill_receipt,backfill_day)
  REFERENCES control.cost_backfill_days(tenant_id,app_id,cost_schedule_id,receipt,target_date);
CREATE INDEX cost_backfill_due ON control.cost_backfill_days(tenant_id,state,next_attempt_at);
CREATE INDEX cost_backfill_history ON control.cost_backfills(tenant_id,app_id,created_at DESC,receipt);
CREATE INDEX cost_backfill_day_scope ON control.cost_backfill_days(tenant_id,app_id,cost_schedule_id,target_date);
ALTER TABLE control.cost_backfills ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.cost_backfills FORCE ROW LEVEL SECURITY;
ALTER TABLE control.cost_backfill_days ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.cost_backfill_days FORCE ROW LEVEL SECURITY;
CREATE POLICY cost_backfills_tenant ON control.cost_backfills
  USING (tenant_id=current_setting('openmasu.tenant_id',true)) WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE POLICY cost_backfill_days_tenant ON control.cost_backfill_days
  USING (tenant_id=current_setting('openmasu.tenant_id',true)) WITH CHECK (tenant_id=current_setting('openmasu.tenant_id',true));
CREATE TRIGGER cost_backfills_append_only BEFORE UPDATE OR DELETE ON control.cost_backfills
  FOR EACH ROW EXECUTE FUNCTION ledger.reject_append_only_mutation();
CREATE FUNCTION control.guard_cost_backfill_day() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id,NEW.app_id,NEW.cost_schedule_id,NEW.receipt,NEW.target_date)
    IS DISTINCT FROM (OLD.tenant_id,OLD.app_id,OLD.cost_schedule_id,OLD.receipt,OLD.target_date)
    OR (OLD.state IN ('complete','empty','failed','stopped','skipped') AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'cost backfill identity and terminal results are immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER cost_backfill_day_identity BEFORE UPDATE ON control.cost_backfill_days
  FOR EACH ROW EXECUTE FUNCTION control.guard_cost_backfill_day();
REVOKE ALL ON control.cost_backfills,control.cost_backfill_days FROM PUBLIC;
GRANT SELECT,INSERT ON control.cost_backfills TO openmasu_app;
GRANT SELECT,INSERT,UPDATE ON control.cost_backfill_days TO openmasu_app;
GRANT SELECT ON control.cost_backfills,control.cost_backfill_days TO openmasu_reader;
GRANT TRUNCATE ON control.cost_backfills,control.cost_backfill_days TO openmasu_seed;
