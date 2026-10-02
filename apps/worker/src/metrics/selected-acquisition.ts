/** Bound parameters: tenant $1, app $2, received-at watermark $3. */
export const selectedAcquisitionSql = `
  WITH eligible AS (
    SELECT candidate.* FROM ledger.attribution_results AS candidate
    WHERE candidate.tenant_id=$1 AND candidate.app_id=$2
      AND candidate.subject_scope='installation_level'
      AND candidate.decided_at <= $3
      AND candidate.artifact->>'input_cutoff_at' <= $3
      AND EXISTS (
        SELECT 1 FROM ledger.install_facts AS install
        JOIN ledger.logical_events AS event USING (logical_event_id)
        JOIN ledger.raw_records_current AS raw
          ON raw.tenant_id=event.tenant_id AND raw.app_id=event.app_id AND raw.record_id=event.record_id
        WHERE install.tenant_id=$1 AND install.app_id=$2
          AND install.installation_id=candidate.subject_ref AND raw.received_at <= $3
      )
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(candidate.artifact->'evidence_refs') AS ref
        WHERE ref->>'tenant_id' <> $1 OR ref->>'app_id' <> $2 OR NOT EXISTS (
          SELECT 1 FROM ledger.logical_events AS event
          JOIN ledger.raw_records_current AS raw
            ON raw.tenant_id=event.tenant_id AND raw.app_id=event.app_id AND raw.record_id=event.record_id
          WHERE event.tenant_id=$1 AND event.app_id=$2 AND event.record_id=ref->>'ref'
            AND raw.received_at <= $3
        )
      )
  )
  SELECT DISTINCT ON (candidate.subject_ref COLLATE "C") candidate.* FROM eligible AS candidate
  WHERE NOT EXISTS (
    SELECT 1 FROM eligible AS newer
    WHERE newer.artifact->>'supersedes_attribution_id'=candidate.attribution_id
  )
  ORDER BY candidate.subject_ref COLLATE "C", candidate.decided_at DESC, candidate.attribution_id COLLATE "C" DESC
`;

/** Only an attribution's chosen evidence can supply dimensions; click_id alone is never enough. */
export const selectedClickJoinSql = `
  LEFT JOIN acquisition ON acquisition.subject_ref=install.installation_id
  LEFT JOIN LATERAL (
    SELECT min(click.campaign_id) AS campaign_id, min(click.network) AS network
    FROM ledger.click_facts AS click
    JOIN ledger.logical_events AS click_event USING (logical_event_id)
    JOIN ledger.raw_records_current AS click_raw
      ON click_raw.tenant_id=click_event.tenant_id AND click_raw.app_id=click_event.app_id
     AND click_raw.record_id=click_event.record_id
    WHERE $18::boolean AND logical.producer NOT LIKE 'import:%'
      AND acquisition.status='non_organic' AND acquisition.method='install_referrer'
      AND acquisition.reason_code='valid_install_referrer'
      AND click.tenant_id=install.tenant_id AND click.app_id=install.app_id
      AND click.click_id=install.click_id AND click_raw.received_at <= $3
      AND ($15='before' OR click_raw.payload_lifecycle_status='available')
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(acquisition.artifact->'evidence_refs') AS ref
        WHERE ref->>'ref'=click_event.record_id AND ref->>'tenant_id'=click.tenant_id AND ref->>'app_id'=click.app_id
      )
    HAVING count(*)=1
  ) AS acquisition_source ON true
`;
