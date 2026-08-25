CREATE INDEX ad_revenue_facts_installation_time_idx
  ON ledger.ad_revenue_facts (tenant_id, app_id, installation_id, occurred_at_ts);
