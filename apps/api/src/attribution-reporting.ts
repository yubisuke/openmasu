import type { Pool } from "pg";
import { acquirePrivacyTenantXactFence, selectedAcquisitionReportSql } from "@openmasu/runtime";
import type { OpenMasuAttributionResultV04 } from "../../../packages/contracts/src/generated/contract-types.js";
import type { AppAdminIdentity } from "./admin-auth.js";

type Attribution = OpenMasuAttributionResultV04;
export const attributionReportLimits = { installs: 100000, days: 366, milliseconds: 5000 } as const;
export type AttributionQuery = { date_from: string; date_to: string; time_zone: "UTC" | "Asia/Tokyo"; watermark_at_most: string };
export type AttributionCount = { recording_state: "recorded" | "not_recorded";
  status: Attribution["status"] | "unrecognized" | null; method: Attribution["method"] | "unrecognized" | null;
  reason_code: Attribution["reason_code"] | "unrecognized" | null; count: string };
export type AttributionReport = { selection: AttributionQuery & { app_id: string }; population: "retained_accepted_installations";
  privacy: "current"; selection_rule: "eligible_as_of_latest_decision"; maximum_installations: number;
  denominator: string; data: AttributionCount[] };
export class AttributionReportError extends Error {
  constructor(readonly code: string, readonly statusCode = 400) { super(code); }
}
const statuses: Record<Attribution["status"], true> = { organic: true, non_organic: true, unattributed: true };
const methods: Record<Attribution["method"], true> = { install_referrer: true, aggregate_privacy: true, imported: true,
  skadnetwork: true, adattributionkit: true, meta_install_referrer: true, apple_adservices: true, deep_link: true, none: true };
const reasons: Record<Attribution["reason_code"], true> = {
  valid_install_referrer: true, no_referrer: true, no_first_party_referrer: true, foreign_referrer_unresolved: true,
  unknown_click_id: true, window_expired: true, authoritative_time_missing: true, authoritative_time_invalid: true,
  install_referrer_unsupported: true, install_referrer_unavailable: true, platform_referrer_not_available: true,
  ambiguous_click_id: true, bot_prefetch: true, provider_attributed: true, provider_organic: true, provider_unattributed: true,
  provider_time_authority_unavailable: true, provider_modeled_conversion: true, meta_referrer_decrypted: true,
  meta_referrer_decrypt_failed: true, adservices_attributed: true, adservices_token_expired: true, adservices_not_attributed: true,
  adservices_lookup_unavailable: true, skan_postback_verified: true, skan_signature_invalid: true, postback_not_winner: true,
  crowd_anonymity_suppressed: true, conversion_value_null: true, fraud_excluded: true, deep_link_open_attributed: true,
  deep_link_unknown_link: true, deep_link_link_inactive: true, deep_link_install_click_reused: true,
};

export function parseAttributionQuery(params: URLSearchParams): AttributionQuery {
  const fields = ["date_from", "date_to", "time_zone", "watermark_at_most"];
  for (const key of params.keys()) if (!fields.includes(key)) throw new AttributionReportError("unknown_filter");
  if (fields.some(key => params.getAll(key).length !== 1)) throw new AttributionReportError("required_or_duplicate_filter");
  const from = params.get("date_from")!, to = params.get("date_to")!, zone = params.get("time_zone")!, watermark = params.get("watermark_at_most")!;
  const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 10) === value;
  if (!date(from) || !date(to) || from >= to || Date.parse(to) - Date.parse(from) > attributionReportLimits.days * 86400000) {
    throw new AttributionReportError("date_range_invalid");
  }
  if (zone !== "UTC" && zone !== "Asia/Tokyo") throw new AttributionReportError("time_zone_invalid");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(watermark) || !Number.isFinite(Date.parse(watermark))
      || new Date(watermark).toISOString().slice(0, 19) !== watermark.slice(0, 19)) throw new AttributionReportError("watermark_invalid");
  return { date_from: from, date_to: to, time_zone: zone, watermark_at_most: watermark };
}

/** One bounded, read-only aggregate statement; never return subject IDs, evidence refs or free-form reasons. */
export async function attributionReport(pool: Pool, identity: AppAdminIdentity, query: AttributionQuery): Promise<AttributionReport> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config('openmasu.tenant_id',$1,true)", [identity.tenantId]);
    await client.query("SET LOCAL statement_timeout = '5s'");
    await acquirePrivacyTenantXactFence(client, identity.tenantId, "shared");
    const pending = await client.query<{ pending_count: string }>("SELECT pending_count FROM control.privacy_deletion_backlog()");
    if (pending.rows[0]?.pending_count !== "0") throw new AttributionReportError("attribution_privacy_pending", 409);
    const result = await client.query<{ denominator: string; data: AttributionCount[] }>(
      `WITH cohort AS MATERIALIZED (
         SELECT install.installation_id FROM ledger.install_facts install
         JOIN ledger.logical_events logical USING (logical_event_id,tenant_id,app_id)
         JOIN ledger.raw_records_current raw
           ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
         WHERE install.tenant_id=$1 AND install.app_id=$2 AND logical.event_name='install'
           AND raw.received_at_ts <= $3::timestamptz AND raw.payload_lifecycle_status='available'
           AND timezone($6,install.occurred_at_ts)::date >= $4::date
           AND timezone($6,install.occurred_at_ts)::date < $5::date
         LIMIT $10
       ), acquisition AS (${selectedAcquisitionReportSql}),
       grouped AS (
         SELECT CASE WHEN a.attribution_id IS NULL THEN 'not_recorded' ELSE 'recorded' END AS recording_state,
           CASE WHEN a.attribution_id IS NULL THEN NULL WHEN a.status=ANY($7::text[]) THEN a.status ELSE 'unrecognized' END AS status,
           CASE WHEN a.attribution_id IS NULL THEN NULL WHEN a.method=ANY($8::text[]) THEN a.method ELSE 'unrecognized' END AS method,
           CASE WHEN a.attribution_id IS NULL THEN NULL WHEN a.reason_code=ANY($9::text[]) THEN a.reason_code ELSE 'unrecognized' END AS reason_code,
           count(*)::text AS count
         FROM cohort LEFT JOIN acquisition a ON a.subject_ref=cohort.installation_id GROUP BY 1,2,3,4
       )
       SELECT (SELECT count(*)::text FROM cohort) AS denominator,
         coalesce(jsonb_agg(to_jsonb(grouped) ORDER BY recording_state COLLATE "C",status COLLATE "C",method COLLATE "C",reason_code COLLATE "C"),'[]'::jsonb) AS data
       FROM grouped`,
      [identity.tenantId, identity.appId, query.watermark_at_most, query.date_from, query.date_to, query.time_zone,
        Object.keys(statuses), Object.keys(methods), Object.keys(reasons), attributionReportLimits.installs + 1],
    );
    const row = result.rows[0];
    if (Number(row.denominator) > attributionReportLimits.installs) throw new AttributionReportError("attribution_cohort_limit", 413);
    await client.query("COMMIT");
    return { selection: { app_id: identity.appId, ...query }, population: "retained_accepted_installations", privacy: "current",
      selection_rule: "eligible_as_of_latest_decision", maximum_installations: attributionReportLimits.installs, ...row };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof AttributionReportError) throw error;
    throw new AttributionReportError("attribution_report_unavailable", 503);
  } finally { client.release(); }
}
