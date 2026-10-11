import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EnvironmentSecretStore, normalizeCostRefreshDefinition, type AppleCostRefreshDefinition } from "@openmasu/runtime";
import { fetchAppleAds } from "./apple-cost.js";

const definition = normalizeCostRefreshDefinition({ provider: "apple_ads", ad_account_id: "23501", app_store_id: "23502",
  campaign_ids: ["23503", "23504"], currency: "USD", account_time_zone: "America/New_York", limits: { pageSize: 1 } }) as AppleCostRefreshDefinition;
const options = { definition, since: "2026-10-01", until: "2026-10-02",
  scope: { tenant_id: "tenant-synthetic", app_id: "app-synthetic", currency: "USD", as_of: "2026-10-03T00:00:00.000Z" },
  secrets: new EnvironmentSecretStore({ OPENMASU_APPLE_ADS_ACCESS_TOKEN: { value: "synthetic-apple-access" } }) };
function page(offset: number) {
  return { result: { rows: [{ metadata: { id: 23503 + offset, adAccountId: 23501, promotedObjectId: "23502", promotedObjectType: "APPSTORE_APP" },
    totalMetrics: { localSpend: { amount: "999", currency: "USD" } }, // Must never be added to daily rows.
    granularMetrics: ["2026-10-01", "2026-10-02"].map(date => ({ date, localSpend: { amount: "1.234567890123456789", currency: "USD" } })) }] },
    pagination: { offset, pageSize: 1, totalCount: 2 } };
}
describe("bounded Apple Ads Platform campaign cost", () => {
  it("reads complete UTC daily pages once without adding total metrics or rounding decimal money", async () => {
    const offsets: number[] = [];
    const result = await fetchAppleAds({ ...options, fetch: async (url, init) => {
      assert.equal(String(url), "https://api.ads.apple.com/v1/reports/apps/campaigns/query");
      assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as Record<string, string>)["X-AP-Context"], "adAccountId=23501");
      const body = JSON.parse(String(init?.body)); offsets.push(body.pagination.offset);
      assert.deepEqual(body.filters, [{ field: "campaignId", operator: "IN", value: ["23503", "23504"] }]);
      assert.deepEqual(body.timeRange, { start: options.since, end: options.until, timeZone: "UTC", granularity: "DAILY" });
      assert.equal(body.groupBy, undefined);
      return Response.json(page(body.pagination.offset));
    } });
    assert.deepEqual(offsets, [0, 1]); assert.equal(result.length, 4);
    assert.ok(result.every(row => row.amount_unscaled === "1234567890123456789" && row.amount_scale === 18
      && row.reporting_time_zone === "UTC" && row.network === "apple_adservices" && row.country === undefined));
  });
  it("uses totals only for a single declared day and keeps no rows separate from zero spend", async () => {
    const single = { ...options, until: options.since, definition: { ...definition, campaign_ids: ["23503"] } };
    const result = await fetchAppleAds({ ...single, fetch: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).timeRange.granularity, undefined);
      const body = page(0); body.pagination.totalCount = 1;
      body.result.rows[0].totalMetrics.localSpend.amount = "0.00";
      return Response.json(body);
    } });
    assert.equal(result.length, 1); assert.equal(result[0].amount_unscaled, "0");
    assert.deepEqual(await fetchAppleAds({ ...single, fetch: async () => Response.json({ result: {} }) }), []);
  });
  it("rejects malformed, missing, cross-scope and duplicate evidence before returning any cost", async () => {
    const mutations: ((v: any) => void)[] = [
      v => { v.result.rows[0].metadata.adAccountId = 999; }, v => { v.result.rows[0].metadata.promotedObjectId = "999"; },
      v => { v.result.rows[0].granularMetrics.pop(); }, v => { v.result.rows[0].granularMetrics[1].date = "2026-10-01"; },
      v => { delete v.result.rows[0].granularMetrics[0].localSpend; }, v => { v.result.rows[0].granularMetrics[0].localSpend.currency = "JPY"; },
      ...["NaN", "-1", "1e2", "1.0000000000000000001", "1\n"].map(amount => (v: any) => { v.result.rows[0].granularMetrics[0].localSpend.amount = amount; }),
      v => { v.pagination.totalCount = 1; }, v => { v.error = { detail: "synthetic-private-detail" }; },
    ];
    for (const mutate of mutations) await assert.rejects(fetchAppleAds({ ...options, fetch: async () => {
      const body = page(0); mutate(body); return Response.json(body);
    } }), /Apple Ads/);
    await assert.rejects(fetchAppleAds({ ...options, fetch: async (_url, init) => {
      const offset = JSON.parse(String(init?.body)).pagination.offset; const body = page(offset);
      if (offset) body.result.rows[0].metadata.id = 23503;
      return Response.json(body);
    } }), /duplicate/);
  });
  it("bounds cumulative bytes, pages, rows and failure responses without leaking source bodies", async () => {
    for (const limits of [{ maxPages: 1 }, { maxRows: 1 }, { maxResponseBytes: 20 }]) {
      await assert.rejects(fetchAppleAds({ ...options, definition: { ...definition, limits: { ...definition.limits, ...limits } },
        fetch: async (_url, init) => Response.json(page(JSON.parse(String(init?.body)).pagination.offset)) }), /Apple Ads/);
    }
    for (const status of [401, 429, 503]) {
      await assert.rejects(fetchAppleAds({ ...options, fetch: async () => new Response("synthetic-private-detail", { status }) }),
        { message: `Apple Ads request failed with ${status}` });
    }
  });
});
