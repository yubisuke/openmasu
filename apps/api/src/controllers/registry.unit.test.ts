import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import type { PayloadStore } from "@openmasu/runtime";
import { createRequestHandler, type RequestHandlerDependencies } from "../router.js";
import { routePool } from "../http-security.js";
import { dashboardCss } from "../dashboard/css.js";
import { createRequestDecoder } from "../http-responses.js";
import { routes } from "../routes.js";
import { assertHandlerRegistry, createHandlerRegistry } from "./registry.js";

// No HTTP server or database is started. Any accidental database access fails.
const noDatabase = () => ({ connect() { throw new Error("unexpected_database_access"); } }) as unknown as Pool;
const dependencies: RequestHandlerDependencies = {
  pool: noDatabase(), readerPool: noDatabase(), payloadStore: {} as PayloadStore,
  maxConfig: { tenantId: "tenant-synthetic", appId: "app-synthetic", pathSecret: "synthetic-path",
    eventKey: "synthetic-key", tokenMode: "all_with_event_fallback", maxParameters: 40, maxQueryBytes: 8192 },
  publicBaseUrl: "http://localhost:8080", redirectorBaseUrl: "http://localhost:8090",
  dashboard: { enabled: true, publicBaseUrl: "http://localhost:8080", tenantId: "tenant-synthetic", sessionTtlSeconds: 43200 },
};

function request(path: string, headers: IncomingMessage["headers"] = {}): IncomingMessage {
  return Object.assign(Readable.from([]), { url: path, method: "GET", headers, socket: {} }) as IncomingMessage;
}

function response() {
  let resolve!: () => void;
  const completed = new Promise<void>(done => { resolve = done; });
  const output = {
    statusCode: 200, headersSent: false, headers: {} as Record<string, unknown>, body: "",
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      this.statusCode = status; this.headersSent = true; this.headers = headers; return this;
    },
    end(body = "") { this.body = String(body); resolve(); return this; },
  };
  return { output, completed, http: output as unknown as ServerResponse };
}

describe("HTTP controller composition", () => {
  it("handler_registry_is_exhaustive", () => {
    const registry = createHandlerRegistry(dependencies);
    assert.deepEqual(Object.keys(registry).sort(), [...new Set(routes.map(route => route.handler))].sort());
    const { report_records: omitted, ...missing } = registry;
    assert.ok(omitted);
    assert.throws(() => assertHandlerRegistry(missing), /route_handler_missing:report_records/);
    assert.throws(() => assertHandlerRegistry({ ...registry, admin_apps_list: registry.health }),
      /route_security_boundary_mismatch:admin_apps_list/);
    assert.throws(() => assertHandlerRegistry({ ...registry, dashboard_app: registry.dashboard_apps_create }),
      /route_security_boundary_mismatch:dashboard_app/);
    assert.equal(routes.filter(route => route.handler === "device_privacy").length, 2);
    assert.equal(registry.device_privacy.boundary, "receiver");
  });

  it("route_security_boundary_preserved", async () => {
    for (const route of routes) assert.equal(routePool(dependencies, route), route.mutates ? dependencies.pool : dependencies.readerPool);
    const handler = createRequestHandler(dependencies);
    for (const entry of [
      { path: "/v1/admin/apps", headers: { cookie: `openmasu_dashboard=${"A".repeat(43)}` }, status: 401, expected: /unauthorized/ },
      { path: "/dashboard/apps/app-synthetic", headers: { authorization: "Bearer synthetic-admin-key" }, status: 401, expected: /Authentication required/ },
      { path: "/dashboard", headers: { authorization: "Bearer synthetic-admin-key" }, status: 200, expected: /Admin key/ },
    ]) {
      const reply = response(); handler(request(entry.path, entry.headers), reply.http);
      await reply.completed;
      assert.equal(reply.output.statusCode, entry.status, entry.path);
      assert.match(reply.output.body, entry.expected);
    }
  });

  it("accepts a synthetic controller context without starting an HTTP server", async () => {
    const registry = createHandlerRegistry(dependencies);
    const css = registry.dashboard_css, health = registry.health;
    assert.equal(css.boundary, "session"); assert.equal(health.boundary, "receiver");
    if (css.boundary !== "session" || health.boundary !== "receiver") throw new Error("invalid_boundary");
    for (const [controller, path, expected] of [[css, "/dashboard/app.css", dashboardCss], [health, "/health", '{"status":"ok"}\n']] as const) {
      const reply = response(), route = routes.find(route => route.handler === (path === "/health" ? "health" : "dashboard_css"))!;
      const incoming = request(path);
      await controller.handle({ request: incoming, response: reply.http, target: new URL(path, "http://localhost:8080"),
        route, pool: dependencies.readerPool, startedAt: 0, decoder: createRequestDecoder(incoming) });
      assert.equal(reply.output.statusCode, 200); assert.equal(reply.output.body, expected);
    }
    const decoder = createRequestDecoder(Readable.from([Buffer.alloc(32 * 1024 + 1)] as Buffer[]) as IncomingMessage);
    assert.equal(decoder.maximumBytes, 32 * 1024);
    await assert.rejects(decoder.json(), /request_too_large/);
  });
});
