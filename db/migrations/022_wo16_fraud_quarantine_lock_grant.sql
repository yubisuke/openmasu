-- SELECT ... FOR UPDATE SKIP LOCKED requires UPDATE even though the worker
-- resolves a quarantine row with a separate DELETE statement.
GRANT UPDATE ON ephemeral.fraud_quarantines TO openmasu_app;
