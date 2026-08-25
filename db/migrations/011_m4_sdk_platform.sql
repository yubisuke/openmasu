ALTER TABLE control.sdk_keys
  ADD COLUMN platform text
  CHECK (platform IS NULL OR platform IN ('android', 'ios'));

-- The pre-M4 view expanded key.* when it was created, so adding the table
-- column does not automatically expose it. Append the new column to preserve
-- every existing view-column position for current consumers.
CREATE OR REPLACE VIEW control.sdk_keys_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (key.sdk_key_id)
  key.sdk_key_id,
  key.tenant_id,
  key.app_id,
  key.secret_ref,
  key.created_at,
  key.artifact,
  state.status,
  state.changed_at AS status_changed_at,
  key.platform
FROM control.sdk_keys AS key
JOIN control.sdk_key_states AS state USING (sdk_key_id, tenant_id, app_id)
ORDER BY key.sdk_key_id, state.sdk_key_state_seq DESC;

COMMENT ON COLUMN control.sdk_keys.platform IS
  'Issuing SDK platform. NULL preserves pre-M4 key rows; new issuance must set android or ios.';
