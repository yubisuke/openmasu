-- Expose additive fraud definition columns through the current-revision view.
-- PostgreSQL expands SELECT * when a view is created, so migration 015's new
-- columns are not visible until the view definition is replaced explicitly.
CREATE OR REPLACE VIEW control.rule_bundles_current
WITH (security_invoker = true)
AS
SELECT revision.*
FROM control.rule_bundle_revisions AS revision
WHERE NOT EXISTS (
  SELECT 1
  FROM control.rule_bundle_revisions AS successor
  WHERE successor.tenant_id=revision.tenant_id
    AND successor.app_id=revision.app_id
    AND successor.supersedes_rule_bundle_revision_id=revision.rule_bundle_revision_id
);
