import type { Pool, PoolClient } from "pg";
import { type CandidateAttempt } from "@openmasu/attribution-core";
import { withTenant } from "@openmasu/runtime";

export async function resolveDeepLinkAttempts(pool: Pool, attempts: readonly CandidateAttempt[]): Promise<CandidateAttempt[]> {
  const resolved: CandidateAttempt[] = [];
  for (const attempt of attempts) {
    if (attempt.record.event_name !== "deep_link_open") { resolved.push(attempt); continue; }
    const payload = attempt.record.payload;
    const resolution = await withTenant(pool, attempt.server.tenant_id, async (client) => {
      const link = payload.open_source === "android_deferred_referrer"
        ? await client.query<{ tracking_link_id: string; campaign_id: string | null; status: string }>(
            `SELECT link.tracking_link_id, link.campaign_id, link.status
               FROM ledger.click_facts AS click
               JOIN control.tracking_links_current AS link
                 ON link.tenant_id=click.tenant_id AND link.app_id=click.app_id
                AND link.tracking_link_id=click.tracking_link_id
              WHERE click.tenant_id=$1 AND click.app_id=$2 AND click.click_id=$3
              ORDER BY control.canonical_timestamp_value(click.redirector_click_at) DESC LIMIT 1`,
            [attempt.server.tenant_id, attempt.server.app_id, payload.click_id],
          )
        : await client.query<{ tracking_link_id: string; campaign_id: string | null; status: string }>(
            `SELECT tracking_link_id, campaign_id, status FROM control.tracking_links_current
              WHERE tenant_id=$1 AND app_id=$2 AND slug=$3 LIMIT 1`,
            [attempt.server.tenant_id, attempt.server.app_id, payload.link_slug],
          );
      const install = payload.open_source === "android_deferred_referrer"
        ? await client.query<{ click_id: string | null }>(
            `SELECT click_id FROM ledger.install_facts
              WHERE tenant_id=$1 AND app_id=$2 AND installation_id=$3
              ORDER BY occurred_at_ts DESC LIMIT 1`,
            [attempt.server.tenant_id, attempt.server.app_id, payload.installation_id],
          )
        : undefined;
      const row = link.rows[0];
      if (!row) return { status: "unknown" as const, ...(install?.rows[0]?.click_id ? { install_attribution_click_id: install.rows[0].click_id } : {}) };
      return {
        status: row.status === "active" ? "active" as const : "inactive" as const,
        tracking_link_id: row.tracking_link_id,
        ...(row.campaign_id ? { campaign_id: row.campaign_id } : {}),
        ...(install?.rows[0]?.click_id ? { install_attribution_click_id: install.rows[0].click_id } : {}),
      };
    });
    resolved.push({ ...attempt, server: { ...attempt.server, deep_link_resolution: resolution } });
  }
  return resolved;
}

export async function ineligibleHistoricalPurchaseTargetIds(
  pool: Pool,
  attempts: readonly CandidateAttempt[],
  persistenceClient?: PoolClient,
): Promise<string[]> {
  const purchases = attempts.filter((attempt) =>
    attempt.record.event_name === "purchase"
    && attempt.record.payload.financial_status === "settled"
    && typeof attempt.record.payload.installation_id === "string");
  if (purchases.length === 0) return [];
  const first = purchases[0];
  const read = (client: PoolClient) => client.query<{
    record_id: string;
    installation_id: string | null;
    transaction_id: string;
    original_transaction_id: string | null;
    amount_unscaled: string;
    amount_scale: number;
    currency: string;
    financial_status: string | null;
    occurred_at_ts: string;
  }>(
    `SELECT record_id::text, installation_id, transaction_id, original_transaction_id,
            amount_unscaled, amount_scale, currency, financial_status, occurred_at_ts::text
       FROM ledger.purchase_facts
      WHERE tenant_id=$1 AND app_id=$2 AND record_id::text = ANY($3::text[])`,
    [first.server.tenant_id, first.server.app_id,
      [...new Set(purchases.map((attempt) => attempt.record.record_id))]],
  );
  const rows = persistenceClient ? await read(persistenceClient) : await withTenant(pool, first.server.tenant_id, read);
  const purchaseByRecord = new Map(purchases.map((attempt) => [attempt.record.record_id, attempt]));
  const eligible = new Set(rows.rows.filter((row) => {
    const purchase = purchaseByRecord.get(row.record_id);
    if (!purchase) return false;
    const payload = purchase.record.payload;
    return row.financial_status === "settled"
      && row.installation_id === payload.installation_id
      && (row.original_transaction_id ?? row.transaction_id)
        === (payload.original_transaction_id ?? payload.transaction_id)
      && row.amount_unscaled === payload.amount_unscaled
      && row.amount_scale === payload.amount_scale
      && row.currency === payload.currency
      && Date.parse(row.occurred_at_ts) === Date.parse(purchase.record.occurred_at);
  }).map((row) => row.record_id));
  return [...purchaseByRecord.keys()].filter((recordId) => !eligible.has(recordId)).sort();
}
