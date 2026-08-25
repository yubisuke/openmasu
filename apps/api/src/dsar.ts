import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { uuidV7, withTenant } from "@openmasu/runtime";

type Any = Record<string, any>;

export type DsarRequestType = "access" | "portability";

function scopedDigest(tenantId: string, appId: string, value: string): string {
  return createHash("sha256").update(`${tenantId}\0${appId}\0${value}`).digest("hex");
}

export function parseDsarRequest(value: Any): { installationId: string; requestType: DsarRequestType } {
  const allowed = new Set(["installation_id", "request_type"]);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("dsar_request_invalid");
  }
  const installationId = typeof value.installation_id === "string" ? value.installation_id : "";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(installationId)) throw new Error("installation_id_invalid");
  const requestType = value.request_type;
  if (requestType !== "access" && requestType !== "portability") throw new Error("dsar_request_type_invalid");
  return { installationId, requestType };
}

export async function generateDsarResponse(input: {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly appId: string;
  readonly installationId: string;
  readonly requestType: DsarRequestType;
  readonly now?: Date;
}): Promise<Any> {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const requestId = `dsar:${uuidV7(input.now?.getTime())}`;
  const commerceSubjectDigest = scopedDigest(input.tenantId, input.appId, input.installationId);
  return withTenant(input.pool, input.tenantId, async (client) => {
    const records = await client.query<Any>(
      `WITH subject_events AS (
         SELECT logical_event_id FROM ledger.install_facts WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3
         UNION SELECT logical_event_id FROM ledger.session_facts WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3
         UNION SELECT logical_event_id FROM ledger.purchase_facts WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3
         UNION SELECT logical_event_id FROM ledger.refund_facts WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3
         UNION SELECT logical_event_id FROM ledger.ad_revenue_facts WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3
         UNION SELECT logical_event_id FROM ledger.custom_event_facts WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3
         UNION SELECT logical_event_id FROM ledger.deep_link_open_facts WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3
       )
       SELECT raw.record_id,raw.event_name,raw.occurred_at,raw.received_at,
              raw.processing_purpose_id,raw.payload_lifecycle_status,logical.record_lifecycle,
              purchase.amount_unscaled AS purchase_amount_unscaled,purchase.amount_scale AS purchase_amount_scale,
              purchase.currency AS purchase_currency,
              refund.amount_unscaled AS refund_amount_unscaled,refund.amount_scale AS refund_amount_scale,
              refund.currency AS refund_currency,refund.financial_status AS refund_financial_status,
              revenue.amount_unscaled AS revenue_amount_unscaled,revenue.amount_scale AS revenue_amount_scale,
              revenue.currency AS revenue_currency,revenue.revenue_source,
              deep.open_source,deep.days_since_last_session,
              install.install_type,custom.event_key
         FROM subject_events AS subject
         JOIN ledger.logical_events AS logical USING (logical_event_id)
         JOIN ledger.raw_records_current AS raw
           ON raw.tenant_id=logical.tenant_id AND raw.app_id=logical.app_id AND raw.record_id=logical.record_id
         LEFT JOIN ledger.install_facts AS install USING (logical_event_id)
         LEFT JOIN ledger.purchase_facts AS purchase USING (logical_event_id)
         LEFT JOIN ledger.refund_facts AS refund USING (logical_event_id)
         LEFT JOIN ledger.ad_revenue_facts AS revenue USING (logical_event_id)
         LEFT JOIN ledger.deep_link_open_facts AS deep USING (logical_event_id)
         LEFT JOIN ledger.custom_event_facts AS custom USING (logical_event_id)
        WHERE logical.tenant_id=$1 AND logical.app_id=$2
        ORDER BY raw.occurred_at,raw.record_id`,
      [input.tenantId, input.appId, input.installationId],
    );
    const attributions = await client.query<Any>(
      `SELECT attribution_id,effective_at,decided_at,status,method,model,reason_code
         FROM ledger.attribution_results
        WHERE tenant_id=$1 AND app_id=$2 AND subject_ref=$3
        ORDER BY effective_at,attribution_id`,
      [input.tenantId, input.appId, input.installationId],
    );
    const commerce = await client.query<Any>(
      `SELECT lifecycle_fact_id,provider,event_kind,financial_effect,subscription_state,effective_at,recorded_at
         FROM ledger.commerce_lifecycle_facts
        WHERE tenant_id=$1 AND app_id=$2 AND subject_digest=$3
        ORDER BY effective_at,lifecycle_fact_id`,
      [input.tenantId, input.appId, commerceSubjectDigest],
    );
    return {
      dsar_response_version: "internal-v1",
      request_id: requestId,
      request_type: input.requestType,
      subject_scope: "installation",
      generated_at: generatedAt,
      records: records.rows.map((row) => ({
        record_ref: scopedDigest(input.tenantId, input.appId, row.record_id),
        event_name: row.event_name,
        occurred_at: row.occurred_at,
        received_at: row.received_at,
        processing_purpose_id: row.processing_purpose_id,
        payload_lifecycle_status: row.payload_lifecycle_status,
        record_lifecycle: row.record_lifecycle,
        ...(row.install_type ? { install_type: row.install_type } : {}),
        ...(row.event_key ? { event_key: row.event_key } : {}),
        ...(row.open_source ? {
          deep_link_claim: {
            authenticity: "device_reported_unverified",
            open_source: row.open_source,
            ...(row.days_since_last_session === null ? {} : { days_since_last_session: row.days_since_last_session }),
          },
        } : {}),
        ...(row.purchase_amount_unscaled ? { financial_value: {
          kind: "purchase", amount_unscaled: row.purchase_amount_unscaled,
          amount_scale: row.purchase_amount_scale, currency: row.purchase_currency,
        } } : {}),
        ...(row.refund_amount_unscaled ? { financial_value: {
          kind: "refund", amount_unscaled: row.refund_amount_unscaled,
          amount_scale: row.refund_amount_scale, currency: row.refund_currency,
          financial_status: row.refund_financial_status,
        } } : {}),
        ...(row.revenue_amount_unscaled ? { financial_value: {
          kind: "ad_revenue", amount_unscaled: row.revenue_amount_unscaled,
          amount_scale: row.revenue_amount_scale, currency: row.revenue_currency,
          revenue_source: row.revenue_source,
        } } : {}),
      })),
      attributions: attributions.rows.map((row) => ({
        attribution_ref: scopedDigest(input.tenantId, input.appId, row.attribution_id),
        effective_at: row.effective_at,
        decided_at: row.decided_at,
        status: row.status,
        method: row.method,
        model: row.model,
        reason_code: row.reason_code,
      })),
      verified_commerce_lifecycle: commerce.rows.map((row) => ({
        lifecycle_ref: scopedDigest(input.tenantId, input.appId, String(row.lifecycle_fact_id)),
        provider: row.provider,
        event_kind: row.event_kind,
        financial_effect: row.financial_effect,
        ...(row.subscription_state ? { subscription_state: row.subscription_state } : {}),
        effective_at: row.effective_at,
        recorded_at: row.recorded_at,
      })),
    };
  });
}

export function assertDsarResponseSafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  const forbidden = [
    "raw_payload_ref", "raw_query_ref", "body_ref", "sdk_secret", "purchase_token",
    "transaction_id", "original_transaction_id", "installation_id", "tracking_link_id",
    "deep_link_value", "provider_campaign_id", "provider_network_id",
  ];
  for (const token of forbidden) {
    if (serialized.includes(token)) throw new Error(`dsar_forbidden_field:${token}`);
  }
}
