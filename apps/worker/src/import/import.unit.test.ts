import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import { EnvironmentSecretStore } from "@openmasu/runtime";
import { lintMappings, loadMapping, mapRow, rowMatches } from "./mapping.js";
import { readRows } from "./source.js";
import {
  fetchGoogleAds,
  fetchMetaInsights,
  normalizeGoogleAds,
  normalizeMetaInsights,
} from "./adapters.js";
import { normalizeMaxAggregateRevenue } from "./max-revenue.js";
import { runGoogleCostImport } from "./google-cost-cli.js";
import { mappingsForLint, previewMmpImport, runMmpImport } from "./runner.js";
import {
  reportImportCompatibility,
  reportManualCostCompatibility,
  reportMmpImportCompatibility,
} from "./compatibility-cli.js";

describe("runtime import mapping", () => {
  it("applies nested objects, booleans, maps, uppercase, and timestamps", () => {
    const mapping = loadMapping("examples/mappings/synthetic-provider-click.json");
    const [row] = JSON.parse(requireText("examples/synthetic/mmp-raw-events.json"));
    const mapped = mapRow(mapping, row);
    assert.equal(mapped.payload.import_context.provider_attribution_strategy, "click_through");
    assert.equal(mapped.payload.import_context.provider_attributed, true);
    assert.equal(mapped.payload.country, "US");
    assert.equal(mapped.payload.bot_prefetch, false);
    assert.equal(mapped.occurred_at, "2026-08-19T00:00:00.000Z");
  });

  it("parses quoted CSV and enforces row byte limits", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmasu-import-"));
    try {
      const file = join(directory, "synthetic.csv");
      writeFileSync(file, 'network,campaign_id,country,date,cost_micros,currency\n"network, one",campaign-1,us,2026-08-18,1000000,USD\n');
      const mapping = loadMapping("examples/mappings/synthetic-manual-cost.json");
      const loaded = readRows(file, mapping, { maxBytes: 4096, maxRows: 2, maxRowBytes: 1024 });
      assert.equal(loaded.rows[0].network, "network, one");
      assert.throws(() => readRows(file, mapping, { maxBytes: 4096, maxRows: 2, maxRowBytes: 2 }), /exceeds 2 bytes/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("WO11 warns when event routes reuse one producer-scoped ID source without namespaces", () => {
    const click = loadMapping("examples/mappings/synthetic-shared-id-click.json");
    const install = loadMapping("examples/mappings/synthetic-shared-id-install.json");
    assert.deepEqual(lintMappings([click, install]), []);
    const unprefixed = [click, install].map((mapping) => ({
      ...mapping,
      rules: mapping.rules.map((rule) => rule.target === "event_id"
        ? { ...rule, expression: { source: "shared_id" } }
        : rule),
    }));
    assert.deepEqual(lintMappings(unprefixed), [{
      code: "event_id_source_reused_across_routes",
      provider: "synthetic-shared-provider",
      source: "shared_id",
      source_ids: ["synthetic-shared-clicks", "synthetic-shared-installs"],
      message: "event_id is producer-scoped across event names; add distinct prefixes or otherwise namespace the shared source column",
    }]);
  });

  it("WO11 evaluates every clause in an AND row filter", () => {
    const mapping = loadMapping("examples/mappings/synthetic-and-filter-click.json");
    assert.equal(rowMatches(mapping, { event_type: "click", row_status: "accepted" }), true);
    assert.equal(rowMatches(mapping, { event_type: "click", row_status: "rejected" }), false);
    assert.equal(rowMatches(mapping, { event_type: "install", row_status: "accepted" }), false);
  });

  it("WO11 uses a declared fallback column only when the primary column is empty", () => {
    const mapping = loadMapping("examples/mappings/synthetic-fallback-install.json");
    const base = {
      occurred_at: "2026-08-20T00:00:00", installation_id: "synthetic-fallback-installation",
      primary_event_id: "", legacy_event_id: "synthetic-legacy-event",
    };
    assert.equal(mapRow(mapping, base).event_id, "synthetic-legacy-event");
    assert.equal(mapRow(mapping, { ...base, primary_event_id: "synthetic-primary-event" }).event_id, "synthetic-primary-event");
  });

  it("WO11 converts an integer money column with explicit scale without losing precision", () => {
    const mapping = loadMapping("examples/mappings/synthetic-integer-cost.json");
    const base = {
      network: "synthetic-network", campaign_id: "synthetic-campaign", country: "jp",
      date: "2026-08-20", cost_micros: "123456789012345678", currency: "USD",
      as_of: "2026-08-20T12:00:00.000Z",
    };
    assert.deepEqual(mapRow(mapping, base).money, {
      amount_unscaled: "123456789012345678", amount_scale: 6, currency: "USD",
    });
    assert.throws(() => mapRow(mapping, { ...base, cost_micros: "-1" }), /non-negative base-10 integer/);
    assert.throws(() => mapRow(mapping, { ...base, cost_micros: Number.MAX_SAFE_INTEGER + 1 }), /non-negative base-10 integer/);
  });

  it("WO12 converts an exact decimal money source at the declared scale", () => {
    const mapping = loadMapping("examples/mappings/synthetic-decimal-cost.json");
    const mapped = mapRow(mapping, {
      network: "synthetic-decimal-network", campaign_id: "synthetic-decimal-campaign", country: "us",
      date: "2026-08-20", cost_decimal: "1.23", currency: "USD",
      as_of: "2026-08-20T12:00:00.000Z",
    });
    assert.deepEqual(mapped.money, {
      amount_unscaled: "1230000", amount_scale: 6, currency: "USD",
    });
  });

  it("WO12 rejects decimal precision beyond the declared scale without rounding", () => {
    const mapping = loadMapping("examples/mappings/synthetic-decimal-cost.json");
    const row = {
      network: "synthetic-decimal-network", campaign_id: "synthetic-decimal-campaign", country: "us",
      date: "2026-08-20", cost_decimal: "1.2345678", currency: "USD",
      as_of: "2026-08-20T12:00:00.000Z",
    };
    assert.throws(() => mapRow(mapping, row), /exceeds the declared scale; rounding is not permitted/);
  });

  it("WO12 rejects non-decimal and negative decimal money sources", () => {
    const mapping = loadMapping("examples/mappings/synthetic-decimal-cost.json");
    const base = {
      network: "synthetic-decimal-network", campaign_id: "synthetic-decimal-campaign", country: "us",
      date: "2026-08-20", currency: "USD", as_of: "2026-08-20T12:00:00.000Z",
    };
    assert.throws(() => mapRow(mapping, { ...base, cost_decimal: "not-a-number" }), /non-negative base-10 decimal string/);
    assert.throws(() => mapRow(mapping, { ...base, cost_decimal: "-1.23" }), /non-negative base-10 decimal string/);
    assert.throws(() => mapRow(mapping, { ...base, cost_decimal: 1.23 }), /non-negative base-10 decimal string/);
  });

  it("WO16 omits optional empty values while preserving populated values", () => {
    const mapping = loadMapping("examples/mappings/synthetic-optional-columns-click.json");
    const base = {
      event_id: "synthetic-optional-event", occurred_at: "2026-08-21T00:00:00",
      click_id: "synthetic-optional-click",
    };
    assert.equal(Object.hasOwn(mapRow(mapping, { ...base, network: "" }).payload, "network"), false);
    assert.equal(mapRow(mapping, { ...base, network: "synthetic-network" }).payload.network, "synthetic-network");
  });

  it("WO16 rejects omit_if_empty on a required event field at mapping load", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmasu-required-omit-"));
    try {
      const source = JSON.parse(requireText("examples/mappings/synthetic-optional-columns-click.json"));
      source.rules[3].expression.object.campaign_id = { source: "campaign_id", omit_if_empty: true };
      const file = join(directory, "mapping.json");
      writeFileSync(file, JSON.stringify(source));
      assert.throws(() => loadMapping(file), /omit_if_empty cannot target a required field/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("WO16 rejects omit_if_empty on a required manual-cost field", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmasu-required-cost-omit-"));
    try {
      const source = JSON.parse(requireText("examples/mappings/synthetic-manual-cost.json"));
      source.rules.find((rule: { target: string }) => rule.target === "network").expression.omit_if_empty = true;
      const file = join(directory, "mapping.json");
      writeFileSync(file, JSON.stringify(source));
      assert.throws(() => loadMapping(file), /omit_if_empty cannot target a required field/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("WO16 accepts a one-clause row_filter array", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmasu-one-filter-"));
    try {
      const source = JSON.parse(requireText("examples/mappings/synthetic-and-filter-click.json"));
      source.row_filter = [source.row_filter[0]];
      const file = join(directory, "mapping.json");
      writeFileSync(file, JSON.stringify(source));
      const mapping = loadMapping(file);
      assert.equal(rowMatches(mapping, { event_type: "click" }), true);
      assert.equal(rowMatches(mapping, { event_type: "install" }), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("WO16 lints only the selected mapping unless a directory is explicit", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmasu-lint-scope-"));
    try {
      const mappingPath = join(directory, "mapping.json");
      writeFileSync(mappingPath, requireText("examples/mappings/synthetic-provider-click.json"));
      writeFileSync(join(directory, "unrelated.json"), JSON.stringify({ unrelated: true }));
      assert.equal(mappingsForLint(mappingPath).length, 1);
      assert.throws(() => mappingsForLint(mappingPath, directory), /mapping schema validation failed/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("previews a valid existing-MMP export without persistence", () => {
    const preview = previewMmpImport({
      mappingPath: "examples/mappings/synthetic-provider-click.json",
      filePath: "examples/synthetic/mmp-raw-events.json",
    });
    assert.deepEqual(preview, {
      mode: "preview",
      persistence: "none",
      mapping_version: "1.0.0",
      format: "json",
      rows: { read: 1, selected: 1, filtered: 0, accepted: 1, rejected: 0 },
      warnings: [],
      rejections: [],
      limitations: [
        "database_identity_conflicts_not_checked",
        "provider_connectivity_not_checked",
      ],
    });
  });

  it("rejects a wrong-kind mapping before reading source bytes", async () => {
    const missing = join(tmpdir(), "openmasu-source-must-not-be-read.csv");
    assert.throws(() => previewMmpImport({
      mappingPath: "examples/mappings/synthetic-manual-cost.json",
      filePath: missing,
    }), /previewMmpImport requires an mmp_raw mapping/);
    await assert.rejects(runMmpImport({
      pool: {} as Pool,
      mappingPath: "examples/mappings/synthetic-manual-cost.json",
      filePath: missing,
    }), /runMmpImport requires an mmp_raw mapping/);
  });

  it("reports provider-neutral contract compatibility without changing preview output", () => {
    const report = reportMmpImportCompatibility({
      mappingPath: "examples/mappings/synthetic-provider-click.json",
      filePath: "examples/synthetic/mmp-raw-events.json",
    });
    const { compatibility } = report;
    assert.equal(report.mode, "compatibility_report");
    assert.equal(report.persistence, "none");
    assert.equal(compatibility.report_version, "1.0.0");
    assert.equal(compatibility.status, "compatible");
    assert.deepEqual(compatibility.event_name, { mode: "constant", value: "click" });
    assert.deepEqual(compatibility.field_coverage.missing_required_target_fields, []);
    assert.deepEqual(compatibility.checks, [
      { code: "rows_selected", status: "pass", count: 1 },
      { code: "mapping_transform", status: "pass", count: 0 },
      { code: "contract_schema", status: "pass", count: 0 },
      { code: "event_id_namespace", status: "not_evaluated", count: 0 },
    ]);
    assert.equal(report.limitations.includes("sibling_mapping_identity_conflicts_not_checked"), true);
    assert.deepEqual(
      compatibility.field_coverage.evidence_coverage.find(({ field }) => field === "payload.click_id"),
      { field: "payload.click_id", state: "observed", count: 1 },
    );
    assert.deepEqual(
      compatibility.field_coverage.evidence_coverage.find(({ field }) => field === "payload.network"),
      { field: "payload.network", state: "unmapped", count: 0 },
    );

    const linted = reportMmpImportCompatibility({
      mappingPath: "examples/mappings/synthetic-provider-click.json",
      filePath: "examples/synthetic/mmp-raw-events.json",
      lintDirectory: "examples/mappings",
    });
    assert.deepEqual(linted.compatibility.checks.find(({ code }) => code === "event_id_namespace"), {
      code: "event_id_namespace", status: "pass", count: 0,
    });
    assert.equal(linted.limitations.includes("sibling_mapping_identity_conflicts_not_checked"), false);
  });

  it("aggregates preview schema failures without exposing row values or paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmasu-preview-"));
    try {
      const file = join(directory, "private-export.json");
      const [valid] = JSON.parse(requireText("examples/synthetic/mmp-raw-events.json"));
      const invalidSecret = "must-not-appear-in-preview";
      writeFileSync(file, JSON.stringify([
        valid,
        { ...valid, event_id: "synthetic-invalid", click_id: "", campaign_id: invalidSecret },
        { ...valid, event_id: "synthetic-bad-time", occurred_at: "not-a-timestamp" },
        { ...valid, event_type: "install", event_id: "synthetic-filtered" },
      ]));
      const preview = reportMmpImportCompatibility({
        mappingPath: "examples/mappings/synthetic-provider-click.json",
        filePath: file,
      });
      assert.deepEqual(preview.rows, { read: 4, selected: 3, filtered: 1, accepted: 1, rejected: 2 });
      assert.equal(preview.compatibility.status, "partially_compatible");
      assert.deepEqual(preview.compatibility.checks.slice(0, 3), [
        { code: "rows_selected", status: "pass", count: 3 },
        { code: "mapping_transform", status: "warning", count: 1 },
        { code: "contract_schema", status: "warning", count: 1 },
      ]);
      assert.deepEqual(preview.rejections, [
        { reason_code: "row_schema_invalid", count: 1, fields: ["/click_id"] },
        { reason_code: "timestamp_invalid", count: 1, fields: [] },
      ]);
      const serialized = JSON.stringify(preview);
      assert.equal(serialized.includes(invalidSecret), false);
      assert.equal(serialized.includes(file), false);
      assert.equal(serialized.includes("synthetic-invalid"), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("distinguishes an unevaluated artifact from one that is not compatible", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmasu-compatibility-status-"));
    try {
      const [valid] = JSON.parse(requireText("examples/synthetic/mmp-raw-events.json"));
      const filteredFile = join(directory, "filtered.json");
      writeFileSync(filteredFile, JSON.stringify([{ ...valid, event_type: "install" }]));
      const filtered = reportMmpImportCompatibility({
        mappingPath: "examples/mappings/synthetic-provider-click.json",
        filePath: filteredFile,
      });
      assert.equal(filtered.compatibility.status, "not_evaluated");
      assert.equal(filtered.compatibility.checks[0]?.status, "not_evaluated");

      const invalidFile = join(directory, "invalid.json");
      writeFileSync(invalidFile, JSON.stringify([{ ...valid, click_id: "" }]));
      const invalid = reportMmpImportCompatibility({
        mappingPath: "examples/mappings/synthetic-provider-click.json",
        filePath: invalidFile,
      });
      assert.equal(invalid.compatibility.status, "not_compatible");
      assert.deepEqual(invalid.compatibility.checks.find(({ code }) => code === "contract_schema"), {
        code: "contract_schema", status: "fail", count: 1,
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("reports an execution-ready manual-cost artifact without source-value leakage", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmasu-cost-compatibility-"));
    try {
      const file = join(directory, "private-cost-export.csv");
      const privateNetwork = "must-not-appear-network";
      const privateCampaign = "must-not-appear-campaign";
      writeFileSync(file, [
        "network,campaign_id,country,date,cost_micros,currency,as_of",
        `${privateNetwork},${privateCampaign},us,2026-08-20,1250000,USD,2026-08-21T00:00:00.000Z`,
      ].join("\n"));
      const report = reportManualCostCompatibility({
        mappingPath: "examples/mappings/synthetic-manual-cost.json",
        filePath: file,
      });
      assert.equal(report.compatibility.kind, "manual_cost");
      assert.equal(report.compatibility.status, "compatible");
      assert.equal(report.compatibility.execution_ready, true);
      assert.deepEqual(report.rows, { read: 1, selected: 1, filtered: 0, accepted: 1, rejected: 0 });
      assert.deepEqual(report.compatibility.money, {
        input: "integer", scale: 6, currency_origin: "source",
      });
      assert.deepEqual(report.compatibility.field_coverage.missing_required_target_fields, []);
      assert.deepEqual(report.compatibility.checks, [
        { code: "rows_selected", status: "pass", count: 1 },
        { code: "mapping_transform", status: "pass", count: 0 },
        { code: "cost_schema", status: "pass", count: 0 },
        { code: "retained_dimension_uniqueness", status: "pass", count: 0 },
      ]);
      const serialized = JSON.stringify(report);
      assert.equal(serialized.includes(privateNetwork), false);
      assert.equal(serialized.includes(privateCampaign), false);
      assert.equal(serialized.includes("cost_micros"), false);
      assert.equal(serialized.includes(file), false);
      assert.equal(reportImportCompatibility({
        mappingPath: "examples/mappings/synthetic-manual-cost.json",
        filePath: file,
      }).compatibility.status, "compatible");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("keeps partial and duplicate manual-cost batches non-executable", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmasu-cost-readiness-"));
    try {
      const partialFile = join(directory, "partial.csv");
      writeFileSync(partialFile, [
        "network,campaign_id,country,date,cost_micros,currency,as_of",
        "synthetic-network,synthetic-campaign,us,2026-08-20,1000000,USD,2026-08-21T00:00:00.000Z",
        "synthetic-network,synthetic-other,us,2026-02-30,1000000,USD,2026-08-21T00:00:00.000Z",
      ].join("\n"));
      const partial = reportManualCostCompatibility({
        mappingPath: "examples/mappings/synthetic-manual-cost.json",
        filePath: partialFile,
      });
      assert.equal(partial.compatibility.status, "partially_compatible");
      assert.equal(partial.compatibility.execution_ready, false);
      assert.deepEqual(partial.rejections, [
        { reason_code: "cost_date_invalid", count: 1, fields: ["date"] },
      ]);

      const duplicateFile = join(directory, "duplicate.csv");
      writeFileSync(duplicateFile, [
        "network,campaign_id,country,date,cost_micros,currency,as_of",
        "synthetic-network,synthetic-campaign,us,2026-08-20,1000000,USD,2026-08-21T00:00:00.000Z",
        "synthetic-network,synthetic-campaign,us,2026-08-20,2000000,USD,2026-08-21T00:00:00.000Z",
      ].join("\n"));
      const duplicate = reportManualCostCompatibility({
        mappingPath: "examples/mappings/synthetic-manual-cost.json",
        filePath: duplicateFile,
      });
      assert.equal(duplicate.compatibility.status, "not_compatible");
      assert.equal(duplicate.compatibility.execution_ready, false);
      assert.deepEqual(duplicate.compatibility.checks.at(-1), {
        code: "retained_dimension_uniqueness", status: "fail", count: 1,
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("reports a filtered manual-cost artifact as not evaluated", () => {
    const directory = mkdtempSync(join(tmpdir(), "openmasu-cost-filtered-"));
    try {
      const mappingPath = join(directory, "mapping.json");
      const mapping = JSON.parse(requireText("examples/mappings/synthetic-manual-cost.json"));
      writeFileSync(mappingPath, JSON.stringify({
        ...mapping,
        row_filter: { source: "row_state", equals: "selected" },
      }));
      const file = join(directory, "filtered.csv");
      writeFileSync(file, [
        "network,campaign_id,country,date,cost_micros,currency,as_of,row_state",
        "synthetic-network,synthetic-campaign,us,2026-08-20,1000000,USD,2026-08-21T00:00:00.000Z,ignored",
      ].join("\n"));
      const report = reportManualCostCompatibility({ mappingPath, filePath: file });
      assert.equal(report.compatibility.status, "not_evaluated");
      assert.equal(report.compatibility.execution_ready, false);
      assert.equal(report.compatibility.checks.every(({ status }) => status === "not_evaluated"), true);
      assert.equal(JSON.stringify(report).includes("row_state"), false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("synthetic cost adapters", () => {
  const scope = { tenant_id: "tenant-a", app_id: "app-a", currency: "USD", as_of: "2026-08-19T00:00:00.000Z" };
  const range = { since: "2026-08-18", until: "2026-08-19" };
  const responses = JSON.parse(requireText("examples/synthetic/cost-responses.json"));
  const secrets = {
    read: (name: string) => name === "OPENMASU_META_ACCESS_TOKEN" ? "synthetic-meta-token" : undefined,
    require(name: string) {
      const value = this.read(name);
      if (!value) throw new Error(`${name} is required`);
      return value;
    },
  };
  const googleSecrets = {
    read: (name: string) => name === "OPENMASU_GOOGLE_ADS_ACCESS_TOKEN"
      ? "synthetic-google-access-token"
      : name === "OPENMASU_GOOGLE_ADS_DEVELOPER_TOKEN"
        ? "synthetic-google-developer-token"
        : undefined,
    require(name: string) {
      const value = this.read(name);
      if (!value) throw new Error(`${name} is required`);
      return value;
    },
  };
  const metaRow = (overrides: Record<string, unknown> = {}) => ({
    account_currency: "USD", campaign_id: "1001", adset_id: "2001", country: "US",
    spend: "12.345678", date_start: "2026-08-18", date_stop: "2026-08-18",
    ...overrides,
  });
  const googleAdGroupRow = (overrides: Record<string, unknown> = {}) => ({
    customer: { currencyCode: "USD" },
    campaign: {
      id: "4300000000000001",
      advertisingChannelType: "SEARCH",
      advertisingChannelSubType: "SEARCH_MOBILE_APP",
    },
    adGroup: { id: "4300000000000002" },
    geographicView: { countryCriterionId: "2840", locationType: "LOCATION_OF_PRESENCE" },
    segments: { date: "2026-08-18" },
    metrics: { costMicros: "2500000" },
    ...overrides,
  });
  const googleCampaignRow = (
    campaignId: string,
    advertisingChannelType: string,
    advertisingChannelSubType?: string,
    overrides: Record<string, unknown> = {},
  ) => ({
    customer: { currencyCode: "USD" },
    campaign: {
      id: campaignId,
      advertisingChannelType,
      ...(advertisingChannelSubType === undefined ? {} : { advertisingChannelSubType }),
    },
    geographicView: { countryCriterionId: "2840", locationType: "LOCATION_OF_PRESENCE" },
    segments: { date: "2026-08-18" },
    metrics: { costMicros: "1000000" },
    ...overrides,
  });
  const googleBatches = (rows: unknown[]) => [{ results: rows }];
  const googleGeoBatch = (entries: ReadonlyArray<readonly [string, string]>) => [{
    results: entries.map(([id, countryCode]) => ({ geoTargetConstant: { id, countryCode } })),
  }];
  const fetchGooglePayloads = (
    payloads: ReadonlyArray<unknown | Response>,
    overrides: Partial<Parameters<typeof fetchGoogleAds>[0]> = {},
  ) => {
    let index = 0;
    return fetchGoogleAds({
      fetch: async () => {
        const payload = payloads[index++];
        if (payload === undefined) throw new Error("unexpected synthetic Google Ads request");
        return payload instanceof Response ? payload : new Response(JSON.stringify(payload));
      },
      secrets: googleSecrets,
      customerId: "4300000000",
      scope,
      ...range,
      ...overrides,
    });
  };

  it("normalizes Meta daily country spend to scale-six money", () => {
    const [row] = normalizeMetaInsights(scope, responses.meta, range);
    assert.equal(row.amount_unscaled, "12345678");
    assert.equal(row.country, "US");
  });

  it("Issue 41 sends a bounded ad-set request and traverses cursors without following paging.next", async () => {
    const requests: Array<{ url: URL; init?: RequestInit }> = [];
    const pages = [
      {
        data: [metaRow({ campaign_id: "1002", adset_id: "2002", date_start: "2026-08-19", date_stop: "2026-08-19" })],
        paging: { next: "https://untrusted.invalid/should-not-be-followed?access_token=leak", cursors: { after: "cursor-one" } },
      },
      { data: [metaRow()] },
    ];
    const rows = await fetchMetaInsights({
      fetch: async (input, init) => {
        requests.push({ url: new URL(input.toString()), init });
        return new Response(JSON.stringify(pages[requests.length - 1]), { status: 200 });
      },
      secrets, accountId: "1234567890", scope, ...range,
    });
    assert.equal(requests.length, 2);
    const first = requests[0].url;
    assert.equal(first.origin, "https://graph.facebook.com");
    assert.equal(first.pathname, "/v26.0/act_1234567890/insights");
    assert.equal(first.searchParams.get("fields"), "account_currency,campaign_id,adset_id,spend,date_start,date_stop");
    assert.equal(first.searchParams.get("level"), "adset");
    assert.equal(first.searchParams.get("time_increment"), "1");
    assert.equal(first.searchParams.get("breakdowns"), "country");
    assert.equal(first.searchParams.get("time_range"), JSON.stringify(range));
    assert.equal(first.searchParams.get("limit"), "500");
    assert.equal(first.searchParams.has("access_token"), false);
    assert.equal(new Headers(requests[0].init?.headers).get("authorization"), "Bearer synthetic-meta-token");
    assert.equal(requests[1].url.origin, "https://graph.facebook.com");
    assert.equal(requests[1].url.searchParams.get("after"), "cursor-one");
    assert.deepEqual(rows.map((row) => [row.date, row.campaign_id]), [
      ["2026-08-18", "1001"], ["2026-08-19", "1002"],
    ]);
  });

  it("Issue 41 reads the Meta token through the existing secret-file boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmasu-meta-token-"));
    const tokenFile = join(directory, "token");
    try {
      writeFileSync(tokenFile, "synthetic-file-token\n", "utf8");
      const fileSecrets = new EnvironmentSecretStore({
        OPENMASU_META_ACCESS_TOKEN: { file: tokenFile },
      });
      let authorization: string | null = null;
      const rows = await fetchMetaInsights({
        fetch: async (_input, init) => {
          authorization = new Headers(init?.headers).get("authorization");
          return new Response(JSON.stringify({ data: [metaRow()] }));
        },
        secrets: fileSecrets, accountId: "1234567890", scope, ...range,
      });
      assert.equal(authorization, "Bearer synthetic-file-token");
      assert.equal(rows.length, 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("Issue 41 stops without another request when paging.next is absent", async () => {
    let calls = 0;
    const rows = await fetchMetaInsights({
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ data: [metaRow()], paging: { cursors: { after: "unused" } } }));
      },
      secrets, accountId: "1234567890", scope, ...range,
    });
    assert.equal(calls, 1);
    assert.equal(rows.length, 1);
  });

  it("Issue 41 rejects HTTP, JSON, provider-error, and response-shape failures", async () => {
    const invoke = (response: Response) => fetchMetaInsights({
      fetch: async () => response,
      secrets, accountId: "1234567890", scope, ...range,
    });
    await assert.rejects(invoke(new Response("failure", { status: 503 })), /failed with 503/);
    await assert.rejects(invoke(new Response("{", { status: 200 })), /not valid JSON/);
    await assert.rejects(invoke(new Response(JSON.stringify({ error: { code: 190 } }))), /error with code 190/);
    await assert.rejects(invoke(new Response(JSON.stringify({ data: {} }))), /data must be an array/);
    await assert.rejects(invoke(new Response(JSON.stringify({ data: Array.from({ length: 501 }, () => metaRow()) }))), /exceeded the requested 500-row page size/);
  });

  it("Issue 41 rejects invalid Meta identifiers, dates, country, currency, and spend precision", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ campaign_id: 1001 }, /campaign_id must be a numeric identifier/],
      [{ adset_id: "not-numeric" }, /adset_id must be a numeric identifier/],
      [{ date_start: "2026-02-30", date_stop: "2026-02-30" }, /real YYYY-MM-DD calendar day/],
      [{ date_stop: "2026-08-19" }, /not a daily result/],
      [{ date_start: "2026-08-17", date_stop: "2026-08-17" }, /outside the requested range/],
      [{ country: "usa" }, /ISO-3166-1 alpha-2/],
      [{ account_currency: "EUR" }, /does not match --currency/],
      [{ spend: 12.3 }, /spend is required/],
      [{ spend: "1.1234567" }, /exceeds scale 6/],
    ];
    for (const [overrides, expected] of cases) {
      await assert.rejects(fetchMetaInsights({
        fetch: async () => new Response(JSON.stringify({ data: [metaRow(overrides)] })),
        secrets, accountId: "1234567890", scope, ...range,
      }), expected);
    }
  });

  it("Issue 41 bounds pagination and rejects duplicate retained dimensions", async () => {
    await assert.rejects(fetchMetaInsights({
      fetch: async () => new Response(JSON.stringify({
        data: [metaRow()], paging: { next: "https://graph.facebook.com/next", cursors: { after: "cursor" } },
      })),
      secrets, accountId: "1234567890", scope, ...range, maxPages: 1,
    }), /exceeded 1 pages/);
    await assert.rejects(fetchMetaInsights({
      fetch: async () => new Response(JSON.stringify({ data: [metaRow(), metaRow({ spend: "1.000000" })] })),
      secrets, accountId: "1234567890", scope, ...range,
    }), /duplicate retained dimension key/);
  });

  it("Issue 41 rejects a repeated pagination cursor", async () => {
    let calls = 0;
    await assert.rejects(fetchMetaInsights({
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          data: [metaRow({ campaign_id: String(1000 + calls) })],
          paging: { next: "https://graph.facebook.com/next", cursors: { after: "repeated-cursor" } },
        }));
      },
      secrets, accountId: "1234567890", scope, ...range,
    }), /repeated an after cursor/);
    assert.equal(calls, 2);
  });

  it("Issue 43 sends bounded partitioned SearchStream queries without collapsing dimensions", async () => {
    const requests: Array<{ url: URL; headers: Headers; query: string }> = [];
    const payloads = [
      googleBatches([
        googleCampaignRow("4300000000000004", "MULTI_CHANNEL", "APP_CAMPAIGN"),
        googleCampaignRow("4300000000000005", "MULTI_CHANNEL", "APP_CAMPAIGN_FOR_ENGAGEMENT"),
        googleCampaignRow("4300000000000006", "MULTI_CHANNEL", "APP_CAMPAIGN_FOR_PRE_REGISTRATION", {
          segments: { date: "2026-08-19" },
        }),
      ]),
      googleBatches([
        googleAdGroupRow({
          campaign: { id: "4300000000000001", advertisingChannelType: "SEARCH" },
          adGroup: { id: "4300000000000002" },
        }),
        googleAdGroupRow({
          campaign: {
            id: "4300000000000001",
            advertisingChannelType: "DEMAND_GEN",
          },
          adGroup: { id: "4300000000000003" },
        }),
      ]),
      googleBatches([
        googleCampaignRow("4300000000000007", "PERFORMANCE_MAX"),
        googleCampaignRow("4300000000000008", "LOCAL_SERVICES"),
      ]),
      googleGeoBatch([["2840", "US"]]),
    ];
    const rows = await fetchGoogleAds({
      fetch: async (input, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        requests.push({
          url: new URL(input.toString()),
          headers: new Headers(init?.headers),
          query: body.query,
        });
        return new Response(JSON.stringify(payloads[requests.length - 1]));
      },
      secrets: googleSecrets,
      customerId: "4300000000",
      loginCustomerId: "4300000009",
      scope,
      ...range,
      limits: { maxRows: 10, maxRequests: 4 },
    });
    assert.equal(requests.length, 4);
    assert.equal(requests[0].url.href, "https://googleads.googleapis.com/v25/customers/4300000000/googleAds:searchStream");
    for (const request of requests) {
      assert.equal(request.headers.get("authorization"), "Bearer synthetic-google-access-token");
      assert.equal(request.headers.get("developer-token"), "synthetic-google-developer-token");
      assert.equal(request.headers.get("login-customer-id"), "4300000009");
      assert.equal(request.headers.get("content-type"), "application/json");
      assert.equal(request.query.includes("synthetic-google"), false);
      assert.equal(request.query.includes("4300000000"), false);
    }
    const [appQuery, adGroupQuery, campaignOnlyQuery, geoQuery] = requests.map(({ query }) => query);
    for (const query of [appQuery, adGroupQuery, campaignOnlyQuery]) {
      assert.match(query, /customer\.currency_code/);
      assert.match(query, /campaign\.advertising_channel_type/);
      assert.match(query, /campaign\.advertising_channel_sub_type/);
      assert.match(query, /geographic_view\.location_type = 'LOCATION_OF_PRESENCE'/);
      assert.match(query, /segments\.date BETWEEN '2026-08-18' AND '2026-08-19'/);
    }
    const exactAppSubtypes = "'APP_CAMPAIGN', 'APP_CAMPAIGN_FOR_ENGAGEMENT', 'APP_CAMPAIGN_FOR_PRE_REGISTRATION'";
    const exactAdGroupTypes = "'DEMAND_GEN', 'DISPLAY', 'HOTEL', 'LOCAL', 'SEARCH', 'SHOPPING', 'SMART', 'TRAVEL', 'VIDEO'";
    assert.doesNotMatch(appQuery, /ad_group\.id/);
    assert.match(appQuery, new RegExp(`IN \\(${exactAppSubtypes}\\)`));
    assert.match(appQuery, /LIMIT 11$/);
    assert.match(adGroupQuery, /ad_group\.id/);
    assert.match(adGroupQuery, new RegExp(`IN \\(${exactAdGroupTypes}\\)`));
    assert.match(adGroupQuery, new RegExp(`NOT IN \\(${exactAppSubtypes}\\)`));
    assert.match(adGroupQuery, /LIMIT 8$/);
    assert.doesNotMatch(campaignOnlyQuery, /ad_group\.id/);
    assert.match(campaignOnlyQuery, new RegExp(`NOT IN \\(${exactAdGroupTypes}\\)`));
    assert.match(campaignOnlyQuery, new RegExp(`NOT IN \\(${exactAppSubtypes}\\)`));
    assert.match(campaignOnlyQuery, /LIMIT 6$/);
    assert.match(geoQuery, /^SELECT geo_target_constant\.id, geo_target_constant\.country_code FROM geo_target_constant/);
    assert.match(geoQuery, /WHERE geo_target_constant\.id IN \(2840\) LIMIT 2$/);
    assert.deepEqual(
      rows.filter((row) => row.campaign_id === "4300000000000001").map((row) => row.ad_group_id),
      ["4300000000000002", "4300000000000003"],
    );
    assert.deepEqual(
      rows.filter((row) => row.campaign_id !== "4300000000000001").map((row) => row.ad_group_id),
      [null, null, null, null, null],
    );
    assert.equal(rows.find((row) => row.campaign_id === "4300000000000006")?.date, "2026-08-19");
    assert.equal(rows.length, 7);
  });

  it("Issue 43 accepts omitted empty SearchStream results and omits the manager header", async () => {
    const headers: Headers[] = [];
    const payloads: unknown[] = [[{}], [], []];
    let calls = 0;
    const rows = await fetchGoogleAds({
      fetch: async (_input, init) => {
        headers.push(new Headers(init?.headers));
        return new Response(JSON.stringify(payloads[calls++]));
      },
      secrets: googleSecrets,
      customerId: "4300000000",
      scope,
      ...range,
    });
    assert.equal(calls, 3);
    assert.equal(rows.length, 0);
    assert.ok(headers.every((value) => !value.has("login-customer-id")));
  });

  it("Issue 43 rejects an empty report before opening a database transaction", async () => {
    let calls = 0;
    let connects = 0;
    const pool = {
      connect() {
        connects += 1;
        throw new Error("database must not be reached");
      },
    } as unknown as Pool;
    await assert.rejects(runGoogleCostImport({
      pool,
      fetch: async () => {
        calls += 1;
        return new Response("[]");
      },
      secrets: googleSecrets,
      tenantId: "tenant-a",
      appId: "app-a",
      customerId: "4300000000",
      currency: "USD",
      ...range,
      asOf: "2026-08-19T00:00:00.000Z",
    }), /returned no cost rows/);
    assert.equal(calls, 3);
    assert.equal(connects, 0);
  });

  it("Issue 43 reads both Google Ads secrets through the secret-file boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openmasu-google-tokens-"));
    try {
      const accessTokenFile = join(directory, "access-token");
      const developerTokenFile = join(directory, "developer-token");
      writeFileSync(accessTokenFile, "synthetic-file-access-token\n", "utf8");
      writeFileSync(developerTokenFile, "synthetic-file-developer-token\n", "utf8");
      const fileSecrets = new EnvironmentSecretStore({
        OPENMASU_GOOGLE_ADS_ACCESS_TOKEN: { file: accessTokenFile },
        OPENMASU_GOOGLE_ADS_DEVELOPER_TOKEN: { file: developerTokenFile },
      });
      const captured: Headers[] = [];
      const rows = await fetchGoogleAds({
        fetch: async (_input, init) => {
          captured.push(new Headers(init?.headers));
          return new Response("[]");
        },
        secrets: fileSecrets,
        customerId: "4300000000",
        scope,
        ...range,
      });
      assert.equal(rows.length, 0);
      assert.equal(captured.length, 3);
      assert.equal(captured[0].get("authorization"), "Bearer synthetic-file-access-token");
      assert.equal(captured[0].get("developer-token"), "synthetic-file-developer-token");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("Issue 43 rejects invalid identifiers, dates, currency, API version, and limits before fetching", async () => {
    const cases: Array<[Partial<Parameters<typeof fetchGoogleAds>[0]>, RegExp]> = [
      [{ customerId: "430-000-0000" }, /10-digit customer ID without hyphens/],
      [{ loginCustomerId: "manager" }, /10-digit customer ID without hyphens/],
      [{ apiVersion: "latest" }, /apiVersion must be v25/],
      [{ apiVersion: "v26" }, /apiVersion must be v25/],
      [{ since: "2026-02-30" }, /real YYYY-MM-DD calendar day/],
      [{ since: "2026-08-20", until: "2026-08-19" }, /since must not be after until/],
      [{ scope: { ...scope, currency: "usd" } }, /uppercase ISO-4217/],
      [{ limits: { maxRows: Number.MAX_SAFE_INTEGER } }, /overflow sentinel/],
      [{ limits: { maxGeoCriteria: 1, lookupChunkSize: 2 } }, /lookupChunkSize must not exceed/],
      [{ limits: { maxGeoCriteria: 20_001, lookupChunkSize: 20_001 } }, /provider IN-list limit/],
    ];
    for (const [overrides, expected] of cases) {
      await assert.rejects(fetchGooglePayloads([], overrides), expected);
    }
  });

  it("Issue 43 strictly validates cost rows and their query partition", async () => {
    const invalidAdGroupRows: Array<[unknown, RegExp]> = [
      [googleAdGroupRow({ campaign: { id: "4300000000000001" } }), /advertisingChannelType is required/],
      [googleAdGroupRow({ campaign: {
        id: 43, advertisingChannelType: "SEARCH", advertisingChannelSubType: "SEARCH_MOBILE_APP",
      } }), /campaign\.id must be a canonical/],
      [googleAdGroupRow({ adGroup: undefined }), /adGroup\.id must be a canonical/],
      [googleAdGroupRow({ customer: { currencyCode: "EUR" } }), /currency does not match --currency/],
      [googleAdGroupRow({
        geographicView: { countryCriterionId: "2840", locationType: "AREA_OF_INTEREST" },
      }), /location type is not LOCATION_OF_PRESENCE/],
      [googleAdGroupRow({ segments: { date: "2026-08-17" } }), /outside the requested range/],
      [googleAdGroupRow({ metrics: { costMicros: "-1" } }), /costMicros must be a canonical/],
      [googleAdGroupRow({ campaign: {
        id: "4300000000000001", advertisingChannelType: "PERFORMANCE_MAX",
      } }), /did not match the requested campaign subtype partition/],
    ];
    for (const [row, expected] of invalidAdGroupRows) {
      await assert.rejects(fetchGooglePayloads([[], googleBatches([row])]), expected);
    }
    await assert.rejects(fetchGooglePayloads([googleBatches([
      googleCampaignRow("4300000000000004", "SEARCH", "APP_CAMPAIGN"),
    ])]), /did not match the requested campaign subtype partition/);
    await assert.rejects(fetchGooglePayloads([googleBatches([
      googleCampaignRow("4300000000000004", "MULTI_CHANNEL", "UNSPECIFIED"),
    ])]), /did not match the requested campaign subtype partition/);
  });

  it("Issue 43 fails closed for residual MULTI_CHANNEL and future campaign types", async () => {
    for (const channelType of ["MULTI_CHANNEL", "FUTURE_CHANNEL_TYPE"]) {
      await assert.rejects(fetchGooglePayloads([
        [],
        [],
        googleBatches([googleCampaignRow("4300000000000009", channelType, "UNSPECIFIED")]),
      ]), /did not match the requested campaign subtype partition/);
    }
  });

  it("Issue 43 rejects HTTP, body, JSON, response-shape, batch, row, request, and byte bound failures", async () => {
    await assert.rejects(fetchGooglePayloads([
      new Response("failure", { status: 503 }),
    ]), /App cost request failed with 503/);
    let redirectMode: RequestRedirect | undefined;
    await assert.rejects(fetchGoogleAds({
      fetch: async (_input, init) => {
        redirectMode = init?.redirect;
        return new Response(null, { status: 302, headers: { location: "https://untrusted.invalid/" } });
      },
      secrets: googleSecrets,
      customerId: "4300000000",
      scope,
      ...range,
    }), /App cost request failed with 302/);
    assert.equal(redirectMode, "error");
    await assert.rejects(fetchGooglePayloads([
      new Response(null),
    ]), /response body is required/);
    await assert.rejects(fetchGooglePayloads([
      new Response(new Uint8Array([0xff])),
    ]), /not valid UTF-8/);
    await assert.rejects(fetchGooglePayloads([
      new Response("{"),
    ]), /not valid JSON/);
    await assert.rejects(fetchGooglePayloads([{}]), /response must be an array/);
    await assert.rejects(fetchGooglePayloads([[{}, {}]], {
      limits: { maxBatches: 1 },
    }), /exceeded the batch limit/);
    await assert.rejects(fetchGooglePayloads([
      googleBatches([
        googleCampaignRow("4300000000000004", "MULTI_CHANNEL", "APP_CAMPAIGN"),
        googleCampaignRow("4300000000000005", "MULTI_CHANNEL", "APP_CAMPAIGN_FOR_ENGAGEMENT"),
      ]),
    ], { limits: { maxRows: 1 } }), /exceeded the row limit/);
    await assert.rejects(fetchGooglePayloads([[], []], {
      limits: { maxRequests: 2 },
    }), /request limit exceeded/);
    await assert.rejects(fetchGooglePayloads([
      new Response("[]"), new Response("[]"), new Response("[]"),
    ], { limits: { maxResponseBytes: 5 } }), /exceeded the byte limit/);
  });

  it("Issue 43 applies one combined cost-row bound and finite geo bounds", async () => {
    await assert.rejects(fetchGooglePayloads([
      googleBatches([googleCampaignRow("4300000000000004", "MULTI_CHANNEL", "APP_CAMPAIGN")]),
      googleBatches([googleAdGroupRow()]),
    ], { limits: { maxRows: 1 } }), /exceeded the row limit/);
    await assert.rejects(fetchGooglePayloads([
      [],
      googleBatches([
        googleAdGroupRow({
          adGroup: { id: "4300000000000002" },
          geographicView: { countryCriterionId: "2840", locationType: "LOCATION_OF_PRESENCE" },
        }),
        googleAdGroupRow({
          adGroup: { id: "4300000000000003" },
          geographicView: { countryCriterionId: "2392", locationType: "LOCATION_OF_PRESENCE" },
        }),
      ]),
      [],
    ], { limits: { maxGeoCriteria: 1, lookupChunkSize: 1 } }), /country-criterion limit/);
    await assert.rejects(fetchGooglePayloads([
      [],
      googleBatches([
        googleAdGroupRow({
          adGroup: { id: "4300000000000002" },
          geographicView: { countryCriterionId: "2840", locationType: "LOCATION_OF_PRESENCE" },
        }),
        googleAdGroupRow({
          adGroup: { id: "4300000000000003" },
          geographicView: { countryCriterionId: "2392", locationType: "LOCATION_OF_PRESENCE" },
        }),
      ]),
      [],
    ], { limits: { maxGeoCriteria: 2, lookupChunkSize: 1, maxRequests: 4 } }), /request limit exceeded/);
  });

  it("Issue 43 rejects incomplete, cross-chunk, ambiguous, and invalid geo lookups", async () => {
    const adGroupRows = googleBatches([
      googleAdGroupRow({
        adGroup: { id: "4300000000000002" },
        geographicView: { countryCriterionId: "2840", locationType: "LOCATION_OF_PRESENCE" },
      }),
      googleAdGroupRow({
        adGroup: { id: "4300000000000003" },
        geographicView: { countryCriterionId: "2392", locationType: "LOCATION_OF_PRESENCE" },
      }),
    ]);
    await assert.rejects(fetchGooglePayloads([
      [], googleBatches([googleAdGroupRow()]), [], [],
    ]), /did not resolve every country criterion/);
    await assert.rejects(fetchGooglePayloads([
      [], adGroupRows, [], googleGeoBatch([["2840", "US"]]),
    ], { limits: { maxGeoCriteria: 2, lookupChunkSize: 1, maxRequests: 5 } }), /unexpected criterion/);
    await assert.rejects(fetchGooglePayloads([
      [], adGroupRows, [], googleGeoBatch([["2392", "JP"], ["2392", "US"]]),
    ]), /ambiguous criterion/);
    await assert.rejects(fetchGooglePayloads([
      [], googleBatches([googleAdGroupRow()]), [], googleGeoBatch([["2840", "usa"]]),
    ]), /uppercase ISO-3166-1 alpha-2/);
  });

  it("Issue 43 rejects duplicate retained dimensions after every provider read", async () => {
    let calls = 0;
    const payloads = [
      [],
      googleBatches([
        googleAdGroupRow(),
        googleAdGroupRow({ metrics: { costMicros: "3000000" } }),
      ]),
      [],
      googleGeoBatch([["2840", "US"]]),
    ];
    await assert.rejects(fetchGoogleAds({
      fetch: async () => new Response(JSON.stringify(payloads[calls++])),
      secrets: googleSecrets,
      customerId: "4300000000",
      scope,
      ...range,
    }), /duplicate retained dimension key/);
    assert.equal(calls, 4);
  });

  it("normalizes Google Ads ad-group, App, Performance Max, and Local Services partitions", () => {
    const rows = normalizeGoogleAds(scope, responses.google_ads, { "2840": "US" }, range);
    assert.deepEqual(rows.map((row) => [row.campaign_id, row.ad_group_id, row.amount_unscaled]), [
      ["4001", "5001", "23456789"],
      ["4002", null, "1000000"],
      ["4003", null, "2000000"],
      ["4004", null, "3000000"],
    ]);
  });

  it("normalizes MAX reporting backfill as daily aggregate revenue", () => {
    const [row] = normalizeMaxAggregateRevenue({
      tenant_id: scope.tenant_id,
      app_id: scope.app_id,
      as_of: scope.as_of,
    }, responses.max);
    assert.equal(row.amount_unscaled, "1234567");
    assert.equal(row.currency, "USD");
    assert.equal(row.source_series, "provider_reported_aggregate");
    assert.equal("installation_id" in row, false);
  });
});

function requireText(path: string): string {
  return readFileSync(path, "utf8");
}
