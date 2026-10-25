-- Bootstrap defaults grant SELECT on new tables. Target bindings are private;
-- readers receive only the aggregate receipt, never object references or keys.
REVOKE ALL ON control.retention_items FROM openmasu_reader;
