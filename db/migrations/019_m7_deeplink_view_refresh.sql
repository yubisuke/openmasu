-- Refresh the tracking-link projection after M7 added deep-link columns.
-- PostgreSQL expands SELECT * when a view is created, so migration 018's
-- additive base-table columns are not visible until the view is recreated.
DROP VIEW control.tracking_links_current;

CREATE VIEW control.tracking_links_current
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (link.tracking_link_id)
  link.*, state.status, state.changed_at AS status_changed_at, state.reason_code
FROM control.tracking_links AS link
JOIN control.tracking_link_states AS state USING (tracking_link_id, tenant_id, app_id)
ORDER BY link.tracking_link_id, state.tracking_link_state_seq DESC;
