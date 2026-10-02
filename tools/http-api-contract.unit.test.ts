import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { routes } from "../apps/api/src/routes.js";
import { parseMetricQuery, reportTransportKeys } from "../apps/api/src/report-query.js";
import { validateEventPayload } from "../packages/contracts/src/event-validation.js";
import { buildHttpApiContract, serializedHttpApiContract } from "./http-api-contract.js";

it("limited OpenAPI JSON stays generated from route auth, report keys and normative event schemas", () => {
  const document = JSON.parse(readFileSync("docs/api/openapi.json", "utf8"));
  assert.equal(document.openapi, "3.1.1");
  assert.equal(readFileSync("docs/api/openapi.json", "utf8").replaceAll("\r\n", "\n"), serializedHttpApiContract());
  assert.equal(Object.keys(document.paths).length, 4);
  for (const [path, methods] of Object.entries(document.paths) as [string, Record<string, any>][]) {
    for (const [method, operation] of Object.entries(methods)) {
      const route = routes.find((route) => route.method === method.toUpperCase() && route.pattern.test(path));
      assert.ok(route); assert.equal(route.auth, method === "post" ? "server_hmac" : "admin_bearer");
      assert.ok(operation.security.length === 1);
      if (method === "get") assert.deepEqual(new Set(operation.parameters.map((parameter: any) => parameter.name)), reportTransportKeys);
    }
  }
  const example = document.paths["/v1/events/server"].post.requestBody.content["application/json"].example.records[0];
  assert.equal(validateEventPayload(example.event_name, example.payload).valid, true);
  for (const variant of document.components.schemas.ServerRecord.oneOf) {
    const name = variant.properties.event_name.const;
    assert.equal(JSON.parse(readFileSync(`schemas/events/${name.replaceAll("_", "-")}.schema.json`, "utf8")).properties.event_name.const, name);
  }
});
it("documented date, grouping and cursor filters reuse the actual deterministic report parser", () => {
  const document = buildHttpApiContract();
  const parameters = document.paths["/v1/reports/metrics"].get.parameters;
  assert.ok(parameters.find((entry: any) => entry.name === "date_to").description.includes("Exclusive"));
  const selection = new URLSearchParams("app_id=app-synthetic&date_from=2026-08-20&date_to=2026-08-21&limit=1");
  const parse = () => parseMetricQuery({ tenantId: "tenant-synthetic", appId: "app-synthetic", searchParams: selection });
  assert.deepEqual(parse(), parse());
  selection.set("unknown", "value"); assert.throws(parse, /unknown_filter/);
});
