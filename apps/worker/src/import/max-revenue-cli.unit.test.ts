import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchMaxAggregateRevenue, validateMaxReportRange } from "./max-revenue-cli.js";

const secrets = {
  read: (name: string) => name === "OPENMASU_MAX_REPORT_KEY" ? "synthetic-report-key" : undefined,
  require(name: string) {
    const value = this.read(name);
    if (!value) throw new Error(`${name} is required`);
    return value;
  },
};

describe("MAX aggregate revenue command", () => {
  it("paginates the documented JSON response with bounded, fixed report columns", async () => {
    const requests: URL[] = [];
    const pages = [
      [
        { day: "2026-08-23", country: "us", max_ad_unit_id: "synthetic-unit-a", network: "synthetic-network", estimated_revenue: "1.250000" },
        { day: "2026-08-23", country: "jp", max_ad_unit_id: "synthetic-unit-b", network: "synthetic-network", estimated_revenue: "2.500000" },
      ],
      [
        { day: "2026-08-24", country: "us", max_ad_unit_id: "synthetic-unit-a", network: "synthetic-network", estimated_revenue: "3.750000" },
      ],
    ];
    const result = await fetchMaxAggregateRevenue({
      fetch: async (input, init) => {
        assert.equal(init?.redirect, "error");
        const url = new URL(String(input));
        requests.push(url);
        const results = pages[requests.length - 1];
        return new Response(JSON.stringify({ code: 200, count: results.length, results }));
      },
      secrets,
      tenantId: "tenant-synthetic",
      appId: "app-synthetic",
      start: "2026-08-23",
      end: "2026-08-24",
      asOf: "2026-08-24T10:00:00.000Z",
      now: new Date("2026-08-24T12:00:00.000Z"),
      pageSize: 2,
    });
    assert.equal(result.pages, 2);
    assert.equal(result.rows.length, 3);
    assert.deepEqual(requests.map((url) => url.searchParams.get("offset")), ["0", "2"]);
    assert.ok(requests.every((url) => url.searchParams.get("columns") === "day,country,max_ad_unit_id,network,estimated_revenue"));
    assert.ok(requests.every((url) => url.searchParams.get("api_key") === "synthetic-report-key"));
    assert.deepEqual(
      ["day", "country", "max_ad_unit_id", "network"].map((field) => requests[0].searchParams.get(`sort_${field}`)),
      ["ASC", "ASC", "ASC", "ASC"],
    );
  });

  it("fails closed outside the provider's current 45-day UTC window", async () => {
    assert.throws(
      () => validateMaxReportRange("2026-07-10", "2026-08-24", new Date("2026-08-24T12:00:00.000Z")),
      /45-day UTC request window/,
    );
    let called = false;
    await assert.rejects(fetchMaxAggregateRevenue({
      fetch: async () => {
        called = true;
        return new Response("{}");
      },
      secrets,
      tenantId: "tenant-synthetic",
      appId: "app-synthetic",
      start: "2026-07-10",
      end: "2026-08-24",
      asOf: "2026-08-24T10:00:00.000Z",
      now: new Date("2026-08-24T12:00:00.000Z"),
    }), /45-day UTC request window/);
    assert.equal(called, false);
  });

  it("rejects mismatched provider counts and does not expose the report key", async () => {
    await assert.rejects(fetchMaxAggregateRevenue({
      fetch: async () => new Response(JSON.stringify({
        code: 200,
        count: 2,
        results: [{ day: "2026-08-24", country: "us", max_ad_unit_id: "synthetic-unit", network: "synthetic-network", estimated_revenue: "1.000000" }],
      })),
      secrets,
      tenantId: "tenant-synthetic",
      appId: "app-synthetic",
      start: "2026-08-24",
      end: "2026-08-24",
      asOf: "2026-08-24T10:00:00.000Z",
      now: new Date("2026-08-24T12:00:00.000Z"),
    }), (error: unknown) => {
      assert.match(String(error), /count does not match/);
      assert.doesNotMatch(String(error), /synthetic-report-key/);
      return true;
    });
  });

  it("redacts the credential-bearing URL from transport failures", async () => {
    await assert.rejects(fetchMaxAggregateRevenue({
      fetch: async (input) => {
        throw new Error(`synthetic network failure for ${String(input)}`);
      },
      secrets,
      tenantId: "tenant-synthetic",
      appId: "app-synthetic",
      start: "2026-08-24",
      end: "2026-08-24",
      asOf: "2026-08-24T10:00:00.000Z",
      now: new Date("2026-08-24T12:00:00.000Z"),
    }), (error: unknown) => {
      assert.equal(String(error), "Error: MAX Reporting API request failed");
      assert.doesNotMatch(String(error), /synthetic-report-key/);
      return true;
    });
  });
});
