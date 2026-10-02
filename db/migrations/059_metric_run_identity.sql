-- A snapshot identifies input evidence, not a computation. Different schedules,
-- cutoffs or complete definitions may legitimately share the same snapshot.
-- Keep the run-id primary key, append-only triggers and scoped foreign keys.
DO $$
DECLARE snapshot_constraint text;
BEGIN
  SELECT constraint_row.conname INTO STRICT snapshot_constraint
    FROM pg_constraint AS constraint_row
   WHERE constraint_row.conrelid='ledger.metric_runs'::regclass
     AND constraint_row.contype='u'
     AND ARRAY(
       SELECT attribute.attname::text
         FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, position)
         JOIN pg_attribute AS attribute
           ON attribute.attrelid=constraint_row.conrelid AND attribute.attnum=key_column.attnum
        ORDER BY key_column.position
     ) = ARRAY['tenant_id','app_id','metric_name','metric_definition_version',
               'grouping_digest','input_snapshot_id'];
  EXECUTE format('ALTER TABLE ledger.metric_runs DROP CONSTRAINT %I', snapshot_constraint);
END $$;

CREATE INDEX metric_runs_snapshot_lookup_idx ON ledger.metric_runs
  (tenant_id,app_id,metric_name,metric_definition_version,grouping_digest,input_snapshot_id);
