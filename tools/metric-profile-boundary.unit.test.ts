import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ACQUISITION_DETAIL_METRIC_DEFINITIONS, DISJOINT_COST_METRIC_DEFINITIONS,
  M1B_METRIC_DEFINITIONS, M3_METRIC_DEFINITIONS, REFERENCE_AD_REVENUE_METRIC_DEFINITIONS,
  REFUND_REVERSAL_METRIC_DEFINITIONS, SELECTED_ACQUISITION_METRIC_DEFINITIONS,
  SELECTED_DAILY_ACQUISITION_METRIC_DEFINITIONS,
  ACQUISITION_KPI_METRIC_DEFINITIONS, basisAcquisitionKpiDefinitions, horizonAcquisitionKpiDefinitions,
  CALENDAR_ACTIVITY_METRIC_DEFINITIONS, isCalendarActivityMetricDefinition,
  PAYER_METRIC_DEFINITIONS,
  VERIFIED_PLATFORM_METRIC_DEFINITIONS,
  importedAcquisitionMetricDefinitions,
  standardRetentionMetricDefinitions,
  calendarAcquisitionMetricDefinitions, COHORT_TIME_ZONES,
  SELECTED_COMMERCE_METRIC_DEFINITIONS, customConversionMetricDefinitions, engagementMetricDefinitions,
  METRIC_PROFILE_METADATA, metricProfileMetadata, engagementPolicyMetricDefinitions,
} from "@openmasu/contracts/definitions";
import type { OpenMasuMetricDefinitionV04 } from "@openmasu/contracts/types";
import { validateMetricDefinition, validateScheduledMetricDefinition, assertMetricDefinitionSeries } from "@openmasu/contracts/validation";
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
  it("engagement_policy_admission_binds_window_inactivity_and_verified_purchase_net_without_upgrading_24h", async () => {
    const definitions = engagementPolicyMetricDefinitions({ windowDays: 3, minimumInactivityDays: 7, eventKey: "tutorial_complete" });
    for (const definition of definitions) {
      assert.deepEqual(await boundaryResult("engagement_policy/valid", definition), {
        name: "engagement_policy/valid", schema: true, schedule: true, evaluator: true, sql: true,
      });
      for (const change of [{ engagement_inactivity_days: undefined }, { engagement_inactivity_days: -1 },
        { engagement_inactivity_days: 91 }, { engagement_inactivity_days: true }, { fraud_policy: "net" },
        { acquisition_basis: "selected_first_party_click" }, { rule_bundle_hash: "0".repeat(64) },
        { rule_bundle_id: "metric-first-party-engagement" }, { metric_definition_version: "0.4.17" },
        { definition: { ...definition.definition, window: { type: "elapsed", day: 30 } } }]) {
        assert.deepEqual(await boundaryResult("engagement_policy/invalid", { ...definition, ...change } as Definition), {
          name: "engagement_policy/invalid", schema: false, schedule: false, evaluator: false, sql: false,
        });
      }
    }
    assert.equal(validateMetricDefinition({ ...engagementMetricDefinitions("tutorial_complete")[0], engagement_inactivity_days: 0 }), false);
    for (const [windowDays, minimumInactivityDays] of [[0, 7], [31, 7], [3, -1], [3, 91]])
      assert.throws(() => engagementPolicyMetricDefinitions({ windowDays, minimumInactivityDays, eventKey: "tutorial_complete" }), /window_invalid/);
  });
  it("payer_profile_is_closed_to_verified_store_purchase_counts_and_net_arppu", async () => {
    for (const definition of PAYER_METRIC_DEFINITIONS) {
      assert.deepEqual(await boundaryResult("payer/valid", definition), {
        name: "payer/valid", schema: true, schedule: true, evaluator: true, sql: true,
      });
      for (const change of [{ rule_bundle_hash: "0".repeat(64) }, { fraud_policy: "net" },
        { acquisition_basis: "selected_imported_provider" }, { metric_name: "client_payers" },
        { grouping_dimensions: ["metric_date"] }, { aggregation_time_zone: "Asia/Tokyo" },
        { definition: { ...definition.definition, window: { type: "elapsed", day: 30 } } }]) {
        assert.deepEqual(await boundaryResult("payer/invalid", { ...definition, ...change } as Definition), {
          name: "payer/invalid", schema: false, schedule: false, evaluator: false, sql: false,
        });
      }
    }
  });
  it("calendar_activity_is_closed_to_gross_UTC_day_counts_and_distinct_installations", async () => {
    for (const definition of CALENDAR_ACTIVITY_METRIC_DEFINITIONS) {
      assert.ok(isCalendarActivityMetricDefinition(definition));
      assert.deepEqual(await boundaryResult("calendar_activity/valid", definition), {
        name: "calendar_activity/valid", schema: true, schedule: true, evaluator: true, sql: true,
      });
      for (const change of [
        { metric_name: "daily_install_count" }, { rule_bundle_hash: "0".repeat(64) },
        { metric_definition_version: "0.4.24" }, { rule_bundle_id: "metric-stage-m3" },
        { aggregation_time_zone: "Asia/Tokyo" }, { fraud_policy: "net" },
        { event_names: ["install"] }, { grouping_dimensions: ["metric_date", "country"] },
        { conversion_event_key: "synthetic_outcome" }, { acquisition_basis: "selected_first_party_click" },
        { definition: { ...definition.definition, window: { type: "calendar_day", day: 1 } } },
      ]) {
        const invalid = { ...structuredClone(definition), ...change } as Definition;
        assert.equal(isCalendarActivityMetricDefinition(invalid), false);
        assert.deepEqual(await boundaryResult("calendar_activity/invalid", invalid), {
          name: "calendar_activity/invalid", schema: false, schedule: false, evaluator: false, sql: false,
        });
      }
    }
    assert.equal(validateMetricDefinition({ ...M3_METRIC_DEFINITIONS[0], event_names: ["session_start"] }), false);
  });
  it("calendar_profile_requires_its_policy_zone_name_day_and_binding_without_upgrading_legacy_definitions", () => {
    const definition = calendarAcquisitionMetricDefinitions("America/New_York")[0];
    assert.ok(validateMetricDefinition(definition));
    for (const change of [{calendar_cohort_policy:undefined},{aggregation_time_zone:"UTC"},{metric_name:"calendar_jst_d0_roas"},
      {rule_bundle_hash:"0".repeat(64)},{metric_definition_version:"0.4.20"},
      {definition:{...definition.definition,window:{...definition.definition.window,type:"elapsed"}}}]) {
      const mutated = {...structuredClone(definition),...change};
      assert.equal(validateMetricDefinition(mutated),false);
      assert.equal(validateScheduledMetricDefinition(mutated),false);
      assert.throws(()=>assertMetricDefinitionSeries(mutated as unknown as Definition),/metric_definition_series_mismatch/);
    }
    assert.equal(validateMetricDefinition({...SELECTED_ACQUISITION_METRIC_DEFINITIONS[0],calendar_cohort_policy:definition.calendar_cohort_policy}),false);
  });
  it("metric_profile_schema_consistency distinguishes registered identities from legacy and external declarations", () => {
    const valid = [...metricProfileBoundaryCases().filter(entry => entry.name.endsWith("/valid")),
      ...ACQUISITION_KPI_METRIC_DEFINITIONS.map(definition => ({ name: "acquisition_kpis/valid", definition })),
      ...[...basisAcquisitionKpiDefinitions("selected_verified_platform"),
        ...basisAcquisitionKpiDefinitions("selected_imported_provider", "synthetic-export")]
        .map(definition => ({ name: "basis_acquisition_kpis/valid", definition })),
      ...CALENDAR_ACTIVITY_METRIC_DEFINITIONS.map(definition => ({ name: "calendar_activity/valid", definition })),
      ...PAYER_METRIC_DEFINITIONS.map(definition => ({ name: "payer/valid", definition })),
      ...engagementPolicyMetricDefinitions({ windowDays: 3, minimumInactivityDays: 7, eventKey: "tutorial_complete" })
        .map(definition => ({ name: "engagement_policy/valid", definition })),
      ...SELECTED_DAILY_ACQUISITION_METRIC_DEFINITIONS.map(definition => ({ name: "daily_acquisition/valid", definition })),
      ...([0, 30] as const).flatMap(day => horizonAcquisitionKpiDefinitions(day).map(definition => ({ name: "horizon_acquisition_kpis/valid", definition }))),
      ...VERIFIED_PLATFORM_METRIC_DEFINITIONS.map(definition => ({ name: "platform/valid", definition })),
      ...importedAcquisitionMetricDefinitions("synthetic-export").map(definition => ({ name: "imported/valid", definition })),
      ...(["selected_first_party_click", "selected_verified_platform", "selected_imported_provider"] as const)
        .flatMap(basis => standardRetentionMetricDefinitions(basis,
          basis === "selected_imported_provider" ? "synthetic-export" : undefined)
          .map(definition => ({ name: "standard_retention/valid", definition }))),
      ...COHORT_TIME_ZONES.flatMap(zone=>["selected_first_party_click","selected_verified_platform","selected_imported_provider"].flatMap(basis=>
        calendarAcquisitionMetricDefinitions(zone,basis as NonNullable<Definition["acquisition_basis"]>,basis === "selected_imported_provider" ? "synthetic-export" : undefined)
          .map(definition=>({name:"calendar/valid",definition}))))];
    assert.equal(valid.length, 266 + ACQUISITION_KPI_METRIC_DEFINITIONS.length + CALENDAR_ACTIVITY_METRIC_DEFINITIONS.length + PAYER_METRIC_DEFINITIONS.length);
    const exercised = new Set<string>();
    for (const { name, definition } of valid) {
      assert.ok(validateMetricDefinition(definition), name);
      assert.ok(validateScheduledMetricDefinition(definition), name);
      assert.doesNotThrow(() => assertMetricDefinitionSeries(definition), name);
      const metadata = metricProfileMetadata(definition);
      if (name.startsWith("apple/")) {
        // Existing external aggregate declarations are not registered non-fraud bundles.
        assert.equal(metadata, undefined, name);
      } else {
        assert.ok(metadata, name);
        exercised.add(metadata.key);
        assert.deepEqual(metadata.binding, { rule_bundle_id: definition.rule_bundle_id,
          rule_bundle_version: definition.rule_bundle_version, rule_bundle_hash: definition.rule_bundle_hash }, name);
      }
    }
    assert.deepEqual([...exercised].sort(), METRIC_PROFILE_METADATA.map(value => value.key).sort());
    const legacy = { ...REFERENCE_AD_REVENUE_METRIC_DEFINITIONS[0], metric_name: "synthetic_legacy",
      rule_bundle_id: "synthetic-unregistered-bundle" };
    assert.ok(validateScheduledMetricDefinition(legacy));
    assert.equal(metricProfileMetadata(legacy), undefined); // No registered-profile fallback.
    assert.equal(metricProfileMetadata({ ...SELECTED_COMMERCE_METRIC_DEFINITIONS[0], rule_bundle_hash: "0".repeat(64) }), undefined);
    for (const shape of [null, [], "synthetic", {}, { metric_name: "synthetic_partial" }]) {
      assert.equal(validateMetricDefinition(shape), false);
      assert.equal(validateScheduledMetricDefinition(shape), false);
      assert.equal(metricProfileMetadata(shape), undefined);
    }
  });

  it("basis_acquisition_KPIs_require_exact_provider_basis_horizon_and_role_at_every_entry", () => {
    const definitions = [...basisAcquisitionKpiDefinitions("selected_verified_platform"),
      ...basisAcquisitionKpiDefinitions("selected_imported_provider", "synthetic-export")];
    for (const definition of definitions) {
      assert.ok(validateMetricDefinition(definition));
      assert.ok(validateScheduledMetricDefinition(definition));
      assert.doesNotThrow(() => assertMetricDefinitionSeries(definition));
      for (const change of [{ rule_bundle_hash: "0".repeat(64) }, { metric_definition_version: "0.4.23" },
        { acquisition_basis: "selected_first_party_click" }, { import_provider: "invalid provider" },
        { metric_name: definition.metric_name.replace(/^(platform_|imported_)/, "") },
        { definition: { ...definition.definition, window: { type: "elapsed", day: 30 } } }]) {
        const invalid = { ...structuredClone(definition), ...change } as Definition;
        assert.equal(validateMetricDefinition(invalid), false);
        assert.equal(validateScheduledMetricDefinition(invalid), false);
        assert.throws(() => assertMetricDefinitionSeries(invalid), /metric_definition_series_mismatch/);
      }
    }
    assert.throws(() => basisAcquisitionKpiDefinitions("selected_imported_provider"), /acquisition_kpi_basis_invalid/);
    assert.throws(() => basisAcquisitionKpiDefinitions("selected_verified_platform", "synthetic-export"), /acquisition_kpi_basis_invalid/);
    const independent = basisAcquisitionKpiDefinitions("selected_verified_platform");
    independent[0].definition.window.day = 30;
    assert.equal(ACQUISITION_KPI_METRIC_DEFINITIONS[0].definition.window.day, 7);
  });

  it("keeps native acquisition horizon names, days and bundle binding closed without changing D7", () => {
    const original = sha256(ACQUISITION_KPI_METRIC_DEFINITIONS);
    for (const day of [0, 30] as const) for (const definition of horizonAcquisitionKpiDefinitions(day)) {
      assert.ok(validateMetricDefinition(definition));
      assert.ok(validateScheduledMetricDefinition(definition));
      assert.doesNotThrow(() => assertMetricDefinitionSeries(definition));
      assert.equal(metricProfileMetadata(definition)?.evaluationValidation, "schema_profile");
      for (const change of [{ rule_bundle_hash: "0".repeat(64) }, { metric_definition_version: "0.4.23" },
        { acquisition_basis: "selected_verified_platform" }, { import_provider: "synthetic-provider" },
        { metric_name: definition.metric_name.replace(`_d${day}_`, "_d7_") },
        { definition: { ...definition.definition, window: { type: "elapsed", day: 7 } } }]) {
        const invalid = { ...structuredClone(definition), ...change } as Definition;
        assert.equal(validateMetricDefinition(invalid), false);
        assert.equal(validateScheduledMetricDefinition(invalid), false);
        assert.throws(() => assertMetricDefinitionSeries(invalid), /metric_definition_series_mismatch/);
      }
    }
    assert.throws(() => horizonAcquisitionKpiDefinitions(7 as 0), /acquisition_kpi_horizon_invalid/);
    horizonAcquisitionKpiDefinitions(0)[0].definition.window.day = 9;
    assert.equal(sha256(ACQUISITION_KPI_METRIC_DEFINITIONS), original);
  });

  it("rejects malformed and unregistered closed profiles before schedule database writes", async () => {
    const profile = customConversionMetricDefinitions("synthetic_outcome")[0];
    const invalid = [null, [], {}, { ...profile, rule_bundle_id: "synthetic-unregistered-bundle" },
      { ...profile, definition: { ...profile.definition, window: "synthetic-invalid-window" } }];
    for (const candidate of invalid) {
      assert.equal(validateScheduledMetricDefinition(candidate), false);
      assert.throws(() => normalizeMetricScheduleRequest({ fx_policy: fx, metric_definitions: [candidate],
        evaluations: [{ metric_names: [profile.metric_name], date_dimension: "cohort_date", grouping: {} }] }),
      /metric_schedule_definitions_invalid/);
    }
    let databaseCalls = 0;
    const client: Parameters<typeof computeSqlMetricRunsWithClient>[0] = {
      query: async () => { databaseCalls++; throw new Error("unexpected database IO"); },
    };
    await assert.rejects(() => computeSqlMetricRunsWithClient(client, {
      fx_policy: fx, metric_definitions: [invalid[3]], metric_evaluations: [],
    }, true, { tenant_id: "synthetic-profile-tenant", app_id: "synthetic-profile-app" }),
    /metric_definition_series_mismatch/);
    assert.equal(databaseCalls, 0);
    const engagement = { ...engagementMetricDefinitions("synthetic_outcome")[0], rule_bundle_hash: "0".repeat(64) };
    assert.throws(() => assertMetricDefinitionSeries(engagement, "reference"), /invalid engagement metric profile/);
    assert.throws(() => assertMetricDefinitionSeries(engagement, "sql"), /metric_definition_series_mismatch/);
  });

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

  it("daily_selected_acquisition_profile_is_explicit_and_closed_at_every_entry", async () => {
    const daily = structuredClone(SELECTED_DAILY_ACQUISITION_METRIC_DEFINITIONS[0]);
    assert.deepEqual(await boundaryResult("daily_acquisition/valid", daily), {
      name: "daily_acquisition/valid", schema: true, schedule: true, evaluator: true, sql: true,
    });
    for (const change of [
      { metric_name: "daily_install_count" }, { rule_bundle_hash: "0".repeat(64) },
      { metric_definition_version: "0.3.1" }, { event_names: ["click"] },
      { grouping_dimensions: ["cohort_date"] }, { currency: "USD" },
      { cost_selection_policy: "reject_overlapping_grains" },
    ]) {
      const value = await boundaryResult("daily_acquisition/invalid", { ...daily, ...change } as Definition);
      assert.deepEqual(value, { name: "daily_acquisition/invalid", schema: false, schedule: false, evaluator: false, sql: false });
    }
    assert.equal(validateMetricDefinition({ ...M3_METRIC_DEFINITIONS[1], grouping_dimensions: ["metric_date", "acquisition_campaign_state"] }), false);
  });
  it("imported_provider_profile_is_closed_and_does_not_relabel_native_or_platform_definitions", async () => {
    const imported = importedAcquisitionMetricDefinitions("synthetic-export")[0];
    assert.deepEqual(await boundaryResult("imported/valid", imported), {
      name: "imported/valid", schema: true, schedule: true, evaluator: true, sql: true,
    });
    for (const change of [{ import_provider: undefined }, { import_provider: "invalid provider" },
      { rule_bundle_hash: "0".repeat(64) }, { metric_definition_version: "0.4.19" },
      { acquisition_basis: "selected_first_party_click" }, { metric_name: "platform_d0_roas" },
      { grouping_dimensions: ["campaign_id"] }, { conversion_event_key: "synthetic" }]) {
      const candidate = JSON.parse(JSON.stringify({ ...imported, ...change }));
      assert.deepEqual(await boundaryResult("imported/invalid", candidate), {
        name: "imported/invalid", schema: false, schedule: false, evaluator: false, sql: false,
      });
    }
    assert.equal(validateScheduledMetricDefinition({ ...SELECTED_ACQUISITION_METRIC_DEFINITIONS[0], import_provider: "synthetic-export" }), false);
    assert.equal(validateMetricDefinition({ ...VERIFIED_PLATFORM_METRIC_DEFINITIONS[0], import_provider: "synthetic-export" }), false);
  });
});
