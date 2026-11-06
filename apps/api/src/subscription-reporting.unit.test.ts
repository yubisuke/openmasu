import assert from "node:assert/strict";
import { it } from "node:test";
import { parseSubscriptionQuery, projectSubscriptions, type SubscriptionEvidence } from "./subscription-reporting.js";
import { renderSubscriptions } from "./dashboard/subscriptions.js";

const query = { date_from: "2026-08-01", date_to: "2026-08-03", watermark_at_most: "2026-08-05T00:00:00.000Z" };
const evidence: SubscriptionEvidence = { kind: "observation", series: "synthetic-private-series", event_key: "synthetic-observation",
  event_kind: "subscription_state_verified", event_at: "2026-08-03T00:00:00.000Z", recorded_at: "2026-08-03T00:00:00.000Z",
  bound: true, state: "subscription_state_canceled", expiry_at: "2026-08-02T00:00:00.000Z" };

it("subscription selection rejects identifying, duplicate, malformed and unbounded filters", () => {
  assert.deepEqual(parseSubscriptionQuery(new URLSearchParams(query)), query);
  for (const params of [new URLSearchParams({ ...query, purchase_token: "synthetic" }), new URLSearchParams({ ...query, date_to: "2026-12-01" }),
    new URLSearchParams({ ...query, date_from: "2026-02-30" }), new URLSearchParams({ ...query, watermark_at_most: "today" }),
    new URLSearchParams(`${new URLSearchParams(query)}&date_from=2026-08-01`)]) assert.throws(() => parseSubscriptionQuery(params));
});

it("subscription projection distinguishes canceled from expired and deduplicates late expiry and verified renewal evidence", () => {
  const canceled = projectSubscriptions([evidence], query);
  assert.equal(canceled.daily[1].observed_expiries, 0);
  const expired = { ...evidence, state: "subscription_state_expired", event_at: "2026-08-04T00:00:00.000Z", event_key: "expiry" };
  const renewal: SubscriptionEvidence = { ...evidence, kind: "renewal", event_key: "verified-record", event_at: "2026-08-01T00:00:00.000Z" };
  const rows = [expired, evidence, renewal, renewal, { ...expired, event_key: "redelivered-expiry" }];
  const result = projectSubscriptions(rows, query);
  assert.deepEqual(result, projectSubscriptions([...rows].reverse(), query));
  assert.equal(result.last_observed_states[0].state, "expired");
  assert.equal(result.daily[1].observed_expiries, 1);
  assert.equal(result.daily[0].verified_renewals, 1);
  assert.equal(projectSubscriptions(rows, { ...query, watermark_at_most: "2026-08-02T00:00:00.000Z" }).daily[1].observed_expiries, 0);
  const corrected = projectSubscriptions([...rows, { ...expired, event_key: "corrected-boundary", requested_at: "2026-08-04T01:00:00.000Z",
    expiry_at: "2026-08-01T01:00:00.000Z" }], query);
  assert.equal(corrected.daily[0].observed_expiries, 1);
  assert.equal(corrected.daily[1].observed_expiries, 0, "a newer boundary replaces rather than adds another expiry for one token series");
  const concurrent = projectSubscriptions([{ ...evidence, event_at: "2026-08-04T02:00:00.000Z", requested_at: "2026-08-03T00:00:00.000Z" },
    { ...expired, requested_at: "2026-08-04T00:00:00.000Z" }], query);
  assert.equal(concurrent.last_observed_states[0].state, "expired", "an older request finishing later must not overwrite a newer request");
});

it("subscription unknown and conflicting observations remain bounded aggregates without series identifiers", () => {
  const report = projectSubscriptions([evidence, { ...evidence, state: "subscription_state_active", event_key: "conflict" },
    { ...evidence, series: "synthetic-ambiguous-token", bound: false, event_key: "unbound" },
    { ...evidence, kind: "notification", bound: false, event_at: "2026-08-01T00:00:00.000Z", event_key: "notification" }], query);
  assert.equal(report.last_observed_states[0].state, "unknown");
  assert.equal(report.unknown_series_observations, 1);
  assert.equal(report.daily[0].unknown_series_signals, 1);
  const html = renderSubscriptions("synthetic-app", report);
  assert.doesNotMatch(JSON.stringify(report) + html, /synthetic-private-series|synthetic-ambiguous-token|event_key|purchase_token|<script|onload=/);
  assert.match(html, /Cancel does not mean expired/);
  assert.throws(() => projectSubscriptions(Array.from({ length: 10001 }, () => evidence), query), /subscription_source_limit/);
});
