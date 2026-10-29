-- Deployment-wide safety metadata, not tenant or measurement data.
CREATE TABLE control.deployment_purpose (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  purpose text NOT NULL CHECK (purpose IN ('persistent', 'synthetic_disposable'))
);
INSERT INTO control.deployment_purpose (purpose)
VALUES (COALESCE(NULLIF(current_setting('openmasu.deployment_purpose', true), ''), 'persistent'));
REVOKE ALL ON control.deployment_purpose FROM PUBLIC, openmasu_app, openmasu_reader, openmasu_seed;
GRANT SELECT ON control.deployment_purpose TO openmasu_app, openmasu_reader, openmasu_seed;
