CREATE SCHEMA testing AUTHORIZATION openmmp_owner;
REVOKE ALL ON SCHEMA testing FROM PUBLIC;

CREATE TABLE testing.fixture_inputs (
  fixture_name text PRIMARY KEY,
  input_digest character(64) NOT NULL,
  input jsonb NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE testing.fixture_runs (
  fixture_name text PRIMARY KEY REFERENCES testing.fixture_inputs (fixture_name),
  input_digest character(64) NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE testing.fixture_attempts (
  fixture_name text NOT NULL REFERENCES testing.fixture_inputs (fixture_name) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  batch_id text NOT NULL,
  tenant_id text NOT NULL,
  app_id text NOT NULL,
  record_id text NOT NULL,
  producer text NOT NULL,
  event_id text NOT NULL,
  click_id text,
  server_context jsonb NOT NULL,
  record jsonb NOT NULL,
  PRIMARY KEY (fixture_name, ordinal)
);

CREATE INDEX fixture_attempts_record_idx
  ON testing.fixture_attempts (fixture_name, record_id);
CREATE INDEX fixture_attempts_logical_scope_idx
  ON testing.fixture_attempts (fixture_name, tenant_id, app_id, producer, event_id);
CREATE INDEX fixture_attempts_click_idx
  ON testing.fixture_attempts (fixture_name, tenant_id, app_id, click_id)
  WHERE click_id IS NOT NULL;

CREATE TABLE testing.fixture_artifacts (
  fixture_name text NOT NULL REFERENCES testing.fixture_runs (fixture_name) ON DELETE CASCADE,
  artifact_kind text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  source_table text NOT NULL,
  artifact_digest character(64) NOT NULL,
  artifact jsonb NOT NULL,
  PRIMARY KEY (fixture_name, artifact_kind, ordinal)
);

REVOKE ALL ON ALL TABLES IN SCHEMA testing FROM PUBLIC;
GRANT USAGE ON SCHEMA testing TO openmmp_seed;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA testing TO openmmp_seed;
