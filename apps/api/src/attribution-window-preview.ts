import type { Pool, PoolClient } from "pg";
import { previewAcceptedFirstPartyAttribution, type CandidateAttempt } from "@openmasu/attribution-core";
import { FIRST_PARTY_WINDOW_BUNDLE, firstPartyWindowHash, validateFirstPartyWindowDefinition,
  nonFraudBundleHash, type FirstPartyWindowDefinition } from "@openmasu/contracts/definitions";
import { sha256Jcs } from "@openmasu/fraud-rules";
import type { AppAdminIdentity } from "./admin-auth.js";
import { withFraudSnapshot } from "./fraud-preview.js";

type Any = Record<string, any>;
export class AttributionWindowPreviewError extends Error {}
export type AttributionWindowRequest = {
  definition: FirstPartyWindowDefinition; date_from: string; date_to: string;
  watermark_at_most: string; baseline_revision_id?: string;
};
export function parseAttributionWindowRequest(value: unknown, now = new Date()): AttributionWindowRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AttributionWindowPreviewError("attribution_window_request_invalid");
  const body = value as Any;
  if (Object.keys(body).some(key => !["definition", "date_from", "date_to", "watermark_at_most", "baseline_revision_id"].includes(key))) {
    throw new AttributionWindowPreviewError("attribution_window_field_forbidden");
  }
  const day = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!day(body.date_from) || !day(body.date_to) || body.date_from >= body.date_to
    || Date.parse(body.date_to) - Date.parse(body.date_from) > 31 * 86_400_000) {
    throw new AttributionWindowPreviewError("attribution_window_date_range_invalid");
  }
  const cutoff = typeof body.watermark_at_most === "string" ? Date.parse(body.watermark_at_most) : NaN;
  if (!Number.isFinite(cutoff) || new Date(cutoff).toISOString() !== body.watermark_at_most || cutoff > now.getTime()) {
    throw new AttributionWindowPreviewError("attribution_window_watermark_invalid");
  }
  if (body.baseline_revision_id !== undefined && (typeof body.baseline_revision_id !== "string"
    || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.baseline_revision_id))) throw new AttributionWindowPreviewError("attribution_window_revision_invalid");
  let definition: FirstPartyWindowDefinition;
  try { definition = validateFirstPartyWindowDefinition(body.definition); }
  catch { throw new AttributionWindowPreviewError("attribution_window_definition_invalid"); }
  return { definition, date_from: body.date_from, date_to: body.date_to, watermark_at_most: body.watermark_at_most,
    ...(body.baseline_revision_id ? { baseline_revision_id: body.baseline_revision_id } : {}) };
}

async function currentWindow(client: PoolClient, identity: AppAdminIdentity) {
  const rows = (await client.query<Any>(`SELECT rule_bundle_revision_id,rule_bundle_version,rule_bundle_hash,
    definition_digest,definition,activated_at FROM control.rule_bundles_current
    WHERE tenant_id=$1 AND app_id=$2 AND rule_bundle_id=$3`,
  [identity.tenantId, identity.appId, FIRST_PARTY_WINDOW_BUNDLE])).rows;
  if (rows.length > 1) throw new AttributionWindowPreviewError("attribution_window_revision_ambiguous");
  const row = rows[0];
  if (!row) return { days: 7, id: "attribution-default", version: "0.3.0", hash: nonFraudBundleHash("attribution-default"),
    revision_id: null, activated_at: null, definition: undefined };
  const definition = validateFirstPartyWindowDefinition(row.definition), hash = firstPartyWindowHash(definition);
  if (row.rule_bundle_version !== definition.version || row.rule_bundle_hash !== hash || row.definition_digest !== hash) {
    throw new AttributionWindowPreviewError("attribution_window_revision_digest_invalid");
  }
  return { days: definition.lookback_days, id: definition.id, version: definition.version, hash,
    revision_id: row.rule_bundle_revision_id as string, activated_at: row.activated_at as string, definition };
}
export async function attributionWindowSettings(pool: Pool, identity: AppAdminIdentity) {
  return withFraudSnapshot(pool, identity, true, async client => {
    const { definition: _definition, ...current } = await currentWindow(client, identity);
    return current;
  });
}

export async function attributionWindowPreviewWithClient(client: PoolClient, identity: AppAdminIdentity, request: AttributionWindowRequest) {
  const baseline = await currentWindow(client, identity), issues: string[] = [];
  if (request.baseline_revision_id !== undefined && request.baseline_revision_id !== baseline.revision_id) issues.push("baseline_is_not_current");
  const args = [identity.tenantId, identity.appId, request.watermark_at_most, request.date_from, request.date_to];
  const installs = (await client.query<Any>(`SELECT raw.artifact AS raw,raw.payload_lifecycle_status,logical.record_lifecycle,install.artifact AS payload
    FROM ledger.raw_records_current raw JOIN ledger.logical_events logical USING(tenant_id,app_id,record_id)
    JOIN ledger.install_facts install USING(tenant_id,app_id,logical_event_id)
    WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.received_at::timestamptz<=$3::timestamptz
      AND raw.occurred_at::timestamptz >= $4::date AND raw.occurred_at::timestamptz < $5::date
      AND raw.producer IN ('sdk-android','sdk-ios') AND install.artifact->>'referrer_status'='available'
      AND COALESCE(install.artifact->>'meta_referrer_status','') NOT IN ('decrypted','decrypt_failed','auth_failed')
      AND NOT (install.artifact ? 'adservices_context')
      AND NOT EXISTS (SELECT 1 FROM ledger.attribution_results platform
        WHERE platform.tenant_id=raw.tenant_id AND platform.app_id=raw.app_id
          AND platform.subject_scope='installation_level' AND platform.subject_ref=install.installation_id
          AND platform.method IN ('imported','meta_install_referrer','apple_adservices')
          AND platform.decided_at::timestamptz<=$3::timestamptz)
    ORDER BY raw.record_id COLLATE "C" LIMIT 1001`, args)).rows;
  if (installs.length > 1000) throw new AttributionWindowPreviewError("attribution_window_evidence_limit_exceeded");
  const clickIds = [...new Set(installs.map(row => row.payload?.click_id).filter((id): id is string => typeof id === "string"))];
  const clicks = clickIds.length ? (await client.query<Any>(`SELECT raw.artifact AS raw,raw.payload_lifecycle_status,
    logical.record_lifecycle,click.artifact AS payload FROM ledger.click_facts click
    JOIN ledger.logical_events logical USING(tenant_id,app_id,logical_event_id)
    JOIN ledger.raw_records_current raw USING(tenant_id,app_id,record_id)
    WHERE raw.tenant_id=$1 AND raw.app_id=$2 AND raw.received_at::timestamptz<=$3::timestamptz AND click.click_id=ANY($4::text[])
    ORDER BY raw.record_id COLLATE "C" LIMIT 2001`, [identity.tenantId, identity.appId, request.watermark_at_most, clickIds])).rows : [];
  if (clicks.length > 2000) throw new AttributionWindowPreviewError("attribution_window_evidence_limit_exceeded");
  const rows = [...installs, ...clicks];
  const removedInstalls = Number((await client.query(`SELECT count(*)::int AS count FROM ledger.raw_records_current
    WHERE tenant_id=$1 AND app_id=$2 AND received_at::timestamptz<=$3::timestamptz
      AND occurred_at::timestamptz >= $4::date AND occurred_at::timestamptz < $5::date
      AND event_name='install' AND producer IN ('sdk-android','sdk-ios') AND payload_lifecycle_status<>'available'`, args)).rows[0].count);
  const unavailable = Math.max(removedInstalls, rows.filter(row => row.payload_lifecycle_status !== "available" || row.record_lifecycle !== "active").length);
  if (unavailable) issues.push("evidence_unavailable");
  if (!installs.length) issues.push("no_first_party_install_evidence");
  if (rows.some(row => !row.payload)) issues.push("projection_unavailable");
  const privacy = (await client.query(`SELECT 1 FROM control.privacy_deletion_jobs WHERE tenant_id=$1 AND status='processing'
    AND (app_id=$2 OR artifact_template->>'deletion_scope'='tenant') LIMIT 1`, [identity.tenantId, identity.appId])).rowCount;
  if (privacy) issues.push("privacy_in_progress");
  const evidenceDigest = sha256Jcs(rows.map(row => [row.raw, row.payload, row.payload_lifecycle_status, row.record_lifecycle]));
  const calculate = (definition?: FirstPartyWindowDefinition) => {
    const hash = definition && firstPartyWindowHash(definition);
    const attempts = rows.map(row => ({ batch_id: "attribution-window-preview",
      server: { tenant_id: identity.tenantId, app_id: identity.appId, received_at: row.raw.received_at,
        ...(definition ? { first_party_attribution_bundle: { definition, rule_bundle_id: definition.id,
          rule_bundle_version: definition.version, rule_bundle_hash: hash, definition_digest: hash } } : {}) },
      record: { ...row.raw, payload: Object.fromEntries(Object.entries(row.payload).filter(([, value]) => value !== null)) },
      history_state: { payload_sha256: row.raw.payload_sha256, semantic_available: true, ledger_position: "preview" },
    })) as CandidateAttempt[];
    return previewAcceptedFirstPartyAttribution(attempts);
  };
  const calculationAvailable = !issues.some(issue => issue !== "baseline_is_not_current");
  const before = calculationAvailable ? calculate(baseline.definition) : [], after = calculationAvailable ? calculate(request.definition) : [];
  const afterByInstall = new Map(after.map(value => [value.evidence_refs.at(-1)!.ref, value]));
  const counts = (values: readonly Any[]) => Object.fromEntries([...new Set(values.map(value => value.reason_code))].sort()
    .map(reason => [reason, values.filter(value => value.reason_code === reason).length]));
  const candidateHash = firstPartyWindowHash(request.definition);
  const receipt = sha256Jcs({ tenant_id: identity.tenantId, app_id: identity.appId,
    request: { ...request, baseline_revision_id: baseline.revision_id },
    baseline_revision_id: baseline.revision_id, baseline_hash: baseline.hash, candidate_hash: candidateHash, evidence_digest: evidenceDigest });
  return { writes: false, can_activate: issues.length === 0, calculation_available: calculationAvailable, issues,
    date_from: request.date_from, date_to: request.date_to, watermark_at_most: request.watermark_at_most,
    baseline_revision_id: baseline.revision_id, active: { id: baseline.id, version: baseline.version, hash: baseline.hash,
      days: baseline.days, activated_at: baseline.activated_at },
    candidate: { id: request.definition.id, version: request.definition.version, hash: candidateHash, days: request.definition.lookback_days },
    evidence: { install_count: installs.length, click_count: clicks.length, unavailable_count: unavailable, evidence_digest: evidenceDigest },
    changed_decisions: calculationAvailable ? before.filter(value => {
      const candidate = afterByInstall.get(value.evidence_refs.at(-1)!.ref);
      return value.reason_code !== candidate?.reason_code || value.status !== candidate?.status;
    }).length : null,
    active_counts: calculationAvailable ? counts(before) : null, candidate_counts: calculationAvailable ? counts(after) : null,
    receipt };
}
export type AttributionWindowPreview = Awaited<ReturnType<typeof attributionWindowPreviewWithClient>>;
export async function previewAttributionWindow(pool: Pool, identity: AppAdminIdentity, value: unknown, now = new Date()) {
  const request = parseAttributionWindowRequest(value, now);
  return withFraudSnapshot(pool, identity, true, client => attributionWindowPreviewWithClient(client, identity, request));
}
