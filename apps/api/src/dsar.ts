import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { withTenant } from "@openmasu/runtime";
import { DsarError, dsarLimits, encodeDsarCursor, prepareDsarPage, type DsarScope } from "./dsar-pagination.js";

type Any = Record<string, any>;

export type DsarRequestType = "access" | "portability";

function scopedDigest(tenantId: string, appId: string, value: string): string {
  return createHash("sha256").update(`${tenantId}\0${appId}\0${value}`).digest("hex");
}

export function parseDsarRequest(value: Any): { installationId: string; requestType: DsarRequestType; pagination?: "cursor_v1"; pageSize?: number; cursor?: string } {
  const allowed = new Set(["installation_id", "request_type", "pagination", "page_size", "cursor"]);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("dsar_request_invalid");
  }
  const installationId = typeof value.installation_id === "string" ? value.installation_id : "";
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(installationId)) throw new Error("installation_id_invalid");
  const requestType = value.request_type;
  if (requestType !== "access" && requestType !== "portability") throw new Error("dsar_request_type_invalid");
  if (value.pagination === undefined) {
    if (value.page_size !== undefined || value.cursor !== undefined) throw new DsarError("dsar_pagination_required");
    return { installationId, requestType };
  }
  if (value.pagination !== "cursor_v1" || (value.page_size !== undefined
    && (!Number.isInteger(value.page_size) || value.page_size<1 || value.page_size>dsarLimits.rows))
    || (value.cursor !== undefined && (typeof value.cursor !== "string" || !value.cursor.length || value.cursor.length>dsarLimits.cursorBytes)))
    throw new DsarError("dsar_pagination_invalid");
  return { installationId, requestType, pagination:"cursor_v1", pageSize:value.page_size ?? dsarLimits.defaultRows,
    ...(value.cursor === undefined ? {} : {cursor:value.cursor}) };
}

export async function generateDsarResponse(input: DsarScope & {
  readonly pool: Pool;
  readonly tenantId: string;
  readonly appId: string;
  readonly installationId: string;
  readonly requestType: DsarRequestType;
  readonly now?: Date;
  readonly pagination?: "cursor_v1";
  readonly pageSize?: number;
  readonly cursor?: string;
}): Promise<Any> {
  const now = input.now ?? new Date(), limit = input.pageSize ?? dsarLimits.defaultRows;
  if (!Number.isInteger(limit) || limit<1 || limit>dsarLimits.rows) throw new DsarError("dsar_pagination_invalid");
  const commerceSubjectDigest = scopedDigest(input.tenantId, input.appId, input.installationId);
  return withTenant(input.pool, input.tenantId, async (client) => {
    const state = await prepareDsarPage(client,input,input.cursor,now);
    const values = (stage:number,subject:string) => [input.tenantId,input.appId,subject,state.cutoff,state.epoch,state.snapshot,
      state.stage===stage ? state.after?.[0] ?? null : null,state.stage===stage ? state.after?.[1] ?? null : null,limit+1];
    const records = state.stage<=0 ? await client.query<Any>(
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
         JOIN ledger.raw_records AS admission
           ON admission.tenant_id=raw.tenant_id AND admission.app_id=raw.app_id AND admission.record_id=raw.record_id
         LEFT JOIN ledger.install_facts AS install USING (logical_event_id)
         LEFT JOIN ledger.purchase_facts AS purchase USING (logical_event_id)
         LEFT JOIN ledger.refund_facts AS refund USING (logical_event_id)
         LEFT JOIN ledger.ad_revenue_facts AS revenue USING (logical_event_id)
         LEFT JOIN ledger.deep_link_open_facts AS deep USING (logical_event_id)
         LEFT JOIN ledger.custom_event_facts AS custom USING (logical_event_id)
        WHERE logical.tenant_id=$1 AND logical.app_id=$2
          AND raw.received_at<=$4::text
          AND (admission.export_xid IS NULL OR admission.export_epoch<>$5::timestamptz OR pg_visible_in_snapshot(admission.export_xid,$6::pg_snapshot))
          AND ($7::text IS NULL OR (raw.occurred_at,raw.record_id COLLATE "C")>($7::text,$8::text COLLATE "C"))
        ORDER BY raw.occurred_at,raw.record_id COLLATE "C" LIMIT $9`,
      values(0,input.installationId),
    ) : {rows:[]};
    const attributions = state.stage<=1 ? await client.query<Any>(
      `SELECT attribution_id,effective_at,decided_at,status,method,model,reason_code
         FROM ledger.attribution_results
        WHERE tenant_id=$1 AND app_id=$2 AND subject_ref=$3
          AND decided_at<=$4::text AND (export_xid IS NULL OR export_epoch<>$5::timestamptz OR pg_visible_in_snapshot(export_xid,$6::pg_snapshot))
          AND ($7::text IS NULL OR (effective_at,attribution_id COLLATE "C")>($7::text,$8::text COLLATE "C"))
        ORDER BY effective_at,attribution_id COLLATE "C" LIMIT $9`,
      values(1,input.installationId),
    ) : {rows:[]};
    const commerce = state.stage<=2 ? await client.query<Any>(
      `SELECT lifecycle_fact_id,provider,event_kind,financial_effect,subscription_state,effective_at,recorded_at
         FROM ledger.commerce_lifecycle_facts
        WHERE tenant_id=$1 AND app_id=$2 AND subject_digest=$3
          AND recorded_at<=$4::text AND (export_xid IS NULL OR export_epoch<>$5::timestamptz OR pg_visible_in_snapshot(export_xid,$6::pg_snapshot))
          AND ($7::text IS NULL OR (effective_at,lifecycle_fact_id::text COLLATE "C")>($7::text,$8::text COLLATE "C"))
        ORDER BY effective_at,lifecycle_fact_id::text COLLATE "C" LIMIT $9`,
      values(2,commerceSubjectDigest),
    ) : {rows:[]};
    const mapped = {
      dsar_response_version: "internal-v1",
      request_id: state.requestId,
      request_type: input.requestType,
      subject_scope: "installation",
      generated_at: state.cutoff,
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
    const names = ["records","attributions","verified_commerce_lifecycle"] as const;
    const source = [records.rows,attributions.rows,commerce.rows];
    const selected: Record<typeof names[number], Any[]> = {records:[],attributions:[],verified_commerce_lifecycle:[]};
    let count=0,bytes=0,complete=true;
    pages: for (let stage=state.stage;stage<3;stage++) {
      if (stage!==state.stage) {state.stage=stage;state.after=null;}
      for (let index=0;index<source[stage].length;index++) {
        const item=mapped[names[stage]][index], size=Buffer.byteLength(JSON.stringify(item))+1;
        if (count===limit || bytes+size>dsarLimits.bytes-dsarLimits.cursorBytes-4096) {
          if (!count) throw new DsarError("dsar_row_too_large",413);
          complete=false; break pages;
        }
        selected[names[stage]].push(item);count++;bytes+=size;
        const raw=source[stage][index];
        state.after=[stage===0 ? raw.occurred_at : raw.effective_at,
          String(stage===0 ? raw.record_id : stage===1 ? raw.attribution_id : raw.lifecycle_fact_id)];
      }
    }
    if (!input.pagination) {
      if (!complete) throw new DsarError("dsar_pagination_required",409);
      return {...mapped,...selected};
    }
    const result={...mapped,...selected,dsar_response_version:"internal-v2",cutoff_at:state.cutoff,
      complete,returned_count:count,page_size:limit,byte_limit:dsarLimits.bytes,
      next_cursor:complete ? null : encodeDsarCursor(state,input.cursorSecret)};
    if (Buffer.byteLength(JSON.stringify(result))+1>dsarLimits.bytes) throw new DsarError("dsar_page_too_large",413);
    return result;
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
