import assert from "node:assert/strict";
import { it } from "node:test";
import { applePurchaseEnvironment, parseApplePurchaseIntent } from "./apple-purchase-intents.js";

it("requires explicit operator environment and closed consented purchase preparation fields", () => {
  assert.equal(applePurchaseEnvironment(undefined), undefined);
  assert.equal(applePurchaseEnvironment("off"), undefined);
  assert.equal(applePurchaseEnvironment("Sandbox"), "Sandbox");
  assert.equal(applePurchaseEnvironment("Production"), "Production");
  assert.throws(() => applePurchaseEnvironment("sandbox"), /environment_invalid/);
  const value = { request_id: "DEADBEEF-1111-4111-8111-111111111111", installation_id: "installation:synthetic",
    product_id: "synthetic.product", revenue_measurement_consent: true };
  assert.equal(parseApplePurchaseIntent(value).requestId, value.request_id.toLowerCase());
  for (const patch of [{ environment: "Production" }, { app_account_token: "client-token" }, { amount: 10 },
    { request_id: "" }, { installation_id: "" }, { product_id: "../invalid" }, { revenue_measurement_consent: false }]) {
    assert.throws(() => parseApplePurchaseIntent({ ...value, ...patch }), /purchase_intent_invalid/);
  }
});
