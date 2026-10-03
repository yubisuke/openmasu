import type { PoolClient } from "pg";
import type { OpenMasuAttributionResultV04 } from "@openmasu/contracts/types";
import { sha256 } from "@openmasu/attribution-core/canonical";

/** Same canonical revision selection as native cohorts, with an explicit import anchor. */
export const selectedImportedAcquisitionSql = `
  WITH eligible AS (
    SELECT candidate.* FROM ledger.attribution_results AS candidate
    WHERE candidate.tenant_id=$1 AND candidate.app_id=$2 AND candidate.subject_scope='installation_level'
      AND candidate.method='imported' AND candidate.artifact->>'model'='provider_reported'
      AND candidate.decided_at<=$3 AND candidate.artifact->>'input_cutoff_at'<=$3
      AND EXISTS (
        SELECT 1 FROM ledger.install_facts AS install JOIN ledger.logical_events AS logical USING(logical_event_id)
        JOIN ledger.raw_records_current AS raw ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id
          AND raw.record_id=logical.record_id
        WHERE install.tenant_id=$1 AND install.app_id=$2 AND install.installation_id=candidate.subject_ref
          AND logical.producer='import:'||$4::text AND install.artifact->'import_context'->>'provider'=$4
          AND raw.received_at<=$3
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(candidate.artifact->'evidence_refs') AS ref
            WHERE ref->>'tenant_id'=$1 AND ref->>'app_id'=$2 AND ref->>'ref'=raw.record_id))
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(candidate.artifact->'evidence_refs') AS ref
        WHERE ref->>'tenant_id'<>$1 OR ref->>'app_id'<>$2 OR NOT EXISTS (
          SELECT 1 FROM ledger.logical_events AS logical JOIN ledger.raw_records_current AS raw
            ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
          WHERE logical.tenant_id=$1 AND logical.app_id=$2 AND logical.record_id=ref->>'ref' AND raw.received_at<=$3))
  ) SELECT DISTINCT ON (candidate.subject_ref COLLATE "C") candidate.* FROM eligible AS candidate
  WHERE NOT EXISTS (SELECT 1 FROM eligible AS newer WHERE newer.subject_ref=candidate.subject_ref
    AND newer.artifact->>'supersedes_attribution_id'=candidate.attribution_id)
  ORDER BY candidate.subject_ref COLLATE "C",candidate.decided_at DESC,candidate.attribution_id COLLATE "C" DESC
`;

export function importedAcquisitionJoinSql(enabled: string, provider: "$22" | "$15" | "$10", privacy: "$8" | "$12" | "$15") {
  return `LEFT JOIN acquisition ON acquisition.subject_ref=install.installation_id
    LEFT JOIN LATERAL (
      SELECT install.artifact->'import_context'->>'provider' AS import_provider,
        CASE WHEN acquisition.status='non_organic' THEN install.artifact->'import_context'->>'provider_campaign_ref' END AS campaign_id,
        CASE WHEN acquisition.status='non_organic' THEN install.artifact->'import_context'->>'provider_network' END AS network,
        CASE WHEN acquisition.status='non_organic' THEN install.artifact->'import_context'->>'provider_adgroup_ref' END AS ad_group_id,
        install.artifact->'import_context'->>'provider_country' AS country,NULL::text AS creative_id
      WHERE ${enabled}::boolean AND logical.producer='import:'||${provider}::text
        AND install.artifact->'import_context'->>'provider'=${provider}
        AND ${privacy}::text IN ('before','after')
    ) AS acquisition_source ON true`;
}

export async function importedAcquisitionSnapshot(client: Pick<PoolClient, "query">, tenantId: string,
  appId: string, watermark: string, provider: string) {
  const rows = (await client.query<{ artifact: OpenMasuAttributionResultV04 }>(selectedImportedAcquisitionSql,
    [tenantId, appId, watermark, provider])).rows.map(row => row.artifact)
    .sort((a,b) => a.attribution_id < b.attribution_id ? -1 : a.attribution_id > b.attribution_id ? 1 : 0);
  const contexts = (await client.query<{ record_id: string; producer: string; context: unknown }>(`
    SELECT raw.record_id,logical.producer,install.artifact->'import_context' AS context
    FROM ledger.install_facts AS install JOIN ledger.logical_events AS logical USING(logical_event_id)
    JOIN ledger.raw_records_current AS raw ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id
      AND raw.record_id=logical.record_id
    WHERE install.tenant_id=$1 AND install.app_id=$2 AND raw.received_at<=$3
      AND logical.producer='import:'||$4::text AND install.artifact->'import_context'->>'provider'=$4
    ORDER BY raw.record_id COLLATE "C"`, [tenantId,appId,watermark,provider])).rows;
  return { acquisition_attributions: rows.map(row => [row.tenant_id,row.app_id,row.attribution_id,sha256(row)]),
    imported_acquisition_contexts: contexts.map(row => [tenantId,appId,row.record_id,row.producer,sha256(row.context)]) };
}
