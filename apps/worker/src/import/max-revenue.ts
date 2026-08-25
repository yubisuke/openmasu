import type { Pool } from "pg";
import { jcs, sha256 } from "@openmasu/attribution-core";
import { uuidV7, withTenant } from "@openmasu/runtime";

export type MaxAggregateRevenueScope = {
  tenant_id: string;
  app_id: string;
  as_of: string;
};

export type MaxAggregateRevenueRow = MaxAggregateRevenueScope & {
  provider: "applovin-max";
  source_series: "provider_reported_aggregate";
  date: string;
  max_ad_unit_id: string;
  network: string;
  country: string | null;
  amount_unscaled: string;
  amount_scale: 6;
  currency: "USD";
};

export type MaxAggregateRevenueImportResult = {
  inserted: number;
  current: number;
  import_run_id: string;
  report_snapshot_digest: string;
};

type JsonObject = Record<string, unknown>;

const canonicalTimestampPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const dayPattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function requiredBoundedText(value: unknown, field: string, maxLength = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`MAX ${field} must be a non-empty string no longer than ${maxLength} characters`);
  }
  return value;
}

function canonicalDay(value: unknown, field: string): string {
  const text = requiredBoundedText(value, field, 10);
  if (!dayPattern.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00.000Z`))) {
    throw new Error(`MAX ${field} must be a valid YYYY-MM-DD date`);
  }
  const normalized = new Date(`${text}T00:00:00.000Z`).toISOString().slice(0, 10);
  if (normalized !== text) throw new Error(`MAX ${field} must be a valid YYYY-MM-DD date`);
  return text;
}

function canonicalTimestamp(value: unknown, field: string): string {
  const text = requiredBoundedText(value, field, 24);
  const parsed = Date.parse(text);
  if (!canonicalTimestampPattern.test(text) || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    throw new Error(`MAX ${field} must be a canonical UTC timestamp`);
  }
  return text;
}

function decimalToUnscaled(value: unknown, scale: 6): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("MAX estimated_revenue must be a decimal string or number");
  }
  const text = String(value);
  const match = /^([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  if (!match) throw new Error("MAX estimated_revenue must be a non-negative decimal without exponent notation");
  const fraction = match[2] ?? "";
  if (fraction.length > scale) throw new Error(`MAX estimated_revenue exceeds scale ${scale}`);
  return `${match[1]}${fraction.padEnd(scale, "0")}`.replace(/^0+(?=[0-9])/, "");
}

function responseRows(value: unknown, maxRows: number): JsonObject[] {
  let candidate: unknown;
  if (Array.isArray(value)) {
    candidate = value;
  } else if (value && typeof value === "object") {
    const object = value as JsonObject;
    if (object.results !== undefined && object.data !== undefined) {
      throw new Error("MAX response cannot contain both results and data");
    }
    candidate = object.results ?? object.data;
  }
  if (!Array.isArray(candidate)) throw new Error("MAX response must contain a results or data array");
  if (candidate.length > maxRows) throw new Error(`MAX response exceeded the ${maxRows} row limit`);
  return candidate.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`MAX row ${index} must be an object`);
    }
    return row as JsonObject;
  });
}

function retainedDimensions(row: MaxAggregateRevenueRow): Record<string, unknown> {
  return {
    max_ad_unit_id: row.max_ad_unit_id,
    app_id: row.app_id,
    country: row.country,
    date: row.date,
    network: row.network,
    provider: row.provider,
    source_series: row.source_series,
    tenant_id: row.tenant_id,
  };
}

function prepareRows(rows: readonly MaxAggregateRevenueRow[]): MaxAggregateRevenueRow[] {
  const keyed = rows.map((row) => ({ row, key: jcs(retainedDimensions(row)) }));
  keyed.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  for (let index = 1; index < keyed.length; index += 1) {
    if (keyed[index - 1].key === keyed[index].key) {
      throw new Error("MAX response contains a duplicate retained dimension key");
    }
  }
  return keyed.map(({ row }) => row);
}

function computeReportSnapshotDigest(rows: readonly MaxAggregateRevenueRow[]): string {
  return sha256(rows.map((row) => ({
    day: row.date,
    country: row.country,
    max_ad_unit_id: row.max_ad_unit_id,
    network: row.network,
    estimated_revenue_unscaled: row.amount_unscaled,
    estimated_revenue_scale: row.amount_scale,
    currency: row.currency,
  })));
}

export function normalizeMaxAggregateRevenue(
  scope: MaxAggregateRevenueScope,
  response: unknown,
  limits: { maxRows?: number } = {},
): MaxAggregateRevenueRow[] {
  const asOf = canonicalTimestamp(scope.as_of, "scope.as_of");
  requiredBoundedText(scope.tenant_id, "scope.tenant_id", 128);
  requiredBoundedText(scope.app_id, "scope.app_id", 128);
  const maxRows = limits.maxRows ?? 100_000;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw new Error("MAX maxRows must be a positive safe integer");
  return prepareRows(responseRows(response, maxRows).map((row, index) => {
    const countryValue = row.country;
    const country = countryValue === undefined || countryValue === null || countryValue === ""
      ? null
      : requiredBoundedText(countryValue, `row ${index} country`, 2).toUpperCase();
    if (country !== null && !/^[A-Z]{2}$/.test(country)) {
      throw new Error(`MAX row ${index} country must be an ISO-3166-1 alpha-2 code`);
    }
    return {
      ...scope,
      as_of: asOf,
      provider: "applovin-max" as const,
      source_series: "provider_reported_aggregate" as const,
      date: canonicalDay(row.day, `row ${index} day`),
      max_ad_unit_id: requiredBoundedText(
        row.max_ad_unit_id ?? row.ad_unit_id,
        `row ${index} max_ad_unit_id`,
      ),
      network: requiredBoundedText(row.network, `row ${index} network`),
      country,
      amount_unscaled: decimalToUnscaled(row.estimated_revenue, 6),
      amount_scale: 6 as const,
      currency: "USD" as const,
    };
  }));
}

export function maxAggregateRevenueArtifact(
  row: MaxAggregateRevenueRow,
  reportSnapshotDigest: string,
): Record<string, unknown> {
  const dimensions = retainedDimensions(row);
  const retainedDimensionDigest = sha256(dimensions);
  return {
    contract_version: "0.4.0",
    aggregate_revenue_snapshot_id: `aggregate-revenue:${sha256([
      dimensions,
      reportSnapshotDigest,
      row.as_of,
      row.amount_unscaled,
      row.amount_scale,
      row.currency,
    ]).slice(0, 48)}`,
    tenant_id: row.tenant_id,
    app_id: row.app_id,
    provider: row.provider,
    source_series: row.source_series,
    date: row.date,
    max_ad_unit_id: row.max_ad_unit_id,
    network: row.network,
    ...(row.country === null ? {} : { country: row.country }),
    amount_unscaled: row.amount_unscaled,
    amount_scale: row.amount_scale,
    currency: row.currency,
    as_of: row.as_of,
    report_snapshot_digest: reportSnapshotDigest,
    retained_dimension_digest: retainedDimensionDigest,
  };
}

export async function persistMaxAggregateRevenue(
  pool: Pool,
  rowsValue: readonly MaxAggregateRevenueRow[],
  sourceId = "max-reporting",
): Promise<MaxAggregateRevenueImportResult> {
  if (rowsValue.length === 0) throw new Error("MAX aggregate-revenue import requires at least one row");
  requiredBoundedText(sourceId, "source_id", 128);
  const rows = prepareRows(rowsValue);
  const scope = rows[0];
  if (!rows.every((row) => row.tenant_id === scope.tenant_id
    && row.app_id === scope.app_id
    && row.as_of === scope.as_of)) {
    throw new Error("a MAX aggregate-revenue import cannot mix tenant, app, or as_of scopes");
  }
  const reportSnapshotDigest = computeReportSnapshotDigest(rows);
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
      [runId, scope.tenant_id, scope.app_id, sourceId, reportSnapshotDigest, scope.as_of],
    );
    let inserted = 0;
    for (const row of rows) {
      const artifact = maxAggregateRevenueArtifact(row, reportSnapshotDigest);
      const result = await client.query(
        `INSERT INTO ledger.aggregate_revenue_snapshots (
          aggregate_revenue_snapshot_id, tenant_id, app_id, provider, source_series,
          revenue_date, max_ad_unit_id, network, country, amount_unscaled, amount_scale,
          currency, as_of, report_snapshot_digest, retained_dimension_digest,
          import_run_id, artifact
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
        ON CONFLICT (tenant_id, app_id, report_snapshot_digest, retained_dimension_digest)
        DO NOTHING`,
        [
          artifact.aggregate_revenue_snapshot_id, row.tenant_id, row.app_id, row.provider,
          row.source_series, row.date, row.max_ad_unit_id, row.network, row.country,
          row.amount_unscaled, row.amount_scale, row.currency, row.as_of,
          reportSnapshotDigest, artifact.retained_dimension_digest, runId, jcs(artifact),
        ],
      );
      inserted += result.rowCount ?? 0;
    }
    const current = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ledger.aggregate_revenue_snapshots_current
       WHERE tenant_id=$1 AND app_id=$2 AND source_series='provider_reported_aggregate'`,
      [scope.tenant_id, scope.app_id],
    );
    return {
      inserted,
      current: current.rows[0].count,
      import_run_id: runId,
      report_snapshot_digest: reportSnapshotDigest,
    };
  });
}
