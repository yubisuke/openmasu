export type RouteAuth = "public" | "admin_bearer" | "sdk_hmac" | "server_hmac" | "google_oidc" | "dashboard_session";
export type RouteCapability = "read" | "operate" | "administer";

export type RouteHandler =
  | "health"
  | "operational_metrics"
  | "max_ingest"
  | "report_metrics"
  | "report_records"
  | "audit_differences"
  | "audit_fraud"
  | "sdk_enrollment"
  | "sdk_batch"
  | "server_batch"
  | "device_privacy"
  | "device_dsar"
  | "admin_apps_list"
  | "admin_apps_create"
  | "admin_sdk_keys_list"
  | "admin_sdk_keys_issue"
  | "admin_sdk_keys_retire"
  | "admin_server_keys_list"
  | "admin_server_keys_issue"
  | "admin_server_keys_retire"
  | "admin_operator_webhooks_list"
  | "admin_operator_webhooks_register"
  | "admin_operator_webhooks_disable"
  | "admin_tracking_links_list"
  | "admin_tracking_links"
  | "admin_tracking_link_transition"
  | "admin_link_domain"
  | "admin_app_link_identity"
  | "admin_privacy"
  | "admin_apple_registration"
  | "admin_conversion_schema"
  | "admin_rule_bundle"
  | "admin_google_data_manager"
  | "apple_skan_postback"
  | "apple_aak_postback"
  | "google_play_rtdn"
  | "apple_store_notification"
  | "dashboard_root"
  | "dashboard_css"
  | "dashboard_login"
  | "dashboard_logout"
  | "dashboard_app"
  | "dashboard_export"
  | "dashboard_differences"
  | "dashboard_fraud"
  | "dashboard_tracking_links_list"
  | "dashboard_tracking_links_create"
  | "dashboard_tracking_link_transition"
  | "dashboard_sdk_keys_issue"
  | "dashboard_sdk_keys_retire"
  | "dashboard_server_keys_issue"
  | "dashboard_server_keys_retire"
  | "dashboard_operator_webhooks_register"
  | "dashboard_operator_webhooks_disable"
  | "dashboard_link_domain"
  | "dashboard_app_link_identity"
  | "dashboard_apple_registration"
  | "dashboard_conversion_schema"
  | "dashboard_rule_bundle"
  | "dashboard_google_data_manager"
  | "dashboard_apps_create";

export type RouteDefinition = {
  readonly method: "GET" | "POST";
  readonly pattern: RegExp;
  readonly auth: RouteAuth;
  readonly mutates: boolean;
  readonly handler: RouteHandler;
  readonly capability?: RouteCapability;
};

export const routes: readonly RouteDefinition[] = [
  { handler: "health", method: "GET", pattern: /^\/health$/, auth: "public", mutates: false },
  { handler: "operational_metrics", method: "GET", pattern: /^\/metrics$/, auth: "admin_bearer", mutates: false, capability: "read" },
  { handler: "max_ingest", method: "GET", pattern: /^\/v1\/ingest\/max\/[^/]+$/, auth: "public", mutates: true },
  { handler: "report_metrics", method: "GET", pattern: /^\/v1\/reports\/metrics$/, auth: "admin_bearer", mutates: false, capability: "read" },
  { handler: "report_records", method: "GET", pattern: /^\/v1\/reports\/records$/, auth: "admin_bearer", mutates: false, capability: "read" },
  { handler: "audit_differences", method: "GET", pattern: /^\/v1\/audit\/differences$/, auth: "admin_bearer", mutates: false, capability: "read" },
  { handler: "audit_fraud", method: "GET", pattern: /^\/v1\/audit\/fraud$/, auth: "admin_bearer", mutates: false, capability: "read" },
  { handler: "sdk_enrollment", method: "POST", pattern: /^\/v1\/installations$/, auth: "sdk_hmac", mutates: true },
  { handler: "sdk_batch", method: "POST", pattern: /^\/v1\/events\/batch$/, auth: "sdk_hmac", mutates: true },
  { handler: "server_batch", method: "POST", pattern: /^\/v1\/events\/server$/, auth: "server_hmac", mutates: true },
  { handler: "device_privacy", method: "POST", pattern: /^\/v1\/privacy\/on-device$/, auth: "sdk_hmac", mutates: true },
  { handler: "device_dsar", method: "POST", pattern: /^\/v1\/privacy\/access$/, auth: "sdk_hmac", mutates: true },
  { handler: "apple_skan_postback", method: "POST", pattern: /^\/\.well-known\/skadnetwork\/report-attribution\/$/, auth: "public", mutates: true },
  { handler: "apple_aak_postback", method: "POST", pattern: /^\/\.well-known\/appattribution\/report-attribution\/$/, auth: "public", mutates: true },
  { handler: "google_play_rtdn", method: "POST", pattern: /^\/v1\/google-play\/rtdn$/, auth: "google_oidc", mutates: true },
  { handler: "apple_store_notification", method: "POST", pattern: /^\/v1\/apple\/app-store\/notifications$/, auth: "public", mutates: true },
  { handler: "admin_apps_list", method: "GET", pattern: /^\/v1\/admin\/apps$/, auth: "admin_bearer", mutates: false, capability: "read" },
  { handler: "admin_apps_create", method: "POST", pattern: /^\/v1\/admin\/apps$/, auth: "admin_bearer", mutates: true, capability: "administer" },
  { handler: "admin_sdk_keys_list", method: "GET", pattern: /^\/v1\/admin\/apps\/[^/]+\/sdk-keys$/, auth: "admin_bearer", mutates: false, capability: "administer" },
  { handler: "admin_sdk_keys_issue", method: "POST", pattern: /^\/v1\/admin\/apps\/[^/]+\/sdk-keys$/, auth: "admin_bearer", mutates: true, capability: "administer" },
  { handler: "admin_sdk_keys_retire", method: "POST", pattern: /^\/v1\/admin\/apps\/[^/]+\/sdk-keys\/[^/]+\/retire$/, auth: "admin_bearer", mutates: true, capability: "administer" },
  { handler: "admin_server_keys_list", method: "GET", pattern: /^\/v1\/admin\/apps\/[^/]+\/server-keys$/, auth: "admin_bearer", mutates: false, capability: "administer" },
  { handler: "admin_server_keys_issue", method: "POST", pattern: /^\/v1\/admin\/apps\/[^/]+\/server-keys$/, auth: "admin_bearer", mutates: true, capability: "administer" },
  { handler: "admin_server_keys_retire", method: "POST", pattern: /^\/v1\/admin\/apps\/[^/]+\/server-keys\/[^/]+\/retire$/, auth: "admin_bearer", mutates: true, capability: "administer" },
  { handler: "admin_operator_webhooks_list", method: "GET", pattern: /^\/v1\/admin\/apps\/[^/]+\/operator-webhooks$/, auth: "admin_bearer", mutates: false, capability: "administer" },
  { handler: "admin_operator_webhooks_register", method: "POST", pattern: /^\/v1\/admin\/apps\/[^/]+\/operator-webhooks$/, auth: "admin_bearer", mutates: true, capability: "administer" },
  { handler: "admin_operator_webhooks_disable", method: "POST", pattern: /^\/v1\/admin\/apps\/[^/]+\/operator-webhooks\/[^/]+\/disable$/, auth: "admin_bearer", mutates: true, capability: "administer" },
  { handler: "admin_tracking_links_list", method: "GET", pattern: /^\/v1\/admin\/tracking-links$/, auth: "admin_bearer", mutates: false, capability: "read" },
  { handler: "admin_tracking_links", method: "POST", pattern: /^\/v1\/admin\/tracking-links$/, auth: "admin_bearer", mutates: true, capability: "operate" },
  { handler: "admin_tracking_link_transition", method: "POST", pattern: /^\/v1\/admin\/apps\/[^/]+\/tracking-links\/[^/]+\/(?:pause|archive)$/, auth: "admin_bearer", mutates: true, capability: "operate" },
  { handler: "admin_link_domain", method: "POST", pattern: /^\/v1\/admin\/link-domain$/, auth: "admin_bearer", mutates: true, capability: "administer" },
  { handler: "admin_app_link_identity", method: "POST", pattern: /^\/v1\/admin\/apps\/[^/]+\/link-identity$/, auth: "admin_bearer", mutates: true, capability: "administer" },
  { handler: "admin_privacy", method: "POST", pattern: /^\/v1\/admin\/privacy-requests$/, auth: "admin_bearer", mutates: true, capability: "operate" },
  { handler: "admin_apple_registration", method: "POST", pattern: /^\/v1\/admin\/apps\/[^/]+\/apple-registration$/, auth: "admin_bearer", mutates: true, capability: "administer" },
  { handler: "admin_conversion_schema", method: "POST", pattern: /^\/v1\/admin\/apps\/[^/]+\/conversion-schemas$/, auth: "admin_bearer", mutates: true, capability: "administer" },
  { handler: "admin_rule_bundle", method: "POST", pattern: /^\/v1\/admin\/apps\/[^/]+\/rule-bundles$/, auth: "admin_bearer", mutates: true, capability: "administer" },
  { handler: "admin_google_data_manager", method: "POST", pattern: /^\/v1\/admin\/apps\/[^/]+\/google-data-manager$/, auth: "admin_bearer", mutates: true, capability: "administer" },
  { handler: "dashboard_root", method: "GET", pattern: /^\/dashboard\/?$/, auth: "public", mutates: false },
  { handler: "dashboard_css", method: "GET", pattern: /^\/dashboard\/app\.css$/, auth: "public", mutates: false },
  { handler: "dashboard_login", method: "POST", pattern: /^\/dashboard\/session$/, auth: "public", mutates: true },
  { handler: "dashboard_logout", method: "POST", pattern: /^\/dashboard\/session\/delete$/, auth: "dashboard_session", mutates: true, capability: "read" },
  { handler: "dashboard_export", method: "GET", pattern: /^\/dashboard\/apps\/[^/]+\/cohorts\.csv$/, auth: "dashboard_session", mutates: false, capability: "read" },
  { handler: "dashboard_differences", method: "GET", pattern: /^\/dashboard\/apps\/[^/]+\/differences$/, auth: "dashboard_session", mutates: false, capability: "read" },
  { handler: "dashboard_fraud", method: "GET", pattern: /^\/dashboard\/apps\/[^/]+\/fraud$/, auth: "dashboard_session", mutates: false, capability: "read" },
  { handler: "dashboard_tracking_links_list", method: "GET", pattern: /^\/dashboard\/apps\/[^/]+\/tracking-links$/, auth: "dashboard_session", mutates: false, capability: "read" },
  { handler: "dashboard_tracking_links_create", method: "POST", pattern: /^\/dashboard\/apps\/[^/]+\/tracking-links$/, auth: "dashboard_session", mutates: true, capability: "operate" },
  { handler: "dashboard_tracking_link_transition", method: "POST", pattern: /^\/dashboard\/apps\/[^/]+\/tracking-links\/[^/]+\/(?:pause|archive)$/, auth: "dashboard_session", mutates: true, capability: "operate" },
  { handler: "dashboard_sdk_keys_issue", method: "POST", pattern: /^\/dashboard\/apps\/[^/]+\/sdk-keys$/, auth: "dashboard_session", mutates: true, capability: "administer" },
  { handler: "dashboard_sdk_keys_retire", method: "POST", pattern: /^\/dashboard\/apps\/[^/]+\/sdk-keys\/[^/]+\/retire$/, auth: "dashboard_session", mutates: true, capability: "administer" },
  { handler: "dashboard_server_keys_issue", method: "POST", pattern: /^\/dashboard\/apps\/[^/]+\/server-keys$/, auth: "dashboard_session", mutates: true, capability: "administer" },
  { handler: "dashboard_server_keys_retire", method: "POST", pattern: /^\/dashboard\/apps\/[^/]+\/server-keys\/[^/]+\/retire$/, auth: "dashboard_session", mutates: true, capability: "administer" },
  { handler: "dashboard_operator_webhooks_register", method: "POST", pattern: /^\/dashboard\/apps\/[^/]+\/operator-webhooks$/, auth: "dashboard_session", mutates: true, capability: "administer" },
  { handler: "dashboard_operator_webhooks_disable", method: "POST", pattern: /^\/dashboard\/apps\/[^/]+\/operator-webhooks\/[^/]+\/disable$/, auth: "dashboard_session", mutates: true, capability: "administer" },
  { handler: "dashboard_link_domain", method: "POST", pattern: /^\/dashboard\/link-domain$/, auth: "dashboard_session", mutates: true, capability: "administer" },
  { handler: "dashboard_app_link_identity", method: "POST", pattern: /^\/dashboard\/apps\/[^/]+\/link-identity$/, auth: "dashboard_session", mutates: true, capability: "administer" },
  { handler: "dashboard_apple_registration", method: "POST", pattern: /^\/dashboard\/apps\/[^/]+\/apple-registration$/, auth: "dashboard_session", mutates: true, capability: "administer" },
  { handler: "dashboard_conversion_schema", method: "POST", pattern: /^\/dashboard\/apps\/[^/]+\/conversion-schemas$/, auth: "dashboard_session", mutates: true, capability: "administer" },
  { handler: "dashboard_rule_bundle", method: "POST", pattern: /^\/dashboard\/apps\/[^/]+\/rule-bundles$/, auth: "dashboard_session", mutates: true, capability: "administer" },
  { handler: "dashboard_google_data_manager", method: "POST", pattern: /^\/dashboard\/apps\/[^/]+\/google-data-manager$/, auth: "dashboard_session", mutates: true, capability: "administer" },
  { handler: "dashboard_app", method: "GET", pattern: /^\/dashboard\/apps\/[^/]+$/, auth: "dashboard_session", mutates: false, capability: "read" },
  { handler: "dashboard_apps_create", method: "POST", pattern: /^\/dashboard\/apps$/, auth: "dashboard_session", mutates: true, capability: "administer" },
] as const;

export function matchRoute(method: string | undefined, pathname: string): RouteDefinition | undefined {
  return routes.find((route) => route.method === method && route.pattern.test(pathname));
}
