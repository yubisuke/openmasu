import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ACQUISITION_DETAIL_METRIC_DEFINITIONS, DISJOINT_COST_METRIC_DEFINITIONS,
  M1B_METRIC_DEFINITIONS, M3_METRIC_DEFINITIONS, REFERENCE_AD_REVENUE_METRIC_DEFINITIONS,
  REFUND_REVERSAL_METRIC_DEFINITIONS, SELECTED_ACQUISITION_METRIC_DEFINITIONS,
  SELECTED_COMMERCE_METRIC_DEFINITIONS, customConversionMetricDefinitions, engagementMetricDefinitions,
} from "@openmasu/contracts/definitions";
import type { OpenMasuMetricDefinitionV04 } from "@openmasu/contracts/types";
import { validateMetricDefinition } from "@openmasu/contracts/validation";
import { evaluate } from "@openmasu/attribution-core";
import { sha256 } from "@openmasu/attribution-core/canonical";
import { normalizeMetricScheduleRequest } from "../apps/api/src/metric-schedules.js";
import { computeSqlMetricRunsWithClient } from "../apps/worker/src/metrics/cohort.js";

type Definition = OpenMasuMetricDefinitionV04;
type BoundaryResult = Readonly<{ name: string; schema: boolean; schedule: boolean; evaluator: boolean; sql: boolean }>;
const fx = {
  policy_version: "synthetic-profile-boundary-v1", target_currency: "USD", target_scale: 6,
  rounding_mode: "half_even", rates: [{ currency: "USD", rate_unscaled: "1", rate_scale: 0,
    source: "synthetic-profile-boundary", as_of: "2026-08-01T00:00:00.000Z" }],
};

/** Frozen before the structural change at main cb40f05. This is not a golden generator. */
const baselineDigest = "1a598046536dc8bb704a846a8c473d7eca176d1e8f3fa2fde74e65e8fe54a1ac";

export function metricProfileBoundaryCases(): Array<{ name: string; definition: Definition }> {
  const apple = JSON.parse(readFileSync("fixtures/v0.4/44-apple-aggregate-metrics/input.json", "utf8")) as { metric_definitions: Definition[] };
  const reengagement = JSON.parse(readFileSync("fixtures/v0.4/57-aak-reengagement-current-spec/input.json", "utf8")) as { metric_definitions: Definition[] };
  const groups: ReadonlyArray<readonly [string, readonly Definition[]]> = [
    ["reference", REFERENCE_AD_REVENUE_METRIC_DEFINITIONS], ["cohort", M1B_METRIC_DEFINITIONS],
    ["selected", SELECTED_ACQUISITION_METRIC_DEFINITIONS], ["safe_cost", DISJOINT_COST_METRIC_DEFINITIONS],
    ["commerce", SELECTED_COMMERCE_METRIC_DEFINITIONS], ["refund", REFUND_REVERSAL_METRIC_DEFINITIONS],
    ["detail", ACQUISITION_DETAIL_METRIC_DEFINITIONS], ["custom", customConversionMetricDefinitions("synthetic_outcome")],
    ["engagement", engagementMetricDefinitions("synthetic_outcome")], ["daily", M3_METRIC_DEFINITIONS],
    ["apple", [...apple.metric_definitions, ...reengagement.metric_definitions
      .filter(definition => definition.metric_name === "aak_attributed_reengagements")]],
  ];
  return groups.flatMap(([group, definitions]) => definitions.flatMap(definition => {
    const name = `${group}/${definition.metric_name}`;
    return [
      { name: `${name}/valid`, definition: structuredClone(definition) },
      { name: `${name}/hash`, definition: { ...structuredClone(definition), rule_bundle_hash: "0".repeat(64) } },
      { name: `${name}/version`, definition: { ...structuredClone(definition), metric_definition_version: "synthetic-unregistered-version" } },
      { name: `${name}/window`, definition: { ...structuredClone(definition), definition: {
        ...definition.definition, window: { ...definition.definition.window, day: definition.definition.window.day + 2 },
      } } },
      { name: `${name}/basis`, definition: { ...structuredClone(definition), acquisition_basis: "synthetic-unsupported-basis" } as unknown as Definition },
      { name: `${name}/grouping`, definition: { ...structuredClone(definition), grouping_dimensions: ["installation_id"] } as unknown as Definition },
    ];
  }));
}

async function boundaryResult(name: string, definition: Definition): Promise<BoundaryResult> {
  let schedule = true, evaluator = true, sql = true;
  try {
    normalizeMetricScheduleRequest({ fx_policy: fx, metric_definitions: [definition], evaluations: [{
      // Probe definition admission independently of schedule-specific date/lag/discovery constraints.
      metric_names: ["synthetic_probe"], date_dimension: "cohort_date", grouping: {},
    }] }, new Date("2026-08-10T00:00:00.000Z"));
  } catch { schedule = false; }
  const input = { records: [], fx_policy: fx, metric_definitions: [definition], metric_evaluations: [{
    metric_names: [], grouping: {}, privacy_state: "before", input_received_at_watermark: "2026-08-10T00:00:00.000Z",
  }] };
  try { evaluate(input); } catch { evaluator = false; }
  let databaseCalls = 0;
  const client: Parameters<typeof computeSqlMetricRunsWithClient>[0] = {
    query: async () => { databaseCalls++; throw new Error("profile probe must not perform database IO"); },
  };
  try {
    await computeSqlMetricRunsWithClient(client, { ...input, metric_evaluations: [] }, false,
      { tenant_id: "synthetic-profile-tenant", app_id: "synthetic-profile-app" });
  } catch { sql = false; }
  assert.equal(databaseCalls, 0, name);
  return { name, schema: validateMetricDefinition(definition), schedule, evaluator, sql };
}

describe("metric profile entry boundaries", () => {
  it("metric_profile_boundary_equivalence preserves every existing family and hash/version/window/basis/grouping mutation", async () => {
    const results: BoundaryResult[] = [];
    for (const entry of metricProfileBoundaryCases()) results.push(await boundaryResult(entry.name, entry.definition));
    const summary = Object.fromEntries([...new Set(results.map(row => row.name.split("/")[0]))].map(group => {
      const rows = results.filter(row => row.name.startsWith(`${group}/`));
      return [group, { cases: rows.length, schema: rows.filter(row => row.schema).length,
        schedule: rows.filter(row => row.schedule).length, evaluator: rows.filter(row => row.evaluator).length,
        sql: rows.filter(row => row.sql).length }];
    }));
    assert.ok(results.filter(row => row.name.startsWith("selected/") && row.name.endsWith("/valid"))
      .every(row => row.schema && row.schedule && row.evaluator && row.sql));
    assert.equal(sha256(results), baselineDigest, JSON.stringify(summary));
  });
});
