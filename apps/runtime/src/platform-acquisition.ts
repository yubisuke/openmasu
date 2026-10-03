import type { PlatformAcquisitionInput } from "@openmasu/contracts/types";
import type { PoolClient } from "pg";
import { sha256 as sha256Jcs } from "@openmasu/attribution-core/canonical";
import { selectedAcquisitionSql, selectedClickJoinSql } from "./selected-acquisition.js";
import { selectedImportedAcquisitionSql, importedAcquisitionJoinSql } from "./imported-acquisition.js";

/** Same three bound scope/cutoff parameters as the historical selection. No request-supplied proofs. */
export const selectedPlatformAcquisitionSql = `
  WITH proof AS (
    SELECT candidate.attribution_id, install_raw.record_id AS install_record_id,
      'apple_adservices'::text AS source,
      CASE WHEN candidate.status='non_organic' AND result.status='attributed'
          AND result.artifact->'adservices_context'->>'attribution'='true'
        THEN jsonb_strip_nulls(jsonb_build_object(
          'campaign_id',result.artifact->'adservices_context'->>'campaign_id',
          'ad_group_id',result.artifact->'adservices_context'->>'ad_group_id')) ELSE '{}'::jsonb END AS context,
      result.response_ref AS evidence_ref, result.response_digest AS evidence_digest,
      install_raw.payload_lifecycle_status AS install_lifecycle
    FROM ledger.attribution_results AS candidate
    JOIN ledger.adservices_lookup_results AS result ON result.tenant_id=candidate.tenant_id
      AND result.app_id=candidate.app_id AND result.attribution_id=candidate.attribution_id
    JOIN ledger.raw_records_current AS install_raw ON install_raw.tenant_id=result.tenant_id
      AND install_raw.app_id=result.app_id AND install_raw.record_id=result.install_record_id
    JOIN ledger.logical_events AS event ON event.tenant_id=install_raw.tenant_id AND event.app_id=install_raw.app_id
      AND event.record_id=install_raw.record_id
    JOIN ledger.install_facts AS install ON install.logical_event_id=event.logical_event_id
      AND install.installation_id=candidate.subject_ref
    WHERE candidate.tenant_id=$1 AND candidate.app_id=$2 AND candidate.method='apple_adservices'
      AND event.producer NOT LIKE 'import:%' AND install_raw.received_at<=$3 AND result.decided_at<=$3
      AND result.response_ref IS NOT NULL AND result.response_digest IS NOT NULL
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(candidate.artifact->'evidence_refs') AS ref
        WHERE ref->>'ref'=install_raw.record_id AND ref->>'tenant_id'=$1 AND ref->>'app_id'=$2)
    UNION ALL
    SELECT candidate.attribution_id,raw.record_id,'meta_install_referrer'::text,
      CASE WHEN candidate.status='non_organic' THEN jsonb_strip_nulls(jsonb_build_object(
        'campaign_id',install.artifact->'meta_referrer_context'->>'campaign_id',
        'ad_group_id',install.artifact->'meta_referrer_context'->>'adgroup_id')) ELSE '{}'::jsonb END,
      install.artifact->>'protected_referrer_evidence_ref',raw.payload_sha256,raw.payload_lifecycle_status
    FROM ledger.attribution_results AS candidate
    JOIN ledger.install_facts AS install ON install.tenant_id=candidate.tenant_id AND install.app_id=candidate.app_id
      AND install.installation_id=candidate.subject_ref
    JOIN ledger.logical_events AS event ON event.logical_event_id=install.logical_event_id
    JOIN ledger.raw_records_current AS raw ON raw.tenant_id=event.tenant_id AND raw.app_id=event.app_id AND raw.record_id=event.record_id
    WHERE candidate.tenant_id=$1 AND candidate.app_id=$2 AND candidate.method='meta_install_referrer'
      AND event.producer NOT LIKE 'import:%' AND raw.received_at<=$3
      AND install.artifact->>'meta_referrer_status'='decrypted'
      AND coalesce(install.artifact->'extensions'->>'meta_decryption_key_id','')<>''
      AND coalesce(install.artifact->>'protected_referrer_evidence_ref','')<>''
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(candidate.artifact->'evidence_refs') AS ref
        WHERE ref->>'ref'=raw.record_id AND ref->>'tenant_id'=$1 AND ref->>'app_id'=$2)
  ), eligible AS (
    SELECT candidate.*,proof.install_record_id,proof.source,proof.context,proof.evidence_ref,proof.evidence_digest,
      CASE WHEN proof.install_lifecycle<>'available' THEN proof.install_lifecycle
        WHEN EXISTS (SELECT 1 FROM control.privacy_payload_purges AS purge WHERE purge.tenant_id=$1 AND purge.app_id=$2
          AND (purge.payload_ref=proof.evidence_ref OR 'payload:'||purge.payload_ref=proof.evidence_ref))
          THEN 'redacted' ELSE 'available' END AS lifecycle_status
    FROM ledger.attribution_results AS candidate
    LEFT JOIN proof ON proof.attribution_id=candidate.attribution_id
    WHERE candidate.tenant_id=$1 AND candidate.app_id=$2 AND candidate.subject_scope='installation_level'
      AND candidate.decided_at<=$3 AND candidate.artifact->>'input_cutoff_at'<=$3
      AND EXISTS (SELECT 1 FROM ledger.install_facts AS install JOIN ledger.logical_events AS event USING(logical_event_id)
        JOIN ledger.raw_records_current AS raw ON raw.tenant_id=event.tenant_id AND raw.app_id=event.app_id AND raw.record_id=event.record_id
        WHERE install.tenant_id=$1 AND install.app_id=$2 AND install.installation_id=candidate.subject_ref
          AND event.producer NOT LIKE 'import:%' AND raw.received_at<=$3)
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(candidate.artifact->'evidence_refs') AS ref
        WHERE ref->>'tenant_id'<>$1 OR ref->>'app_id'<>$2 OR NOT (
          coalesce(ref->>'ref'=proof.evidence_ref,false) OR EXISTS (SELECT 1 FROM ledger.logical_events AS event
            JOIN ledger.raw_records_current AS raw ON raw.tenant_id=event.tenant_id AND raw.app_id=event.app_id AND raw.record_id=event.record_id
            WHERE event.tenant_id=$1 AND event.app_id=$2 AND event.record_id=ref->>'ref' AND raw.received_at<=$3)))
  ) SELECT DISTINCT ON (candidate.subject_ref COLLATE "C") candidate.* FROM eligible AS candidate
  WHERE NOT EXISTS (SELECT 1 FROM eligible AS newer WHERE newer.subject_ref=candidate.subject_ref
    AND newer.artifact->>'supersedes_attribution_id'=candidate.attribution_id)
  ORDER BY candidate.subject_ref COLLATE "C",candidate.decided_at DESC,candidate.attribution_id COLLATE "C" DESC
`;

export function metricAcquisitionSql(platform: boolean | "selected_imported_provider", provider: "$22" | "$15" | "$10" = "$22"): string {
  if (platform === "selected_imported_provider") return selectedImportedAcquisitionSql.replaceAll("$4", provider);
  return platform ? selectedPlatformAcquisitionSql : selectedAcquisitionSql;
}

export function metricAcquisitionDimensionSql(field: "campaign_id" | "network", platform: boolean): string {
  return platform ? `acquisition_source.${field}` : `coalesce(install.${field},acquisition_source.${field})`;
}

export function metricAcquisitionJoinSql(enabled: "$7" | "$15" | "$18", privacy: "$8" | "$12" | "$15", platform: boolean | "selected_imported_provider", provider: "$22" | "$15" | "$10" = "$22"): string {
  if (platform === "selected_imported_provider") return importedAcquisitionJoinSql(enabled, provider, privacy);
  if (!platform) return selectedClickJoinSql(enabled, privacy);
  return `LEFT JOIN acquisition ON acquisition.subject_ref=install.installation_id
    LEFT JOIN LATERAL (
      SELECT acquisition.context->>'campaign_id' AS campaign_id,acquisition.source AS network,
        acquisition.context->>'ad_group_id' AS ad_group_id,NULL::text AS creative_id
      WHERE ${enabled}::boolean AND acquisition.source IS NOT NULL AND acquisition.lifecycle_status='available'
        AND ${privacy}::text IN ('before','after')
        AND logical.producer NOT LIKE 'import:%'
    ) AS acquisition_source ON true`;
}

type PlatformRow = { artifact: PlatformAcquisitionInput["attribution"] } & Omit<PlatformAcquisitionInput, "attribution">;
export function platformProofInput(row: PlatformRow): PlatformAcquisitionInput | undefined {
  if (!row.source) return undefined;
  return { attribution: row.artifact, install_record_id: row.install_record_id, source: row.source,
    context: row.context, evidence_ref: row.evidence_ref, evidence_digest: row.evidence_digest, lifecycle_status: row.lifecycle_status };
}
export async function platformAcquisitionSnapshot(client: Pick<PoolClient,"query">, tenantId: string, appId: string, watermark: string) {
  const selected = (await client.query<PlatformRow>(selectedPlatformAcquisitionSql,[tenantId,appId,watermark])).rows
    .sort((left,right) => left.artifact.attribution_id < right.artifact.attribution_id ? -1 : left.artifact.attribution_id > right.artifact.attribution_id ? 1 : 0);
  return {
    acquisition_attributions: selected.map(row => [row.artifact.tenant_id,row.artifact.app_id,row.artifact.attribution_id,sha256Jcs(row.artifact)]),
    platform_acquisition_inputs: selected.flatMap(row => { const proof = platformProofInput(row);
      return proof ? [[row.artifact.tenant_id,row.artifact.app_id,row.artifact.attribution_id,sha256Jcs(proof)]] : []; }),
    redacted: selected.some(row => row.source && row.lifecycle_status === "redacted"),
    purged: selected.some(row => row.source && row.lifecycle_status === "purged"),
  };
}
