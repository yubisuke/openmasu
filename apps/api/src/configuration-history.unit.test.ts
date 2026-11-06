import assert from "node:assert/strict";
import { it } from "node:test";
import { configurationChange, configurationDifferences, parseConfigurationChange } from "./configuration-change.js";
import { parseConfigurationHistoryQuery, type ConfigurationHistoryRow } from "./configuration-history.js";
import { renderConfigurationHistory } from "./dashboard/configuration-history.js";

it("configuration history accepts only bounded deterministic keyset input", () => {
  const cursor = { occurred_at: "2026-10-01T00:00:00.000Z", audit_log_id: "00000000-0000-4000-8000-000000000001" };
  const params = new URLSearchParams({ limit: "1", after: Buffer.from(JSON.stringify(cursor)).toString("base64url") });
  assert.deepEqual(parseConfigurationHistoryQuery(params), { limit: 1, after: cursor });
  assert.deepEqual(parseConfigurationHistoryQuery(params), parseConfigurationHistoryQuery(params));
  assert.deepEqual(parseConfigurationHistoryQuery(new URLSearchParams()), { limit: 50 });
  for (const raw of ["limit=0", "limit=101", "limit=1.5", "limit=1&limit=2", "after=garbage", "tenant_id=foreign", "offset=10",
    `after=${Buffer.from(JSON.stringify({ ...cursor, occurred_at: "not-a-date" })).toString("base64url")}`]) {
    assert.throws(() => parseConfigurationHistoryQuery(new URLSearchParams(raw)), /configuration_history_query_invalid/);
  }
});

it("configuration receipts reject private fields and distinguish revision-only from field changes", () => {
  const change = configurationChange("webhook_content", "synthetic:1", { mode: "explicit_v1", share_money: false },
    "synthetic:2", { mode: "explicit_v1", share_money: true });
  assert.deepEqual(configurationDifferences(change), [{ field: "share_money", before: false, after: true }]);
  assert.deepEqual(configurationDifferences({ ...change, after: change.before! }), []);
  for (const field of ["endpoint_url", "operating_account_id", "secret", "protected_ref", "custom_events", "constructor"]) {
    assert.equal(parseConfigurationChange({ ...change, after: { [field]: "synthetic-private" } }), null);
  }
  assert.equal(parseConfigurationChange({ ...change, extra: "synthetic-private" }), null);
  assert.throws(() => configurationChange("google_destination", null, null, "synthetic:1", { ready: "synthetic-private" }), /projection_invalid/);
});

it("configuration history renders escaped receipts, explicit unknown and no-op without forms or scripts", () => {
  const row: ConfigurationHistoryRow = { audit_log_id: "synthetic", occurred_at: "2026-10-01T00:00:00.000Z",
    app_id: "synthetic-app", actor_ref: "<script>synthetic</script>", action: "cost_schedule_registered", target_scope: "app",
    target_ref: "synthetic:1", outcome: "succeeded", change_state: "details_not_recorded", change: null };
  const change = configurationChange("cost_schedule", "synthetic:1", { status: "active" }, "synthetic:1", { status: "active" });
  const html = renderConfigurationHistory("synthetic-app", { data: [row, { ...row, change, change_state: "revision_only" },
    { ...row, outcome: "failed", change_state: "failed" }], next_cursor: "synthetic" }, 1);
  assert.match(html, /Field-level details were not recorded/);
  assert.match(html, /no change in the displayed safe fields/);
  assert.match(html, /not a successful configuration change/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /limit=1&amp;after=synthetic/);
  assert.doesNotMatch(html, /<form|<script|javascript:|\son[a-z]+=/i);
});
