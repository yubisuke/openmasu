import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OperationalMetrics } from "./operational-metrics.js";
import { writeOperationalLog } from "./observability.js";

describe("M5 operational observability", () => {
  it("writes one closed structured record without request values", () => {
    let line = "";
    writeOperationalLog({
      event: "http_request",
      component: "api",
      route: "sdk_batch",
      method: "POST",
      status: 202,
      duration_ms: 12.5,
    }, (value) => { line = value; });
    assert.equal(line.endsWith("\n"), true);
    assert.deepEqual(JSON.parse(line), {
      event: "http_request",
      component: "api",
      route: "sdk_batch",
      method: "POST",
      status: 202,
      duration_ms: 12.5,
    });
    for (const forbidden of ["payload", "authorization", "cookie", "installation_id", "record_id"]) {
      assert.equal(line.includes(forbidden), false);
    }
  });

  it("renders bounded counters and cumulative latency buckets", () => {
    const metrics = new OperationalMetrics();
    metrics.observe("health", "GET", 200, 4);
    metrics.observe("health", "GET", 503, 20);
    const text = metrics.renderProcessMetrics().join("\n");
    assert.match(text, /route="health",method="GET",status_class="2xx"} 1/);
    assert.match(text, /route="health",method="GET",status_class="5xx"} 1/);
    assert.match(text, /route="health",method="GET",le="\+Inf"} 2/);
  });

  if (false) {
    // @ts-expect-error Payload values are not accepted by the structured logger.
    writeOperationalLog({ event: "http_request", component: "api", route: "health", method: "GET", status: 200, duration_ms: 1, payload: "secret" }, () => {});
  }
});
