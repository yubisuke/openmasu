-- Provenance belongs to the storage receipt, never to operator-supplied snapshot JSON.
ALTER TABLE control.comparison_snapshots ADD COLUMN provenance jsonb NOT NULL
  DEFAULT '{"source":"operator_uploaded"}'::jsonb
  CHECK (jsonb_typeof(provenance)='object' AND octet_length(provenance::text)<=2048
    AND provenance->>'source' IN ('operator_uploaded','server_saved_runs'));
