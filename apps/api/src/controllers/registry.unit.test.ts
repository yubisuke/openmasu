import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import type { Pool } from "pg";
import type { PayloadStore } from "@openmasu/runtime";
import { InboxCapacityError } from "@openmasu/runtime";
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
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    writeHead(status: number, headers: Record<string, unknown> = {}) {
      this.statusCode = status; this.headersSent = true; this.headers = { ...this.headers, ...headers }; return this;
    },
    end(body = "") { this.body = String(body); resolve(); return this; },
  };
  return { output, completed, http: output as unknown as ServerResponse };
}

describe("HTTP controller composition", () => {
  it("returns typed inbox capacity refusals with Retry-After and no internal error", async () => {
    for (const reason of ["inbox_app_capacity", "inbox_global_capacity", "inbox_capacity_unknown"] as const) {
      const handler = createRequestHandler({ ...dependencies, adminBucket: {
        allow() { throw new InboxCapacityError(reason, 19); },
      } as unknown as NonNullable<RequestHandlerDependencies["adminBucket"]> });
      const reply = response(); handler(request("/v1/admin/apps"), reply.http); await reply.completed;
      assert.equal(reply.output.statusCode, reason === "inbox_app_capacity" ? 429 : 503);
      assert.equal(reply.output.headers["retry-after"], "19");
      assert.deepEqual(JSON.parse(reply.output.body), { error: reason });
    }
  });
  it("separates live and ready without business queries or internal error disclosure", async () => {
    for (const state of [true, false, new Error("postgresql://private-secret@internal-db")]) {
      const handler = createRequestHandler({ ...dependencies, readiness: async () => {
        if (state instanceof Error) throw state;
        return state;
      } });
      for (const path of ["/health", "/ready"]) {
        const reply = response(); handler(request(path), reply.http); await reply.completed;
        assert.equal(reply.output.statusCode, path === "/health" || state === true ? 200 : 503);
        assert.doesNotMatch(reply.output.body, /private|postgres|internal/);
        if (path === "/ready") assert.equal(reply.output.headers["cache-control"], "no-store");
      }
    }
  });
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
      { path: "/v1/admin/apps/app-synthetic/privacy-jobs", headers: { cookie: `openmasu_dashboard=${"A".repeat(43)}` }, status: 401, expected: /unauthorized/ },
      { path: "/v1/admin/apps/app-synthetic/privacy-jobs/request-synthetic", headers: {}, status: 401, expected: /unauthorized/ },
      { path: "/dashboard/apps/app-synthetic/privacy-jobs", headers: { authorization: "Bearer synthetic-admin-key" }, status: 401, expected: /Authentication required/ },
      { path: "/dashboard/apps/app-synthetic/privacy-jobs/request-synthetic", headers: {}, status: 401, expected: /Authentication required/ },
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
