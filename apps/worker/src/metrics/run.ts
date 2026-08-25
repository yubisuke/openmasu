import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { sha256 } from "@openmasu/attribution-core";
import { createAppPool, recordJobOutcome, runWithTerminalJobOutcome } from "@openmasu/runtime";
import { computeSqlMetricRuns, type MetricScope } from "./cohort.js";

type Any = Record<string, any>;

function canonicalDay(day: string): { day: string; watermark: string } {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)) throw new Error("--date must be YYYY-MM-DD");
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day) throw new Error("--date is not a real UTC calendar day");
  return { day, watermark: new Date(start + 86_400_000).toISOString() };
}

function canonicalWatermark(value: string): string {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error("--watermark must be a canonical UTC ISO8601 timestamp");
  }
  return value;
}

function requiredIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

export async function runMetricDefinitionsFile(options: {
  pool: Pool;
  date: string;
  definitionsPath: string;
  watermark?: string;
  persist?: boolean;
}): Promise<Any[]> {
  const config: Any = JSON.parse(readFileSync(options.definitionsPath, "utf8"));
  const input = buildMetricDefinitionsInput(config, options.date, options.watermark);
  const scope: MetricScope = {
    tenant_id: requiredIdentifier(config.tenant_id, "tenant_id"),
    app_id: requiredIdentifier(config.app_id, "app_id"),
  };
  return computeSqlMetricRuns(options.pool, input, options.persist ?? true, scope);
}

export async function runMetricDefinitionsCommand(
  options: Parameters<typeof runMetricDefinitionsFile>[0],
): Promise<Any[]> {
  const config: Any = JSON.parse(readFileSync(options.definitionsPath, "utf8"));
  const tenantId = requiredIdentifier(config.tenant_id, "tenant_id");
  const appId = requiredIdentifier(config.app_id, "app_id");
  return runWithTerminalJobOutcome(
    () => runMetricDefinitionsFile(options),
    (outcome) => recordJobOutcome({
      pool: options.pool,
      tenantId,
      appId,
      job: "metric_run",
      outcome,
    }),
  );
}

export function buildMetricDefinitionsInput(config: Any, requestedDate: string, requestedWatermark?: string): Any {
  const date = canonicalDay(requestedDate);
  const watermark = requestedWatermark === undefined ? date.watermark : canonicalWatermark(requestedWatermark);
  if (!config.fx_policy || !Array.isArray(config.evaluations) || config.evaluations.length === 0) {
    throw new Error("definitions file requires fx_policy and at least one evaluation");
  }
  const input = {
    contract_version: "0.4.0",
    fx_policy: config.fx_policy,
    metric_definitions: config.metric_definitions ?? [],
    metric_evaluations: config.evaluations.map((evaluation: Any, index: number) => {
      if (!Array.isArray(evaluation.metric_names) || evaluation.metric_names.length === 0 ||
          !evaluation.metric_names.every((value: unknown) => typeof value === "string")) {
        throw new Error(`evaluation ${index} requires metric_names`);
      }
      if (!evaluation.grouping || typeof evaluation.grouping !== "object" || Array.isArray(evaluation.grouping)) {
        throw new Error(`evaluation ${index} requires grouping`);
      }
      return {
        metric_run_id_prefix: `manual:${date.day}:${sha256(requestedWatermark === undefined ? [config, index] : [config, index, watermark]).slice(0, 24)}`,
        input_received_at_watermark: watermark,
        computed_at: watermark,
        data_freshness: "complete",
        privacy_state: "before",
        metric_names: evaluation.metric_names,
        grouping: { cohort_date: date.day, ...evaluation.grouping },
      };
    }),
  };
  return input;
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const date = argument("date");
  const definitions = argument("definitions");
  const watermark = argument("watermark");
  if (!date || !definitions) throw new Error("usage: npm run metrics:run -- --date=<YYYY-MM-DD> --definitions=<json> [--watermark=<ISO8601>]");
  const pool = createAppPool();
  try {
    const runs = await runMetricDefinitionsCommand({ pool, date, definitionsPath: resolve(definitions), watermark });
    console.log(JSON.stringify({ metric_runs: runs.length, metric_run_ids: runs.map((run) => run.metric_run_id) }));
  } finally {
    await pool.end();
  }
}
