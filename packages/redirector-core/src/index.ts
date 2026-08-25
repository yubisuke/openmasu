import { randomBytes } from "node:crypto";
export { classifyClientClass, PUBLIC_BOT_TOKENS, type ClientClass } from "./client-class.js";

export type TrackingLink = {
  tracking_link_id: string;
  tenant_id: string;
  app_id: string;
  slug: string;
  destination_kind: "play_store" | "custom_https";
  destination_url: string;
  play_package_name?: string;
  network?: string;
  site_id?: string;
  campaign_id?: string;
  ad_group_id?: string;
  creative_id?: string;
  deep_link_value?: string;
  deep_link_param_names?: readonly string[];
  deferred_deep_link_ttl_seconds?: number;
  status: "active" | "paused" | "archived";
};

export type RedirectClick = {
  click_id: string;
  tracking_link_id: string;
  tenant_id: string;
  app_id: string;
  destination_url: string;
  referrer: string;
  redirector_click_at: string;
  campaign_id?: string;
  ad_group_id?: string;
  creative_id?: string;
  network?: string;
  site_id?: string;
  remote_click_ref?: string;
  source_rate_class?: "normal" | "elevated" | "saturated";
  client_class?: "mobile_app_eligible" | "bot" | "other";
  bot_prefetch?: true;
  deep_link_value?: string;
  deep_link_params?: Readonly<Record<string, string>>;
  deferred_deep_link_status?: "carried" | "omitted_length" | "omitted_platform" | "not_configured";
};

export type RedirectPrefetch = Omit<RedirectClick, "click_id" | "destination_url" | "referrer"> & {
  bot_prefetch: true;
};

export type RedirectResolution = {
  status: 302;
  headers: Readonly<Record<string, string>>;
  body: "";
  click?: RedirectClick;
  prefetch?: RedirectPrefetch;
};

export function randomSlug(random: (size: number) => Buffer = randomBytes): string {
  return random(9).toString("base64url");
}

export function randomClickId(random: (size: number) => Buffer = randomBytes): string {
  // 33 bytes encode to 44 complete base64url symbols, avoiding a biased tail symbol.
  return random(33).toString("base64url");
}

export function encodeInstallReferrer(clickId: string, extras: Readonly<Record<string, string>> = {}): string {
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(clickId)) throw new Error("click_id_invalid");
  const parameters = new URLSearchParams({ omv: "1", cid: clickId, ...extras });
  return parameters.toString();
}

export function decodeInstallReferrer(value: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(value).entries());
}

export function assertDeepLinkValue(value: string): string {
  const segments = value.split("/").slice(1);
  if (value.length > 256 || segments.some((segment) => segment === "." || segment === "..") ||
      !/^\/(?:[A-Za-z0-9._~-]{1,64})(?:\/[A-Za-z0-9._~-]{1,64}){0,7}$/.test(value)) {
    throw new Error("deep_link_value_invalid");
  }
  return value;
}

export function bindDeepLinkParameters(
  source: URLSearchParams,
  declared: readonly string[],
): { readonly values: Readonly<Record<string, string>>; readonly dropped: number } {
  const allowed = new Set(declared);
  const values: Record<string, string> = {};
  let dropped = 0;
  for (const [name, value] of source) {
    if (!name.startsWith("dlp_") || !allowed.has(name.slice(4)) || !/^[A-Za-z0-9._~-]{1,64}$/.test(value)) {
      dropped += 1;
      continue;
    }
    values[name.slice(4)] = value;
  }
  return { values: Object.freeze(values), dropped };
}

export function buildDeferredReferrer(options: {
  readonly clickId: string;
  readonly deepLinkValue?: string;
  readonly deepLinkParams?: Readonly<Record<string, string>>;
  readonly maximumEncodedCharacters: number;
}): { readonly referrer: string; readonly status: "carried" | "omitted_length" | "not_configured" } {
  const minimal = encodeInstallReferrer(options.clickId);
  if (!options.deepLinkValue) return { referrer: minimal, status: "not_configured" };
  assertDeepLinkValue(options.deepLinkValue);
  const extras: Record<string, string> = { dl: options.deepLinkValue };
  for (const [name, value] of Object.entries(options.deepLinkParams ?? {}).sort(([a], [b]) => a.localeCompare(b, "en"))) {
    extras[`dlp_${name}`] = value;
  }
  const expanded = encodeInstallReferrer(options.clickId, extras);
  if (expanded.length <= options.maximumEncodedCharacters) return { referrer: expanded, status: "carried" };
  return { referrer: minimal, status: "omitted_length" };
}

export function assertAllowedDestination(destination: string, allowedOrigins: readonly string[]): URL {
  let parsed: URL;
  try {
    parsed = new URL(destination);
  } catch {
    throw new Error("destination_invalid");
  }
  if (parsed.username || parsed.password) throw new Error("destination_credentials_forbidden");
  if (parsed.protocol === "market:" && parsed.hostname === "details") return parsed;
  if (parsed.protocol !== "https:") throw new Error("destination_scheme_not_allowed");
  if (parsed.hostname === "play.google.com" && parsed.pathname === "/store/apps/details") return parsed;
  const origins = new Set(allowedOrigins.map((value) => new URL(value).origin));
  if (!origins.has(parsed.origin)) throw new Error("destination_origin_not_allowed");
  return parsed;
}

export function playDestination(link: TrackingLink, clickId: string): string {
  const destination = new URL(link.destination_url);
  if (link.destination_kind === "play_store") {
    if (!link.play_package_name) throw new Error("play_package_name_missing");
    destination.searchParams.set("id", link.play_package_name);
    destination.searchParams.set("referrer", encodeInstallReferrer(clickId));
  }
  return destination.toString();
}

export function fallbackResponse(fallbackDestination: string): RedirectResolution {
  return {
    status: 302,
    headers: Object.freeze({
      "cache-control": "no-store",
      location: fallbackDestination,
      "referrer-policy": "no-referrer",
    }),
    body: "",
  };
}

export function resolveRedirect(options: {
  link?: TrackingLink;
  fallbackDestination: string;
  now: string;
  clickId?: string;
  remoteClickRef?: string;
  sourceRateClass?: RedirectClick["source_rate_class"];
  clientClass?: RedirectClick["client_class"];
  deepLinkParams?: Readonly<Record<string, string>>;
  referrerMaximumEncodedCharacters?: number;
  deepLinkValue?: string;
}): RedirectResolution {
  if (!options.link || options.link.status !== "active") return fallbackResponse(options.fallbackDestination);
  const clickId = options.clickId ?? randomClickId();
  const deferred = buildDeferredReferrer({
    clickId,
    ...((options.deepLinkValue ?? options.link.deep_link_value) ? { deepLinkValue: options.deepLinkValue ?? options.link.deep_link_value } : {}),
    ...(options.deepLinkParams ? { deepLinkParams: options.deepLinkParams } : {}),
    maximumEncodedCharacters: options.referrerMaximumEncodedCharacters ?? 512,
  });
  if (deferred.referrer.length > (options.referrerMaximumEncodedCharacters ?? 512)) throw new Error("referrer_too_long");
  const destinationUrl = new URL(options.link.destination_url);
  if (options.link.destination_kind === "play_store") {
    if (!options.link.play_package_name) throw new Error("play_package_name_missing");
    destinationUrl.searchParams.set("id", options.link.play_package_name);
    destinationUrl.searchParams.set("referrer", deferred.referrer);
  }
  const destination = destinationUrl.toString();
  return {
    status: 302,
    headers: Object.freeze({
      "cache-control": "no-store",
      location: destination,
      "referrer-policy": "no-referrer",
    }),
    body: "",
    click: {
      click_id: clickId,
      tracking_link_id: options.link.tracking_link_id,
      tenant_id: options.link.tenant_id,
      app_id: options.link.app_id,
      destination_url: destination,
      referrer: deferred.referrer,
      redirector_click_at: options.now,
      ...(options.link.campaign_id ? { campaign_id: options.link.campaign_id } : {}),
      ...(options.link.ad_group_id ? { ad_group_id: options.link.ad_group_id } : {}),
      ...(options.link.creative_id ? { creative_id: options.link.creative_id } : {}),
      ...(options.link.network ? { network: options.link.network } : {}),
      ...(options.link.site_id ? { site_id: options.link.site_id } : {}),
      ...(options.remoteClickRef ? { remote_click_ref: options.remoteClickRef } : {}),
      ...(options.sourceRateClass ? { source_rate_class: options.sourceRateClass } : {}),
      ...(options.clientClass ? { client_class: options.clientClass } : {}),
      ...(options.clientClass === "bot" ? { bot_prefetch: true as const } : {}),
      ...((options.deepLinkValue ?? options.link.deep_link_value) ? { deep_link_value: options.deepLinkValue ?? options.link.deep_link_value } : {}),
      ...(options.deepLinkParams && Object.keys(options.deepLinkParams).length ? { deep_link_params: options.deepLinkParams } : {}),
      deferred_deep_link_status: deferred.status,
    },
  };
}

export function prefetchEvidence(options: {
  link: TrackingLink;
  fallbackDestination: string;
  now: string;
  remoteClickRef?: string;
  sourceRateClass?: RedirectClick["source_rate_class"];
  clientClass?: RedirectClick["client_class"];
}): RedirectResolution {
  const fallback = fallbackResponse(options.fallbackDestination);
  return {
    ...fallback,
    prefetch: {
      bot_prefetch: true,
      tracking_link_id: options.link.tracking_link_id,
      tenant_id: options.link.tenant_id,
      app_id: options.link.app_id,
      redirector_click_at: options.now,
      ...(options.link.campaign_id ? { campaign_id: options.link.campaign_id } : {}),
      ...(options.link.ad_group_id ? { ad_group_id: options.link.ad_group_id } : {}),
      ...(options.link.creative_id ? { creative_id: options.link.creative_id } : {}),
      ...(options.link.network ? { network: options.link.network } : {}),
      ...(options.link.site_id ? { site_id: options.link.site_id } : {}),
      ...(options.remoteClickRef ? { remote_click_ref: options.remoteClickRef } : {}),
      ...(options.sourceRateClass ? { source_rate_class: options.sourceRateClass } : {}),
      client_class: options.clientClass ?? "bot",
    },
  };
}
