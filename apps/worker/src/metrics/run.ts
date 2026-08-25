import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { sha256 } from "@open-mmp/attribution-core";
import { createAppPool } from "@open-mmp/runtime";
import { computeSqlMetricRuns, type MetricScope } from "./cohort.js";

type Any = Record<string, any>;

function canonicalDay(day: string): { day: string; watermark: string } {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)) throw new Error("--date must be YYYY-MM-DD");
  const start = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day) throw new Error("--date is not a real UTC calendar day");
  return { day, watermark: new Date(start + 86_400_000).toISOString() };
}

function requiredIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

export async function runMetricDefinitionsFile(options: {
  pool: Pool;
  date: string;
  definitionsPath: string;
  persist?: boolean;
}): Promise<Any[]> {
  const date = canonicalDay(options.date);
  const config: Any = JSON.parse(readFileSync(options.definitionsPath, "utf8"));
  const scope: MetricScope = {
    tenant_id: requiredIdentifier(config.tenant_id, "tenant_id"),
    app_id: requiredIdentifier(config.app_id, "app_id"),
  };
  if (!config.fx_policy || !Array.isArray(config.evaluations) || config.evaluations.length === 0) {
    throw new Error("definitions file requires fx_policy and at least one evaluation");
  }
  const input = {
    contract_version: "0.3.0",
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
        metric_run_id_prefix: `manual:${date.day}:${sha256([config, index]).slice(0, 24)}`,
        input_received_at_watermark: date.watermark,
        computed_at: date.watermark,
        data_freshness: "complete",
        privacy_state: "before",
        metric_names: evaluation.metric_names,
        grouping: { ...evaluation.grouping, cohort_date: date.day },
      };
    }),
  };
  return computeSqlMetricRuns(options.pool, input, options.persist ?? true, scope);
}

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const date = argument("date");
  const definitions = argument("definitions");
  if (!date || !definitions) throw new Error("usage: npm run metrics:run -- --date=<YYYY-MM-DD> --definitions=<json>");
  const pool = createAppPool();
  try {
    const runs = await runMetricDefinitionsFile({ pool, date, definitionsPath: resolve(definitions) });
    console.log(JSON.stringify({ metric_runs: runs.length, metric_run_ids: runs.map((run) => run.metric_run_id) }));
  } finally {
    await pool.end();
  }
}
