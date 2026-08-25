-- The SECURITY DEFINER host resolver is owned by openmasu_owner, which remains
-- subject to FORCE RLS. Permit that non-login owner to read only link-domain
-- registrations while keeping direct application access tenant-scoped.
DROP POLICY link_domains_tenant ON control.link_domains;

CREATE POLICY link_domains_tenant ON control.link_domains
  USING (
    tenant_id=current_setting('openmasu.tenant_id', true)
    OR current_user='openmasu_owner'
  )
  WITH CHECK (tenant_id=current_setting('openmasu.tenant_id', true));
