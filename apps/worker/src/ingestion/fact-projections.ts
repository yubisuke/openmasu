import type { PoolClient } from "pg";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { uuidV7 } from "@openmasu/runtime";
import { buildDeepLinkAuditEvidence } from "../deep-link-audit.js";
import { inputAttempts } from "./input.js";
import type { Any, LogicalEvent } from "./model.js";

/** The row and bulk writers use the same declared acquisition dimensions. */
export function acquisitionDimensions(payload: Any): {
  campaignId: string | null;
  network: string | null;
  country: string | null;
} {
  const context = payload.import_context ?? {};
  return {
    campaignId: payload.campaign_id ?? context.provider_campaign_ref ?? null,
    network: payload.network ?? context.provider_network ?? null,
    country: payload.country ?? context.provider_country ?? null,
  };
}

export async function persistProjectionWithClient(
  client: PoolClient,
  logical: LogicalEvent,
  input: Any,
  refundTargets: ReadonlyMap<string, string> = new Map(),
): Promise<void> {
  const attempt = inputAttempts(input).find(({ server, record }) =>
    server.tenant_id === logical.tenant_id && server.app_id === logical.app_id && record.record_id === logical.record_id,
  );
  if (!attempt) throw new Error(`missing input record for logical event ${logical.logical_event_id}`);
  const payload = attempt.record.payload;
  const projected = (value: Any) => JSON.stringify(value);
  if (logical.event_name === "click") {
      const { campaignId, network, country } = acquisitionDimensions(payload);
      const trackingLinkId = attempt.record.producer === "redirector" && typeof payload.tracking_link_id === "string"
        ? (await client.query<{ tracking_link_id: string }>(
          `SELECT tracking_link_id FROM control.tracking_links
            WHERE tenant_id=$1 AND app_id=$2 AND tracking_link_id=$3`,
          [logical.tenant_id, logical.app_id, payload.tracking_link_id],
        )).rows[0]?.tracking_link_id ?? null
        : null;
      await client.query(
        `INSERT INTO ledger.click_facts (
          logical_event_id, tenant_id, app_id, click_id, redirector_click_at,
          campaign_id, network, country, site_id, remote_click_ref, tracking_link_id, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) ON CONFLICT (logical_event_id) DO NOTHING`,
        [
          logical.logical_event_id, logical.tenant_id, logical.app_id,
          payload.click_id ?? null, payload.redirector_click_at ?? null,
          campaignId, network, country, payload.site_id ?? null, payload.remote_click_ref ?? null,
          trackingLinkId,
          projected({
            ...(payload.click_id ? { click_id: payload.click_id } : {}),
            redirector_click_at: payload.redirector_click_at ?? null,
            campaign_id: campaignId,
            ...(payload.ad_group_id ? { ad_group_id: payload.ad_group_id } : {}),
            ...(payload.creative_id ? { creative_id: payload.creative_id } : {}),
            network,
            country,
            site_id: payload.site_id ?? null,
            remote_click_ref: payload.remote_click_ref ?? null,
            tracking_link_id: trackingLinkId,
            bot_prefetch: payload.bot_prefetch === true,
            source_rate_class: payload.source_rate_class ?? null,
            client_class: payload.client_class ?? null,
          }),
        ],
      );
    } else if (logical.event_name === "install") {
      const { campaignId, network, country } = acquisitionDimensions(payload);
      await client.query(
        `INSERT INTO ledger.install_facts (
          logical_event_id, tenant_id, app_id, installation_id, prior_installation_id,
          install_type, click_id, install_begin_at_server, occurred_at, campaign_id,
          network, country, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [
          logical.logical_event_id, logical.tenant_id, logical.app_id,
          payload.installation_id, payload.prior_installation_id ?? null,
          payload.install_type, payload.click_id ?? null,
          payload.install_begin_at_server ?? null, attempt.record.occurred_at,
          campaignId, network, country,
          projected({
            installation_id: payload.installation_id,
            prior_installation_id: payload.prior_installation_id ?? null,
            install_type: payload.install_type,
            occurred_at: attempt.record.occurred_at,
            campaign_id: campaignId,
            network,
            country,
          }),
        ],
      );
    } else if (logical.event_name === "session_start") {
      await client.query(
        `INSERT INTO ledger.session_facts (
          logical_event_id, tenant_id, app_id, installation_id, session_id, occurred_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [logical.logical_event_id, logical.tenant_id, logical.app_id, payload.installation_id, payload.session_id, attempt.record.occurred_at, projected({ installation_id: payload.installation_id, session_id: payload.session_id })],
      );
    } else if (logical.event_name === "deep_link_open") {
      const resolution = attempt.server.deep_link_resolution ?? { status: "unknown" };
      const previous = await client.query<{ occurred_at_ts: string }>(
        `SELECT occurred_at_ts::text FROM ledger.session_facts
          WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3
            AND occurred_at_ts <= $4::timestamptz
          ORDER BY occurred_at_ts DESC LIMIT 1`,
        [logical.tenant_id, logical.app_id, payload.installation_id, attempt.record.occurred_at],
      );
      const daysSinceLastSession = previous.rows[0]
        ? Math.floor((Date.parse(attempt.record.occurred_at) - Date.parse(previous.rows[0].occurred_at_ts)) / 86_400_000)
        : null;
      const inserted = await client.query(
        `INSERT INTO ledger.deep_link_open_facts (
          logical_event_id, tenant_id, app_id, installation_id, tracking_link_id,
          campaign_id, open_source, occurred_at, days_since_last_session, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [logical.logical_event_id, logical.tenant_id, logical.app_id, payload.installation_id,
          resolution.status === "active" ? resolution.tracking_link_id ?? null : null,
          resolution.status === "active" ? resolution.campaign_id ?? null : null,
          payload.open_source, attempt.record.occurred_at, daysSinceLastSession,
          projected({
            installation_id: payload.installation_id,
            tracking_link_id: resolution.status === "active" ? resolution.tracking_link_id ?? null : null,
            campaign_id: resolution.status === "active" ? resolution.campaign_id ?? null : null,
            open_source: payload.open_source,
            occurred_at: attempt.record.occurred_at,
            days_since_last_session: daysSinceLastSession,
          })],
      );
      if (inserted.rowCount === 1) {
        const { reasonCode, digest } = buildDeepLinkAuditEvidence({
          openSource: payload.open_source,
          resolutionStatus: resolution.status,
          claimedClickId: payload.click_id,
          installAttributionClickId: resolution.install_attribution_click_id,
        });
        await client.query(
          `INSERT INTO ledger.audit_logs (
            audit_log_id,tenant_id,app_id,occurred_at,actor_type,actor_ref,action,
            target_scope,target_ref,policy_version,request_digest,outcome,reason_code
          ) VALUES ($1,$2,$3,$4,'system_job','worker:deep-link-audit',
            'deep_link_device_claim_observed','record',$5,'deep-link-audit-v1',$6,'succeeded',$7)`,
          [uuidV7(), logical.tenant_id, logical.app_id, attempt.record.received_at,
            `record-digest:${sha256([logical.tenant_id, logical.app_id, logical.record_id]).slice(0, 64)}`,
            digest, reasonCode],
        );
      }
    } else if (logical.event_name === "purchase") {
      await client.query(
        `INSERT INTO ledger.purchase_facts (
          logical_event_id, record_id, tenant_id, app_id, installation_id, transaction_id,
          original_transaction_id, amount_unscaled, amount_scale, currency,
          financial_status, occurred_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [logical.logical_event_id, logical.record_id, logical.tenant_id, logical.app_id,
          payload.installation_id ?? null, payload.transaction_id,
          payload.original_transaction_id ?? null, payload.amount_unscaled,
          payload.amount_scale, payload.currency, payload.financial_status,
          attempt.record.occurred_at, projected({
            installation_id: payload.installation_id ?? null,
            transaction_id: payload.transaction_id,
            original_transaction_id: payload.original_transaction_id ?? null,
            amount_unscaled: payload.amount_unscaled,
            amount_scale: payload.amount_scale,
            currency: payload.currency,
            financial_status: payload.financial_status,
          })],
      );
    } else if (logical.event_name === "refund") {
      if (typeof payload.installation_id !== "string") return;
      const correctionTargetRecordId = refundTargets.get(logical.record_id);
      if (!correctionTargetRecordId) throw new Error(`missing_resolved_refund_target:${logical.record_id}`);
      await client.query(
        `INSERT INTO ledger.refund_facts (
          logical_event_id, tenant_id, app_id, installation_id, transaction_id,
          original_transaction_id, correction_target_record_id, amount_unscaled,
          amount_scale, currency, financial_status, occurred_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [logical.logical_event_id, logical.tenant_id, logical.app_id,
          payload.installation_id ?? null, payload.transaction_id,
          payload.original_transaction_id, correctionTargetRecordId,
          payload.amount_unscaled, payload.amount_scale, payload.currency,
          payload.financial_status, attempt.record.occurred_at, projected({
            installation_id: payload.installation_id ?? null,
            transaction_id: payload.transaction_id,
            original_transaction_id: payload.original_transaction_id,
            correction_target_record_id: correctionTargetRecordId,
            ...(payload.reverses_refund_record_id ? { reverses_refund_record_id: payload.reverses_refund_record_id } : {}),
            amount_unscaled: payload.amount_unscaled,
            amount_scale: payload.amount_scale,
            currency: payload.currency,
            financial_status: payload.financial_status,
          })],
      );
    } else if (logical.event_name === "ad_revenue") {
      await client.query(
        `INSERT INTO ledger.ad_revenue_facts (
          logical_event_id, tenant_id, app_id, installation_id, anchor_source,
          impression_id, ad_unit_id, ad_network, amount_unscaled, amount_scale,
          currency, revenue_source, country, occurred_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [logical.logical_event_id, logical.tenant_id, logical.app_id, payload.installation_id ?? null, payload.anchor_source ?? null, payload.impression_id ?? null, payload.ad_unit_id ?? null, payload.ad_network ?? null, payload.amount_unscaled, payload.amount_scale, payload.currency, payload.revenue_source, payload.country ?? null, attempt.record.occurred_at, projected({ installation_id: payload.installation_id ?? null, anchor_source: payload.anchor_source ?? null, impression_id: payload.impression_id ?? null, amount_unscaled: payload.amount_unscaled, amount_scale: payload.amount_scale, currency: payload.currency, revenue_source: payload.revenue_source })],
      );
    } else if (logical.event_name === "custom_event") {
      await client.query(
        `INSERT INTO ledger.custom_event_facts (
          logical_event_id, tenant_id, app_id, installation_id, event_key, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [logical.logical_event_id, logical.tenant_id, logical.app_id,
          payload.installation_id, payload.event_key,
          projected({ installation_id: payload.installation_id, event_key: payload.event_key })],
      );
    } else if (["skan_postback", "adattributionkit_postback"].includes(logical.event_name)) {
      const conversionBucket = payload.conversion_value !== undefined
        ? `fine:${payload.conversion_value}`
        : payload.coarse_conversion_value !== undefined
          ? `coarse:${payload.coarse_conversion_value}`
          : null;
      const aggregateFact = {
        event_name: logical.event_name,
        conversion_type: payload.conversion_type ?? null,
        signature_verified: payload.signature_verified === true,
        did_win: payload.did_win === true,
        source_identifier_present: payload.source_identifier !== undefined,
        conversion_bucket: conversionBucket,
        received_at: attempt.record.received_at,
      };
      await client.query(
        `INSERT INTO ledger.apple_postback_facts (
          logical_event_id, tenant_id, app_id, event_name, conversion_type,
          signature_verified, did_win, source_identifier_present, conversion_bucket,
          received_at, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT (logical_event_id) DO NOTHING`,
        [
          logical.logical_event_id, logical.tenant_id, logical.app_id,
          logical.event_name, aggregateFact.conversion_type, aggregateFact.signature_verified, aggregateFact.did_win,
          aggregateFact.source_identifier_present, conversionBucket,
          attempt.record.received_at, projected(aggregateFact),
        ],
      );
  }
}

export function bulkProjectionRows(
  logicals: readonly LogicalEvent[],
  input: Any,
  refundTargets: ReadonlyMap<string, string>,
): {
  byTable: Map<string, Any[]>;
  fallback: LogicalEvent[];
} {
  const attempts = new Map(inputAttempts(input).map((attempt) => [
    `${attempt.server.tenant_id}\u0000${attempt.server.app_id}\u0000${attempt.record.record_id}`,
    attempt,
  ]));
  const byTable = new Map<string, Any[]>();
  const fallback: LogicalEvent[] = [];
  const append = (table: string, row: Any): void => {
    const rows = byTable.get(table) ?? [];
    rows.push(row);
    byTable.set(table, rows);
  };
  for (const logical of logicals) {
    const attempt = attempts.get(`${logical.tenant_id}\u0000${logical.app_id}\u0000${logical.record_id}`);
    if (!attempt) throw new Error(`missing input record for logical event ${logical.logical_event_id}`);
    const payload = attempt.record.payload;
    if (logical.event_name === "click") {
      if (attempt.record.producer === "redirector") { fallback.push(logical); continue; }
      const { campaignId, network, country } = acquisitionDimensions(payload);
      const artifact = {
        ...(payload.click_id ? { click_id: payload.click_id } : {}),
        redirector_click_at: payload.redirector_click_at ?? null,
        campaign_id: campaignId, network, country,
        ...(payload.ad_group_id ? { ad_group_id: payload.ad_group_id } : {}),
        ...(payload.creative_id ? { creative_id: payload.creative_id } : {}),
        site_id: payload.site_id ?? null, remote_click_ref: payload.remote_click_ref ?? null,
        tracking_link_id: null, bot_prefetch: payload.bot_prefetch === true,
        source_rate_class: payload.source_rate_class ?? null, client_class: payload.client_class ?? null,
      };
      append("click", {
        logical_event_id: logical.logical_event_id, tenant_id: logical.tenant_id, app_id: logical.app_id,
        click_id: payload.click_id ?? null, redirector_click_at: payload.redirector_click_at ?? null,
        campaign_id: campaignId, network, country, site_id: payload.site_id ?? null,
        remote_click_ref: payload.remote_click_ref ?? null, tracking_link_id: null, artifact,
      });
    } else if (logical.event_name === "install") {
      const { campaignId, network, country } = acquisitionDimensions(payload);
      append("install", {
        logical_event_id: logical.logical_event_id, tenant_id: logical.tenant_id, app_id: logical.app_id,
        installation_id: payload.installation_id, prior_installation_id: payload.prior_installation_id ?? null,
        install_type: payload.install_type, click_id: payload.click_id ?? null,
        install_begin_at_server: payload.install_begin_at_server ?? null, occurred_at: attempt.record.occurred_at,
        campaign_id: campaignId, network, country,
        artifact: {
          installation_id: payload.installation_id, prior_installation_id: payload.prior_installation_id ?? null,
          install_type: payload.install_type, occurred_at: attempt.record.occurred_at,
          campaign_id: campaignId, network, country,
        },
      });
    } else if (logical.event_name === "session_start") {
      append("session", {
        logical_event_id: logical.logical_event_id, tenant_id: logical.tenant_id, app_id: logical.app_id,
        installation_id: payload.installation_id, session_id: payload.session_id,
        occurred_at: attempt.record.occurred_at,
        artifact: { installation_id: payload.installation_id, session_id: payload.session_id },
      });
    } else if (logical.event_name === "purchase") {
      append("purchase", {
        logical_event_id: logical.logical_event_id, record_id: logical.record_id,
        tenant_id: logical.tenant_id, app_id: logical.app_id,
        installation_id: payload.installation_id ?? null, transaction_id: payload.transaction_id,
        original_transaction_id: payload.original_transaction_id ?? null,
        amount_unscaled: payload.amount_unscaled, amount_scale: payload.amount_scale, currency: payload.currency,
        financial_status: payload.financial_status,
        occurred_at: attempt.record.occurred_at,
        artifact: {
          installation_id: payload.installation_id ?? null, transaction_id: payload.transaction_id,
          original_transaction_id: payload.original_transaction_id ?? null,
          amount_unscaled: payload.amount_unscaled, amount_scale: payload.amount_scale, currency: payload.currency,
          financial_status: payload.financial_status,
        },
      });
    } else if (logical.event_name === "refund") {
      if (typeof payload.installation_id !== "string") continue;
      const correctionTargetRecordId = refundTargets.get(logical.record_id);
      if (!correctionTargetRecordId) throw new Error(`missing_resolved_refund_target:${logical.record_id}`);
      append("refund", {
        logical_event_id: logical.logical_event_id, tenant_id: logical.tenant_id, app_id: logical.app_id,
        installation_id: payload.installation_id ?? null, transaction_id: payload.transaction_id,
        original_transaction_id: payload.original_transaction_id,
        correction_target_record_id: correctionTargetRecordId,
        amount_unscaled: payload.amount_unscaled, amount_scale: payload.amount_scale,
        currency: payload.currency, financial_status: payload.financial_status,
        occurred_at: attempt.record.occurred_at,
        artifact: {
          installation_id: payload.installation_id ?? null, transaction_id: payload.transaction_id,
          original_transaction_id: payload.original_transaction_id,
          correction_target_record_id: correctionTargetRecordId,
          ...(payload.reverses_refund_record_id ? { reverses_refund_record_id: payload.reverses_refund_record_id } : {}),
          amount_unscaled: payload.amount_unscaled, amount_scale: payload.amount_scale,
          currency: payload.currency, financial_status: payload.financial_status,
        },
      });
    } else if (logical.event_name === "ad_revenue") {
      append("ad_revenue", {
        logical_event_id: logical.logical_event_id, tenant_id: logical.tenant_id, app_id: logical.app_id,
        installation_id: payload.installation_id ?? null, anchor_source: payload.anchor_source ?? null,
        impression_id: payload.impression_id ?? null, ad_unit_id: payload.ad_unit_id ?? null,
        ad_network: payload.ad_network ?? null, amount_unscaled: payload.amount_unscaled,
        amount_scale: payload.amount_scale, currency: payload.currency, revenue_source: payload.revenue_source,
        country: payload.country ?? null, occurred_at: attempt.record.occurred_at,
        artifact: {
          installation_id: payload.installation_id ?? null, anchor_source: payload.anchor_source ?? null,
          impression_id: payload.impression_id ?? null, amount_unscaled: payload.amount_unscaled,
          amount_scale: payload.amount_scale, currency: payload.currency, revenue_source: payload.revenue_source,
        },
      });
    } else if (logical.event_name === "custom_event") {
      append("custom_event", {
        logical_event_id: logical.logical_event_id, tenant_id: logical.tenant_id, app_id: logical.app_id,
        installation_id: payload.installation_id, event_key: payload.event_key,
        artifact: { installation_id: payload.installation_id, event_key: payload.event_key },
      });
    } else if (["skan_postback", "adattributionkit_postback"].includes(logical.event_name)) {
      const conversionBucket = payload.conversion_value !== undefined
        ? `fine:${payload.conversion_value}`
        : payload.coarse_conversion_value !== undefined ? `coarse:${payload.coarse_conversion_value}` : null;
      const artifact = {
        event_name: logical.event_name, conversion_type: payload.conversion_type ?? null,
        signature_verified: payload.signature_verified === true,
        did_win: payload.did_win === true, source_identifier_present: payload.source_identifier !== undefined,
        conversion_bucket: conversionBucket, received_at: attempt.record.received_at,
      };
      append("apple_postback", {
        logical_event_id: logical.logical_event_id, tenant_id: logical.tenant_id, app_id: logical.app_id,
        event_name: logical.event_name, conversion_type: artifact.conversion_type,
        signature_verified: artifact.signature_verified,
        did_win: artifact.did_win, source_identifier_present: artifact.source_identifier_present,
        conversion_bucket: conversionBucket, received_at: attempt.record.received_at, artifact,
      });
    } else if (logical.event_name === "deep_link_open") {
      fallback.push(logical);
    }
  }
  return { byTable, fallback };
}
