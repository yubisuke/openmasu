import { resolve } from "node:path";
import type { Pool } from "pg";
import { createAppPool, recordJobOutcome, runWithTerminalJobOutcome } from "@openmasu/runtime";
import { persistCostImport, prepareCostImportRows, type CostImportResult, type CostInput } from "./cost.js";
import { loadMapping, loadMappingScope, mapRow, rowMatches } from "./mapping.js";
import { readRows, type ImportLimits } from "./source.js";

type Any = Record<string, any>;

const defaultLimits: ImportLimits = {
  maxBytes: 4 * 1024 * 1024 * 1024,
  maxRows: 20_000_000,
  maxRowBytes: 64 * 1024,
};

export type CostInputRejectionCode =
  | "cost_field_invalid"
  | "cost_money_invalid"
  | "cost_date_invalid"
  | "cost_as_of_invalid";

export class CostInputError extends Error {
  constructor(
    readonly code: CostInputRejectionCode,
    readonly fields: string[],
    message: string,
  ) {
    super(message);
  }
}

function requiredText(value: unknown, field: string, code: CostInputRejectionCode = "cost_field_invalid"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CostInputError(code, [field], `mapped ${field} is required`);
  }
  return value;
}

function canonicalDay(value: unknown): string {
  const date = requiredText(value, "date", "cost_date_invalid");
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)
    || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))
    || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
    throw new CostInputError("cost_date_invalid", ["date"], "mapped date must be a valid YYYY-MM-DD date");
  }
  return date;
}

export function normalizeCostInput(mapping: ReturnType<typeof loadMapping>, mapped: Any): CostInput {
  const money = mapped.money;
  if (!money || typeof money !== "object" || Array.isArray(money)) {
    throw new CostInputError("cost_money_invalid", ["money"], "mapped money is required");
  }
  const amountUnscaled = requiredText(money.amount_unscaled, "money.amount_unscaled", "cost_money_invalid");
  const currency = requiredText(money.currency, "money.currency", "cost_money_invalid");
  if (!/^[0-9]+$/.test(amountUnscaled)) {
    throw new CostInputError("cost_money_invalid", ["money.amount_unscaled"], "mapped cost amount is invalid");
  }
  if (!Number.isInteger(money.amount_scale) || money.amount_scale < 0 || money.amount_scale > 18) {
    throw new CostInputError("cost_money_invalid", ["money.amount_scale"], "mapped cost scale is invalid");
  }
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new CostInputError("cost_money_invalid", ["money.currency"], "mapped cost currency is invalid");
  }
  const date = canonicalDay(mapped.date);
  const asOf = requiredText(mapped.as_of, "as_of", "cost_as_of_invalid");
  if (Number.isNaN(Date.parse(asOf))) {
    throw new CostInputError("cost_as_of_invalid", ["as_of"], "mapped as_of must be a timestamp");
  }
  const country = mapped.country === undefined ? null : requiredText(mapped.country, "country");
  if (country !== null && !/^[A-Z]{2}$/.test(country)) {
    throw new CostInputError("cost_field_invalid", ["country"], "mapped country must be an uppercase ISO alpha-2 code");
  }
  return {
    tenant_id: mapping.tenant_id,
    app_id: mapping.app_id,
    network: requiredText(mapped.network, "network"),
    campaign_id: mapped.campaign_id === undefined ? null : requiredText(mapped.campaign_id, "campaign_id"),
    ad_group_id: mapped.ad_group_id === undefined ? null : requiredText(mapped.ad_group_id, "ad_group_id"),
    country,
    date,
    amount_unscaled: amountUnscaled,
    amount_scale: money.amount_scale,
    currency,
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
  const rows = prepareCostImportRows(
    loaded.rows.filter((row) => rowMatches(mapping, row)).map((row) => normalizeCostInput(mapping, mapRow(mapping, row))),
  );
  const result = await persistCostImport(options.pool, mapping.source_id, rows);
  return { ...result, rows: rows.length };
}

export async function runCostImportCommand(
  options: Parameters<typeof runCostImportFile>[0],
): ReturnType<typeof runCostImportFile> {
  const scope = loadMappingScope(options.mappingPath);
  return runWithTerminalJobOutcome(
    () => runCostImportFile(options),
    (outcome) => recordJobOutcome({
      pool: options.pool,
      tenantId: scope.tenantId,
      appId: scope.appId,
      job: "cost_import",
      outcome,
    }),
  );
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
    console.log(JSON.stringify(await runCostImportCommand({
      pool, filePath: resolve(file), mappingPath: resolve(mapping),
    })));
  } finally {
    await pool.end();
  }
}
