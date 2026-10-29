-- Capacity is the unresolved durable inbox, not retained history or fraud risk.
-- NULL means a pre-upgrade body whose plaintext byte size was not recorded.
ALTER TABLE ledger.ingest_batches ADD COLUMN body_bytes bigint CHECK (body_bytes >= 0);

CREATE TABLE control.inbox_admission_states (
  scope_key text PRIMARY KEY,
  blocked boolean NOT NULL
);
ALTER TABLE control.inbox_admission_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE control.inbox_admission_states FORCE ROW LEVEL SECURITY;
CREATE POLICY inbox_admission_owner ON control.inbox_admission_states
  TO openmasu_owner USING (true) WITH CHECK (true);
REVOKE ALL ON control.inbox_admission_states FROM PUBLIC, openmasu_app, openmasu_reader, openmasu_seed;
GRANT TRUNCATE ON control.inbox_admission_states TO openmasu_seed;
CREATE POLICY privacy_payload_purges_admission_owner ON control.privacy_payload_purges
  FOR SELECT TO openmasu_owner USING (true);
CREATE INDEX privacy_payload_purges_admission_idx ON control.privacy_payload_purges (tenant_id,app_id,payload_ref)
  WHERE status='purged';

-- Only the decision leaves this boundary: ordinary readers cannot obtain
-- cross-tenant totals or invoke the admission function. Existing SELECT-only
-- owner policies on ingest batches/states allow the bounded aggregate here.
CREATE FUNCTION control.admit_inbox_batch(
  _tenant_id text, _app_id text, _body_bytes bigint,
  _app_count bigint, _app_bytes bigint, _global_count bigint, _global_bytes bigint,
  _resume_percent integer
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog
AS $$
DECLARE
  app_key text := jsonb_build_array(_tenant_id, _app_id)::text;
  global_count bigint;
  global_bytes numeric;
  app_count bigint;
  app_bytes numeric;
  unknown_bytes boolean;
  global_blocked boolean;
  app_blocked boolean;
BEGIN
  IF _tenant_id IS DISTINCT FROM current_setting('openmasu.tenant_id', true)
    OR _app_id IS NULL OR _body_bytes IS NULL OR _body_bytes < 0
    OR least(_app_count, _app_bytes, _global_count, _global_bytes) < 1
    OR _app_count IS NULL OR _app_bytes IS NULL OR _global_count IS NULL OR _global_bytes IS NULL
    OR _resume_percent IS NULL OR _resume_percent NOT BETWEEN 1 AND 99 THEN
    RAISE EXCEPTION 'inbox_admission_scope_or_policy_invalid';
  END IF;
  -- Held through payload creation and the batch/state INSERT commit. The
  -- caller acquires its shared privacy tenant fence BEFORE this global lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('openmasu:inbox-admission:v1', 0));
  INSERT INTO control.inbox_admission_states VALUES ('global', false), (app_key, false)
    ON CONFLICT DO NOTHING;

  SELECT count(*), coalesce(sum(batch.body_bytes), 0),
    count(*) FILTER (WHERE batch.tenant_id=_tenant_id AND batch.app_id=_app_id),
    coalesce(sum(batch.body_bytes) FILTER (WHERE batch.tenant_id=_tenant_id AND batch.app_id=_app_id), 0),
    coalesce(bool_or(batch.body_bytes IS NULL), false)
  INTO global_count, global_bytes, app_count, app_bytes, unknown_bytes
  FROM ledger.ingest_batches AS batch
  JOIN LATERAL (
    SELECT state.status, state.reason_code FROM ledger.ingest_batch_states AS state
    WHERE state.ingest_batch_id=batch.ingest_batch_id
      AND state.tenant_id=batch.tenant_id AND state.app_id=batch.app_id
    ORDER BY state.ingest_batch_state_seq DESC LIMIT 1
  ) AS latest ON true
  WHERE (latest.status IN ('pending', 'failed')
    OR (latest.status='processed' AND latest.reason_code='post_processing_pending'))
    AND NOT EXISTS (
      SELECT 1 FROM control.privacy_payload_purges AS purge
      WHERE purge.tenant_id=batch.tenant_id AND purge.app_id=batch.app_id
        AND purge.payload_ref=batch.body_ref AND purge.status='purged'
    );
  IF unknown_bytes THEN RETURN 'inbox_capacity_unknown'; END IF;

  SELECT blocked INTO global_blocked FROM control.inbox_admission_states WHERE scope_key='global';
  SELECT blocked INTO app_blocked FROM control.inbox_admission_states WHERE scope_key=app_key;
  global_blocked := global_blocked AND NOT (global_count <= floor(_global_count::numeric*_resume_percent/100)
    AND global_bytes <= floor(_global_bytes::numeric*_resume_percent/100));
  app_blocked := app_blocked AND NOT (app_count <= floor(_app_count::numeric*_resume_percent/100)
    AND app_bytes <= floor(_app_bytes::numeric*_resume_percent/100));
  UPDATE control.inbox_admission_states SET blocked=global_blocked WHERE scope_key='global';
  UPDATE control.inbox_admission_states SET blocked=app_blocked WHERE scope_key=app_key;
  IF global_blocked OR global_count+1 > _global_count OR global_bytes+_body_bytes > _global_bytes THEN
    UPDATE control.inbox_admission_states SET blocked=true WHERE scope_key='global';
    RETURN 'inbox_global_capacity';
  END IF;
  IF app_blocked OR app_count+1 > _app_count OR app_bytes+_body_bytes > _app_bytes THEN
    UPDATE control.inbox_admission_states SET blocked=true WHERE scope_key=app_key;
    RETURN 'inbox_app_capacity';
  END IF;
  UPDATE control.inbox_admission_states
    SET blocked=(global_count+1 >= _global_count OR global_bytes+_body_bytes >= _global_bytes)
    WHERE scope_key='global';
  UPDATE control.inbox_admission_states
    SET blocked=(app_count+1 >= _app_count OR app_bytes+_body_bytes >= _app_bytes)
    WHERE scope_key=app_key;
  RETURN 'accepted';
END
$$;
REVOKE ALL ON FUNCTION control.admit_inbox_batch(text,text,bigint,bigint,bigint,bigint,bigint,integer) FROM PUBLIC, openmasu_reader, openmasu_seed;
GRANT EXECUTE ON FUNCTION control.admit_inbox_batch(text,text,bigint,bigint,bigint,bigint,bigint,integer) TO openmasu_app;
