import { resolve } from "node:path";
import type { Pool } from "pg";
import { createAppPool } from "@openmasu/runtime";
import { persistCostImport, type CostImportResult, type CostInput } from "./cost.js";
import { loadMapping, mapRow, rowMatches } from "./mapping.js";
import { readRows, type ImportLimits } from "./source.js";

type Any = Record<string, any>;

const defaultLimits: ImportLimits = {
  maxBytes: 4 * 1024 * 1024 * 1024,
  maxRows: 20_000_000,
  maxRowBytes: 64 * 1024,
};

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`mapped ${field} is required`);
  return value;
}

function costInput(mapping: ReturnType<typeof loadMapping>, mapped: Any): CostInput {
  const money = mapped.money;
  if (!money || typeof money !== "object" || Array.isArray(money)) throw new Error("mapped money is required");
  const date = requiredText(mapped.date, "date");
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) throw new Error("mapped date must be YYYY-MM-DD");
  const asOf = requiredText(mapped.as_of, "as_of");
  if (Number.isNaN(Date.parse(asOf))) throw new Error("mapped as_of must be a timestamp");
  return {
    tenant_id: mapping.tenant_id,
    app_id: mapping.app_id,
    network: requiredText(mapped.network, "network"),
    campaign_id: mapped.campaign_id === undefined ? null : requiredText(mapped.campaign_id, "campaign_id"),
    ad_group_id: mapped.ad_group_id === undefined ? null : requiredText(mapped.ad_group_id, "ad_group_id"),
    country: mapped.country === undefined ? null : requiredText(mapped.country, "country"),
    date,
    amount_unscaled: requiredText(money.amount_unscaled, "money.amount_unscaled"),
    amount_scale: money.amount_scale,
    currency: requiredText(money.currency, "money.currency"),
    source: "imported_reported",
    as_of: new Date(asOf).toISOString(),
  };
}

export async function runCostImportFile(options: {
  pool: Pool;
  mappingPath: string;
  filePath: string;
  limits?: ImportLimits;
}): Promise<CostImportResult & { rows: number }> {
  const mapping = loadMapping(options.mappingPath);
  if (mapping.kind !== "manual_cost") throw new Error("import:cost requires a manual_cost mapping");
  const loaded = readRows(options.filePath, mapping, options.limits ?? defaultLimits);
  const rows = loaded.rows.filter((row) => rowMatches(mapping, row)).map((row) => costInput(mapping, mapRow(mapping, row)));
  const result = await persistCostImport(options.pool, mapping.source_id, rows);
  return { ...result, rows: rows.length };
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const file = argument("file");
  const mapping = argument("mapping");
  if (!file || !mapping) throw new Error("usage: npm run import:cost -- --file=<csv> --mapping=<json>");
  const pool = createAppPool();
  try {
    console.log(JSON.stringify(await runCostImportFile({
      pool, filePath: resolve(file), mappingPath: resolve(mapping),
    })));
  } finally {
    await pool.end();
  }
}
