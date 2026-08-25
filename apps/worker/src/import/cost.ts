import type { Pool } from "pg";
import { jcs, sha256 } from "@open-mmp/attribution-core";
import { uuidV7, withTenant } from "@open-mmp/runtime";

export type CostInput = {
  tenant_id: string;
  app_id: string;
  network: string;
  campaign_id?: string | null;
  ad_group_id?: string | null;
  country?: string | null;
  date: string;
  amount_unscaled: string;
  amount_scale: number;
  currency: string;
  source: "imported_reported";
  as_of: string;
};

export type CostImportResult = { inserted: number; current: number; import_run_id: string };

export function decimalToUnscaled(value: string, scale = 6): string {
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(value.trim());
  if (!match) throw new Error("cost amount must be a non-negative decimal without exponent notation");
  const fraction = match[2] ?? "";
  if (fraction.length > scale) throw new Error(`cost amount exceeds scale ${scale}`);
  return `${match[1]}${fraction.padEnd(scale, "0")}`.replace(/^0+(?=[0-9])/, "");
}

function dimensionObject(row: CostInput): Record<string, unknown> {
  return Object.fromEntries(Object.entries({
    tenant_id: row.tenant_id,
    app_id: row.app_id,
    network: row.network,
    campaign_id: row.campaign_id ?? null,
    ad_group_id: row.ad_group_id ?? null,
    country: row.country ?? null,
    date: row.date,
  }).sort(([left], [right]) => left.localeCompare(right)));
}

export function costArtifact(row: CostInput, reportSnapshotDigest: string): Record<string, unknown> {
  const dimensions = dimensionObject(row);
  return {
    contract_version: "0.2.0",
    cost_record_id: `cost:${sha256([dimensions, row.as_of, row.amount_unscaled, row.currency]).slice(0, 48)}`,
    tenant_id: row.tenant_id,
    app_id: row.app_id,
    network: row.network,
    campaign_id: row.campaign_id ?? null,
    ...(row.ad_group_id ? { ad_group_id: row.ad_group_id } : {}),
    ...(row.country ? { country: row.country } : {}),
    date: row.date,
    amount_unscaled: row.amount_unscaled,
    amount_scale: row.amount_scale,
    currency: row.currency.toUpperCase(),
    source: row.source,
    as_of: row.as_of,
    report_snapshot_digest: reportSnapshotDigest,
    dimension_digest: sha256(dimensions),
  };
}

export async function persistCostImport(pool: Pool, sourceId: string, rows: readonly CostInput[]): Promise<CostImportResult> {
  if (rows.length === 0) throw new Error("cost import requires at least one row");
  const scope = rows[0];
  if (!rows.every((row) => row.tenant_id === scope.tenant_id && row.app_id === scope.app_id)) {
    throw new Error("a cost import cannot mix tenant or app scopes");
  }
  const reportDigest = sha256(rows);
  const runId = uuidV7(Date.parse(scope.as_of));
  return withTenant(pool, scope.tenant_id, async (client) => {
    await client.query(
      `INSERT INTO control.apps (tenant_id, app_id, created_at)
       VALUES ($1,$2,$3) ON CONFLICT (tenant_id, app_id) DO NOTHING`,
      [scope.tenant_id, scope.app_id, scope.as_of],
    );
    await client.query(
      `INSERT INTO control.import_runs (
        import_run_id, tenant_id, app_id, source_id, source_snapshot_digest,
        status, started_at, completed_at
      ) VALUES ($1,$2,$3,$4,$5,'completed',$6,$6)`,
      [runId, scope.tenant_id, scope.app_id, sourceId, reportDigest, scope.as_of],
    );
    let inserted = 0;
    for (const row of rows) {
      if (!/^[A-Z]{3}$/.test(row.currency) || !/^[0-9]+$/.test(row.amount_unscaled)) {
        throw new Error("cost money representation is invalid");
      }
      const artifact = costArtifact(row, reportDigest);
      const result = await client.query(
        `INSERT INTO ledger.cost_records (
          cost_record_id, tenant_id, app_id, network, campaign_id, ad_group_id,
          country, cost_date, spend_unscaled, spend_scale, currency, source,
          as_of, report_snapshot_digest, cost_key_digest, import_run_id, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
        ON CONFLICT DO NOTHING`,
        [
          artifact.cost_record_id, row.tenant_id, row.app_id, row.network,
          row.campaign_id ?? null, row.ad_group_id ?? null, row.country ?? null,
          row.date, row.amount_unscaled, row.amount_scale, row.currency, row.source,
          row.as_of, reportDigest, artifact.dimension_digest, runId, jcs(artifact),
        ],
      );
      inserted += result.rowCount ?? 0;
    }
    const current = await client.query(
      `SELECT count(*)::int AS count FROM ledger.cost_records_current
       WHERE tenant_id=$1 AND app_id=$2`,
      [scope.tenant_id, scope.app_id],
    );
    return { inserted, current: current.rows[0].count, import_run_id: runId };
  });
}
