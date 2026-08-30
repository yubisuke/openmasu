import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  APPLE_AAK_POSTBACK_PATH,
  APPLE_SKAN_POSTBACK_PATH,
  matchRoute,
  routes,
  SDK_INSTALLATION_PRIVACY_PATH,
} from "./routes.js";

describe("declarative API route security", () => {
  it("C04 keeps cookie and bearer credentials in disjoint namespaces", () => {
    for (const route of routes) {
      if (route.pattern.test("/v1/probe")) assert.notEqual(route.auth, "dashboard_session");
      if (route.pattern.test("/dashboard/probe")) assert.notEqual(route.auth, "admin_bearer");
      if (route.handler.startsWith("dashboard_")) assert.notEqual(route.auth, "admin_bearer");
      if (route.handler !== "max_ingest" && route.pattern.source.startsWith("^\\/v1")) {
        assert.notEqual(route.auth, "dashboard_session");
      }
    }
  });

  it("C04 keeps the dashboard handler group independent of authorization headers", () => {
    const routerSource = readFileSync(new URL("./router.ts", import.meta.url), "utf8");
    const start = routerSource.indexOf('if (route.handler === "dashboard_css")');
    const end = routerSource.indexOf("const identity = await adminIdentity", start);
    assert.ok(start >= 0 && end > start, "dashboard handler group must remain identifiable");
    const dashboardHandlers = routerSource.slice(start, end);
    assert.doesNotMatch(dashboardHandlers, /authorization\s*\(\s*request\s*\)|headers\.authorization/);
  });

  it("C03 declares every read-only route without mutation authority", () => {
    assert.equal(routes.filter((route) => !route.mutates).every((route) => route.method === "GET"), true);
    assert.equal(routes.find((route) => route.handler === "max_ingest")?.mutates, true);
  });

  it("assigns a capability to every administrator or dashboard session route", () => {
    assert.equal(routes.filter((route) => ["admin_bearer", "dashboard_session"].includes(route.auth))
      .every((route) => route.capability !== undefined), true);
  });

  it("matches exact route methods and paths", () => {
    assert.equal(matchRoute("GET", "/v1/reports/metrics")?.handler, "report_metrics");
    assert.equal(matchRoute("POST", "/v1/reports/metrics"), undefined);
    assert.equal(matchRoute("GET", "/dashboard/app.css")?.handler, "dashboard_css");
    assert.equal(matchRoute("GET", "/v1/admin/tracking-links")?.handler, "admin_tracking_links_list");
    assert.equal(matchRoute("POST", "/v1/admin/tracking-links")?.handler, "admin_tracking_links");
    assert.equal(matchRoute("GET", "/dashboard/apps/app-a/tracking-links")?.handler, "dashboard_tracking_links_list");
    assert.equal(matchRoute("GET", "/dashboard/apps/app-a/records")?.handler, "dashboard_records");
    assert.equal(matchRoute("POST", "/dashboard/apps/app-a/tracking-links")?.handler, "dashboard_tracking_links_create");
    assert.equal(matchRoute("POST", APPLE_SKAN_POSTBACK_PATH)?.handler, "apple_skan_postback");
    assert.equal(matchRoute("POST", APPLE_AAK_POSTBACK_PATH)?.handler, "apple_aak_postback");
    assert.equal(matchRoute("GET", "/.well-known/skadnetwork/report-attribution/"), undefined);
    assert.equal(matchRoute("POST", "/.well-known/skadnetwork/report-attribution"), undefined);
    assert.equal(matchRoute("POST", "/v1/admin/apps/app-a/apple-registration")?.handler, "admin_apple_registration");
    assert.equal(matchRoute("POST", "/v1/admin/apps/app-a/conversion-schemas")?.handler, "admin_conversion_schema");
    assert.equal(matchRoute("POST", "/v1/admin/apps/app-a/rule-bundles")?.handler, "admin_rule_bundle");
    assert.equal(matchRoute("GET", "/metrics")?.handler, "operational_metrics");
    assert.equal(matchRoute("POST", "/v1/events/server")?.handler, "server_batch");
    assert.equal(matchRoute("GET", "/v1/events/server"), undefined);
  });

  it("keeps every native SDK deletion transport on the registered canonical route", () => {
    const canonical = matchRoute("POST", SDK_INSTALLATION_PRIVACY_PATH);
    assert.equal(canonical?.handler, "device_privacy");
    assert.equal(canonical?.auth, "sdk_hmac");
    assert.equal(canonical?.mutates, true);
    assert.equal(matchRoute("POST", "/v1/privacy/on-device")?.handler, "device_privacy");
    assert.equal(matchRoute("GET", SDK_INSTALLATION_PRIVACY_PATH), undefined);

    for (const source of [
      "../../../sdk/android/core/src/main/java/dev/openmasu/sdk/HmacHttpTransport.kt",
      "../../../sdk/ios/Sources/OpenMasuCore/Transport.swift",
      "../../../sdk/unity/com.openmasu.sdk/Runtime/Plugins/iOS/Sources/OpenMasuCore/Transport.swift",
    ]) {
      const contents = readFileSync(new URL(source, import.meta.url), "utf8");
      assert.ok(contents.includes(`"${SDK_INSTALLATION_PRIVACY_PATH}"`), source);
    }
  });

  it("WO18 matches exact SDK lifecycle, link-state, and provider form routes", () => {
    assert.equal(matchRoute("GET", "/v1/admin/apps/app-a/sdk-keys")?.handler, "admin_sdk_keys_list");
    assert.equal(matchRoute("POST", "/v1/admin/apps/app-a/sdk-keys")?.handler, "admin_sdk_keys_issue");
    assert.equal(matchRoute("POST", "/v1/admin/apps/app-a/sdk-keys/sdk-key%3Aone/retire")?.handler, "admin_sdk_keys_retire");
    assert.equal(matchRoute("POST", "/v1/admin/apps/app-a/tracking-links/tracking-link%3Aone/pause")?.handler, "admin_tracking_link_transition");
    assert.equal(matchRoute("POST", "/dashboard/apps/app-a/tracking-links/tracking-link%3Aone/archive")?.handler, "dashboard_tracking_link_transition");
    assert.equal(matchRoute("POST", "/dashboard/apps/app-a/sdk-keys")?.handler, "dashboard_sdk_keys_issue");
    assert.equal(matchRoute("POST", "/dashboard/apps/app-a/sdk-keys/sdk-key%3Aone/retire")?.handler, "dashboard_sdk_keys_retire");
    assert.equal(matchRoute("GET", "/v1/admin/apps/app-a/server-keys")?.handler, "admin_server_keys_list");
    assert.equal(matchRoute("POST", "/v1/admin/apps/app-a/server-keys")?.handler, "admin_server_keys_issue");
    assert.equal(matchRoute("POST", "/v1/admin/apps/app-a/server-keys/server-key%3Aone/retire")?.handler, "admin_server_keys_retire");
    assert.equal(matchRoute("POST", "/dashboard/apps/app-a/server-keys")?.handler, "dashboard_server_keys_issue");
    assert.equal(matchRoute("POST", "/dashboard/apps/app-a/server-keys/server-key%3Aone/retire")?.handler, "dashboard_server_keys_retire");
    assert.equal(matchRoute("GET", "/v1/admin/apps/app-a/operator-webhooks")?.handler, "admin_operator_webhooks_list");
    assert.equal(matchRoute("POST", "/v1/admin/apps/app-a/operator-webhooks")?.handler, "admin_operator_webhooks_register");
    assert.equal(matchRoute("POST", "/v1/admin/apps/app-a/operator-webhooks/webhook%3Aone/disable")?.handler, "admin_operator_webhooks_disable");
    assert.equal(matchRoute("POST", "/dashboard/apps/app-a/operator-webhooks")?.handler, "dashboard_operator_webhooks_register");
    assert.equal(matchRoute("POST", "/dashboard/apps/app-a/operator-webhooks/webhook%3Aone/disable")?.handler, "dashboard_operator_webhooks_disable");
    assert.equal(matchRoute("GET", "/v1/admin/apps/app-a/operator-bulk-exports")?.handler, "admin_operator_bulk_exports_list");
    assert.equal(matchRoute("POST", "/v1/admin/apps/app-a/operator-bulk-exports")?.handler, "admin_operator_bulk_exports_register");
    assert.equal(matchRoute("POST", "/v1/admin/apps/app-a/operator-bulk-exports/bulk%3Aone/disable")?.handler, "admin_operator_bulk_exports_disable");
    assert.equal(matchRoute("POST", "/dashboard/apps/app-a/operator-bulk-exports")?.handler, "dashboard_operator_bulk_exports_register");
    assert.equal(matchRoute("POST", "/dashboard/apps/app-a/operator-bulk-exports/bulk%3Aone/disable")?.handler, "dashboard_operator_bulk_exports_disable");
    for (const path of [
      "/dashboard/link-domain",
      "/dashboard/apps/app-a/link-identity",
      "/dashboard/apps/app-a/apple-registration",
      "/dashboard/apps/app-a/conversion-schemas",
      "/dashboard/apps/app-a/rule-bundles",
      "/dashboard/apps/app-a/google-data-manager",
    ]) assert.ok(matchRoute("POST", path));
    assert.equal(matchRoute("GET", "/dashboard/apps/app-a/sdk-keys"), undefined);
    assert.equal(matchRoute("POST", "/dashboard/apps/app-a/sdk-keys/key/retire/extra"), undefined);
  });

  it("WO18 binds key and provider mutations to administer and link states to operate", () => {
    for (const handler of [
      "admin_sdk_keys_list", "admin_sdk_keys_issue", "admin_sdk_keys_retire",
      "dashboard_sdk_keys_issue", "dashboard_sdk_keys_retire", "dashboard_link_domain",
      "admin_server_keys_list", "admin_server_keys_issue", "admin_server_keys_retire",
      "dashboard_server_keys_issue", "dashboard_server_keys_retire",
      "admin_operator_webhooks_list", "admin_operator_webhooks_register", "admin_operator_webhooks_disable",
      "dashboard_operator_webhooks_register", "dashboard_operator_webhooks_disable",
      "admin_operator_bulk_exports_list", "admin_operator_bulk_exports_register", "admin_operator_bulk_exports_disable",
      "dashboard_operator_bulk_exports_register", "dashboard_operator_bulk_exports_disable",
      "dashboard_app_link_identity", "dashboard_apple_registration", "dashboard_conversion_schema",
      "dashboard_rule_bundle", "dashboard_google_data_manager",
    ]) assert.equal(routes.find((route) => route.handler === handler)?.capability, "administer", handler);
    for (const handler of ["admin_tracking_link_transition", "dashboard_tracking_link_transition"]) {
      assert.equal(routes.find((route) => route.handler === handler)?.capability, "operate", handler);
    }
  });
});
