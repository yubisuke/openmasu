import { randomBytes } from "node:crypto";

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
};

export type RedirectResolution = {
  status: 302;
  headers: Readonly<Record<string, string>>;
  body: "";
  click?: RedirectClick;
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
}): RedirectResolution {
  if (!options.link || options.link.status !== "active") return fallbackResponse(options.fallbackDestination);
  const clickId = options.clickId ?? randomClickId();
  const referrer = encodeInstallReferrer(clickId);
  if (Buffer.byteLength(referrer, "utf8") >= 64) throw new Error("referrer_too_long");
  const destination = playDestination(options.link, clickId);
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
      referrer,
      redirector_click_at: options.now,
      ...(options.link.campaign_id ? { campaign_id: options.link.campaign_id } : {}),
      ...(options.link.ad_group_id ? { ad_group_id: options.link.ad_group_id } : {}),
      ...(options.link.creative_id ? { creative_id: options.link.creative_id } : {}),
    },
  };
}
