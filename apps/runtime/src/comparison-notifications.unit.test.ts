import assert from "node:assert/strict";
import { it } from "node:test";
import { comparisonNotificationBody, notificationTransition } from "./comparison-notifications.js";

it("comparison notification transitions deduplicate steady states, coalesce cooldown and distinguish uncertainty from recovery", () => {
  const start = new Date("2026-10-01T00:00:00Z"), later = new Date(start.valueOf()+60_000);
  assert.equal(notificationTransition("within_threshold",null,null,start,60),undefined);
  for (const state of ["threshold_exceeded","missing_input","incomparable","unknown"] as const) {
    assert.equal(notificationTransition(state,null,null,start,60),"attention");
    assert.equal(notificationTransition(state,state,start,later,60),undefined);
    assert.equal(notificationTransition("within_threshold",state,start,start,60),undefined);
    assert.equal(notificationTransition("within_threshold",state,start,later,60),"recovered");
  }
  assert.equal(notificationTransition("incomparable","threshold_exceeded",start,later,60),"attention");
});

it("comparison notification bodies contain only a closed aggregate state and destination-scoped references", () => {
  const input = { deliveryId:"synthetic-delivery",appId:"app-a",comparisonId:"synthetic-private-comparison",
    runId:"a".repeat(64),date:"2026-10-01",state:"missing_input" as const,previous:"threshold_exceeded" as const,
    transition:"attention" as const,now:new Date("2026-10-10T00:00:00Z") };
  const body=comparisonNotificationBody(input,Buffer.from("synthetic-secret".repeat(4)));
  assert.deepEqual(body,comparisonNotificationBody(input,Buffer.from("synthetic-secret".repeat(4))));
  assert.notDeepEqual(body,comparisonNotificationBody(input,Buffer.from("different-secret".repeat(4))));
  const parsed=JSON.parse(body.toString());
  assert.deepEqual(Object.keys(parsed).sort(),["app_id","comparison_ref","delivery_id","emitted_at","previous_state","result_ref","schema","state","target_date","transition"]);
  assert.equal(parsed.state,"missing_input");
  assert.doesNotMatch(body.toString(),/synthetic-private-comparison|value_unscaled|grouping|installation|record_id|raw_payload|synthetic-secret/);
});
