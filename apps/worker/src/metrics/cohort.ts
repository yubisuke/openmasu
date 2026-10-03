import type { Pool } from "pg";
import type { MetricComparisonContext } from "@openmasu/runtime";
import { metricScopeForInput } from "./input.js";
import { executeMetricCalculation as computeSqlMetricRunsWithClient } from "./execution.js";
import { persistCalculatedMetricRun } from "./persistence.js";
import type { MetricClient, MetricRun, MetricScope } from "./model.js";

export { computeSqlMetricRunsWithClient };
export type { MetricScope } from "./model.js";

/** Compatibility boundary for existing callers; persistence uses a typed run. */
export async function persistMetricRun(
  client: MetricClient, scope: MetricScope, artifact: unknown, comparisonContext?: MetricComparisonContext,
): Promise<void> {
  return persistCalculatedMetricRun(client, scope, artifact as MetricRun, comparisonContext);
}

export async function computeSqlMetricRuns(
  pool: Pool,
  input: unknown,
  persist = true,
  scopeOverride?: MetricScope,
): Promise<MetricRun[]> {
  const scope = scopeOverride ?? metricScopeForInput(input);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await client.query("SELECT set_config('openmasu.tenant_id', $1, true)", [scope.tenant_id]);
    const output = await computeSqlMetricRunsWithClient(client, input, persist, scope);
    await client.query("COMMIT");
    return output;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
